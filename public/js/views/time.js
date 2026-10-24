import { get, put, post } from '../api.js';
import { h, fmtHours, parseHours, fmtShort, fmtDow, fmtDate, addDays, isoWeek, isWeekend, toast, openDialog, add, setKids } from '../dom.js';
import { state, isAdmin, refreshApprovalCount } from '../state.js';

const rowOfTarget = (t) => ({
  key: `a${t.activity_id}`,
  kind: 'activity',
  activity_id: t.activity_id,
  customer: t.customer_name,
  title: `${t.code} ${t.project_name}`,
  sub: t.activity_name,
  billable: !!t.billable && t.billing_type !== 'internal',
});

const rowOfAbsence = (a) => ({
  key: `f${a.id}`,
  kind: 'absence',
  absence_type_id: a.id,
  customer: 'Frånvaro',
  title: a.name,
  sub: '',
  billable: false,
});

const rowOfEntry = (e) =>
  e.activity_id
    ? rowOfTarget({
        activity_id: e.activity_id,
        customer_name: e.customer_name,
        code: e.project_code,
        project_name: e.project_name,
        activity_name: e.activity_name,
        billable: e.activity_billable,
      })
    : rowOfAbsence({ id: e.absence_type_id, name: e.absence_name });

export async function renderTime(root, params) {
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : '';
  const [targets, first] = await Promise.all([get('/api/my/targets'), get(`/api/time/week${requested ? `?start=${requested}` : ''}`)]);
  const data = first;
  setKids(root, );
  const normMinutes = Math.round(data.user.weekly_hours * 60);

  const entries = new Map(); // "radnyckel|datum" → post
  const rowsByKey = new Map();
  for (const e of data.entries) {
    const row = rowOfEntry(e);
    rowsByKey.set(row.key, row);
    entries.set(`${row.key}|${e.work_date}`, e);
  }

  const cells = new Map(); // "radnyckel|datum" → { input, noteBtn }
  const rowTotals = new Map();
  const dayTotals = new Map();
  const tbody = h('tbody');
  const emptyHint = h('div', { class: 'empty hidden' }, 'Inga rader ännu. Lägg till en aktivitet eller frånvaro nedan.');
  const grandTotal = h('td', { class: 'total' });
  const weekLabel = h('div', { class: 'week-title' });
  const summary = h('div', { class: 'muted' });
  const bar = h('span');
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': normMinutes }, bar);
  const submitBtn = h('button', { class: 'btn primary', type: 'button' }, 'Skicka in veckan');
  const recallBtn = h('button', { class: 'btn', type: 'button' }, 'Ta tillbaka');
  const statusBox = h('div');

  const isLocked = (row, date, entry) => {
    if (entry && (['submitted', 'approved'].includes(entry.status) || entry.invoice_id)) return 'Tiden är inskickad eller godkänd och kan inte ändras.';
    if (data.locked_until && date <= data.locked_until && !isAdmin()) return `Perioden är låst till och med ${data.locked_until}.`;
    if (row.kind === 'activity' && date > data.today) return 'Du kan inte rapportera projekttid framåt i tiden.';
    return '';
  };

  function syncCell(row, date) {
    const k = `${row.key}|${date}`;
    const cell = cells.get(k);
    const entry = entries.get(k);
    const lock = isLocked(row, date, entry);
    cell.input.value = fmtHours(entry?.minutes);
    cell.input.disabled = !!lock;
    cell.input.title = lock || (entry?.status === 'rejected' ? `Avslagen: ${entry.reject_note}` : '');
    cell.input.className = `cell ${entry && entry.status !== 'open' ? `st-${entry.status}` : ''}`;
    cell.noteBtn.classList.toggle('hidden', !entry);
    cell.noteBtn.classList.toggle('has-note', !!entry?.note);
    cell.noteBtn.title = entry?.note ? `Anteckning: ${entry.note}` : 'Lägg till anteckning';
  }

  function minutesAt(key, date) {
    return entries.get(`${key}|${date}`)?.minutes ?? 0;
  }

  function syncTotals() {
    let total = 0;
    for (const [key] of rowsByKey) {
      const sum = data.days.reduce((s, d) => s + minutesAt(key, d), 0);
      rowTotals.get(key).textContent = fmtHours(sum);
      total += sum;
    }
    for (const d of data.days) {
      let sum = 0;
      for (const [key] of rowsByKey) sum += minutesAt(key, d);
      dayTotals.get(d).textContent = fmtHours(sum);
    }
    grandTotal.textContent = fmtHours(total);
    const pct = normMinutes ? Math.min(100, Math.round((total / normMinutes) * 100)) : 0;
    bar.style.width = `${pct}%`;
    progress.classList.toggle('over', normMinutes > 0 && total >= normMinutes);
    progress.setAttribute('aria-valuenow', total);
    summary.textContent = `Rapporterat ${fmtHours(total) || '0'} av ${fmtHours(normMinutes) || '0'} h`;

    const list = [...entries.values()];
    const count = (...s) => list.filter((e) => s.includes(e.status)).length;
    const open = count('open', 'rejected');
    const submitted = count('submitted');
    const rejected = count('rejected');
    submitBtn.disabled = open === 0;
    recallBtn.classList.toggle('hidden', submitted === 0);
    setKids(statusBox, 
      ...[
        rejected ? h('span', { class: 'chip rejected' }, `${rejected} avslagna – rätta och skicka in igen`) : null,
        submitted ? h('span', { class: 'chip submitted' }, `${submitted} väntar på attest`) : null,
        count('approved') ? h('span', { class: 'chip approved' }, `${count('approved')} godkända`) : null,
      ].filter(Boolean),
    );
  }

  async function saveEntry(row, date, minutes, note) {
    const body = { date, minutes, ...(row.kind === 'activity' ? { activity_id: row.activity_id } : { absence_type_id: row.absence_type_id }) };
    if (note !== undefined) body.note = note;
    const res = await put('/api/time/entries', body);
    const k = `${row.key}|${date}`;
    if (res.deleted) entries.delete(k);
    else entries.set(k, res);
    syncCell(row, date);
    syncTotals();
  }

  function editNote(row, date) {
    const entry = entries.get(`${row.key}|${date}`);
    if (!entry) return;
    const lock = isLocked(row, date, entry);
    const area = h('textarea', { id: 'note', maxlength: 500, disabled: !!lock, value: entry.note });
    const error = h('div', { class: 'alert error hidden' });
    const save = h('button', { class: 'btn primary', type: 'button', disabled: !!lock }, 'Spara');
    const { close } = openDialog({
      title: `Anteckning · ${row.title}${row.sub ? ` › ${row.sub}` : ''} · ${fmtShort(date)}`,
      content: [error, lock ? h('p', { class: 'muted' }, lock) : null, h('div', { class: 'field' }, h('label', { for: 'note' }, 'Anteckning'), area)],
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Stäng'), save],
    });
    area.focus();
    save.addEventListener('click', async () => {
      try {
        await saveEntry(row, date, entry.minutes, area.value.trim());
        close();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      }
    });
  }

  function buildCell(row, date) {
    const k = `${row.key}|${date}`;
    const input = h('input', {
      class: 'cell',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      'aria-label': `${row.title} ${row.sub} ${fmtDow(date)} ${fmtShort(date)}`,
    });
    const noteBtn = h('button', { class: 'note-btn hidden', type: 'button', 'aria-label': 'Anteckning', onclick: () => editNote(row, date) }, '✎');
    cells.set(k, { input, noteBtn });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', async () => {
      const minutes = parseHours(input.value);
      const prev = entries.get(k)?.minutes ?? 0;
      input.classList.remove('invalid');
      if (minutes === null) {
        input.classList.add('invalid');
        toast('Ogiltig tid. Skriv till exempel 7,5 eller 7:30.', 'error');
        input.value = fmtHours(prev);
        return;
      }
      if (minutes === prev) {
        input.value = fmtHours(prev);
        return;
      }
      try {
        await saveEntry(row, date, minutes);
      } catch (err) {
        toast(err.message, 'error');
        syncCell(row, date);
      }
    });
    return h('div', { class: 'cell-wrap' }, input, noteBtn);
  }

  function buildRow(row) {
    const totalCell = h('td', { class: 'total' });
    rowTotals.set(row.key, totalCell);
    const tr = h(
      'tr',
      { dataset: { row: row.key } },
      h(
        'td',
        { class: 'label' },
        h('div', { class: 'row-customer' }, row.customer),
        h('div', { class: 'row-title' }, row.title),
        row.sub ? h('div', { class: 'small' }, row.sub, ' ', row.billable ? h('span', { class: 'chip accent' }, 'Debiterbar') : null) : null,
      ),
      data.days.map((d) => h('td', { class: isWeekend(d) ? 'weekend' : '' }, buildCell(row, d))),
      totalCell,
    );
    return tr;
  }

  function sortedRows() {
    return [...rowsByKey.values()].sort(
      (a, b) => (a.kind === b.kind ? 0 : a.kind === 'activity' ? -1 : 1) || a.customer.localeCompare(b.customer, 'sv') || a.title.localeCompare(b.title, 'sv') || a.sub.localeCompare(b.sub, 'sv'),
    );
  }

  function renderRows() {
    setKids(tbody, );
    cells.clear();
    rowTotals.clear();
    const rows = sortedRows();
    emptyHint.classList.toggle('hidden', rows.length > 0);
    for (const row of rows) add(tbody, buildRow(row));
    for (const row of rows) for (const d of data.days) syncCell(row, d);
    syncTotals();
  }

  function addRow(row) {
    if (rowsByKey.has(row.key)) return;
    rowsByKey.set(row.key, row);
    renderRows();
    const first = tbody.querySelector(`tr[data-row="${row.key}"] input.cell:not(:disabled)`);
    first?.focus();
  }

  // Väljare för att lägga till rader, grupperad per kund och projekt.
  const picker = h('select', { id: 'add-row', 'aria-label': 'Lägg till rad' });
  function fillPicker() {
    setKids(picker, h('option', { value: '' }, '+ Lägg till rad …'));
    const groups = new Map();
    for (const t of targets.activities) {
      const key = `${t.customer_name} › ${t.code} ${t.project_name}`;
      if (!groups.has(key)) groups.set(key, []);
      if (!rowsByKey.has(`a${t.activity_id}`)) groups.get(key).push(h('option', { value: `a${t.activity_id}` }, t.activity_name));
    }
    for (const [label, opts] of groups) if (opts.length) add(picker, h('optgroup', { label }, opts));
    const abs = targets.absences.filter((a) => !rowsByKey.has(`f${a.id}`));
    if (abs.length) add(picker, h('optgroup', { label: 'Frånvaro' }, abs.map((a) => h('option', { value: `f${a.id}` }, a.name))));
  }
  fillPicker();
  picker.addEventListener('change', () => {
    const v = picker.value;
    if (!v) return;
    const row = v.startsWith('a')
      ? rowOfTarget(targets.activities.find((t) => `a${t.activity_id}` === v))
      : rowOfAbsence(targets.absences.find((a) => `f${a.id}` === v));
    addRow(row);
    fillPicker();
  });

  const copyBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        const prev = await get(`/api/time/week?start=${addDays(data.week_start, -7)}`);
        let added = 0;
        for (const e of prev.entries) {
          const row = rowOfEntry(e);
          const valid = row.kind === 'absence' ? targets.absences.some((a) => `f${a.id}` === row.key) : targets.activities.some((t) => `a${t.activity_id}` === row.key);
          if (valid && !rowsByKey.has(row.key)) {
            rowsByKey.set(row.key, row);
            added++;
          }
        }
        renderRows();
        fillPicker();
        toast(added ? `${added} rader kopierade från förra veckan.` : 'Inga nya rader att kopiera.');
      },
    },
    'Kopiera förra veckans rader',
  );

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    try {
      const r = await post('/api/time/submit', { week_start: data.week_start });
      toast(`${r.submitted} rader inskickade för attest.`, 'ok');
      refreshApprovalCount();
      await renderTime(root, [data.week_start]);
    } catch (err) {
      toast(err.message, 'error');
      submitBtn.disabled = false;
    }
  });
  recallBtn.addEventListener('click', async () => {
    try {
      await post('/api/time/recall', { week_start: data.week_start });
      refreshApprovalCount();
      await renderTime(root, [data.week_start]);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const nav = (to) => () => {
    location.hash = to;
  };
  const isCurrentWeek = data.days.includes(data.today);
  weekLabel.textContent = `Vecka ${isoWeek(data.week_start)} · ${fmtShort(data.days[0])} – ${fmtDate(data.days[6])}`;

  const head = h(
    'tr',
    {},
    h('th', { class: 'label' }, 'Projekt / aktivitet'),
    data.days.map((d) => h('th', { class: d === data.today ? 'today' : '' }, h('div', { class: 'dow' }, fmtDow(d)), h('div', {}, fmtShort(d)))),
    h('th', { class: 'total' }, 'Summa'),
  );
  const foot = h(
    'tr',
    {},
    h('td', { class: 'label' }, 'Summa'),
    data.days.map((d) => {
      const td = h('td');
      dayTotals.set(d, td);
      return td;
    }),
    grandTotal,
  );

  add(root, 
    h('h1', {}, 'Tidrapportering'),
    h(
      'div',
      { class: 'week-head' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Föregående vecka', onclick: nav(`#/tid/${addDays(data.week_start, -7)}`) }, '◀'),
      weekLabel,
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Nästa vecka', onclick: nav(`#/tid/${addDays(data.week_start, 7)}`) }, '▶'),
      h('button', { class: 'btn', type: 'button', disabled: isCurrentWeek, onclick: nav('#/tid') }, 'Idag'),
      h('span', { class: 'spacer' }),
      statusBox,
    ),
    h(
      'div',
      { class: 'card flush' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', {}, head), tbody, h('tfoot', {}, foot))),
      emptyHint,
      h('div', { class: 'week-foot' }, picker, copyBtn),
      h('div', { class: 'week-foot' }, summary, progress, h('span', { class: 'spacer' }), recallBtn, submitBtn),
    ),
    data.locked_until ? h('p', { class: 'muted small' }, `Perioder till och med ${data.locked_until} är låsta.`) : null,
    h('p', { class: 'muted small' }, 'Skriv tid som 7,5 eller 7:30. Ändringar sparas direkt. Skicka in veckan när du är klar. ✎ lägger till en anteckning.'),
  );
  renderRows();
}
