import { get, post, del, qs } from '../api.js';
import { h, add, setKids, fmtMoney, fmtNum, fmtDate, fmtMonth, toast, editDialog, openDialog, confirmDialog, promptDialog, dataTable, localToday } from '../dom.js';

const KIND_LABEL = { time: 'Tid', expense: 'Utlägg', mileage: 'Körning' };

function subnav(active) {
  return h(
    'div',
    { class: 'subnav' },
    h('a', { href: '#/fakturering', 'aria-current': active === 'att' ? 'page' : null }, 'Att fakturera'),
    h('a', { href: '#/fakturering/underlag', 'aria-current': active === 'underlag' ? 'page' : null }, 'Skapade underlag'),
  );
}

const kpi = (label, value, extra) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), extra);

// ── Att fakturera: alla projekt med något som väntar ───────────────────
async function overview(root) {
  const data = await get('/api/reports/accrued?group_by=project');
  const t = data.total;
  const waiting = round(t.time_unapproved + t.other_unapproved);
  add(
    root,
    h('h1', {}, 'Fakturering'),
    subnav('att'),
    h(
      'div',
      { class: 'kpis' },
      kpi('Godkänt, redo att fakturera', fmtMoney(t.total_approved)),
      kpi('Väntar på attest eller inskick', fmtMoney(waiting)),
      kpi('Fastpris, timmar utan faktura', fmtNum(t.fixed_hours)),
    ),
    h(
      'div',
      { class: 'card flush' },
      dataTable({
        rows: [...data.rows].sort((a, b) => (a.oldest || '').localeCompare(b.oldest || '')),
        empty: 'Allt är fakturerat. Inget ligger och väntar.',
        columns: [
          { label: 'Projekt', render: (r) => [h('a', { href: `#/fakturering/projekt/${r.key}` }, r.label), r.billing_type === 'fixed' ? h('span', { class: 'chip' }, ' fast pris') : null] },
          { label: 'Kund', render: (r) => h('a', { href: `#/fakturering/kund/${r.customer_id}` }, r.customer_name) },
          { label: 'Äldsta ofakturerade', render: (r) => fmtDate(r.oldest), class: 'nowrap' },
          { label: 'Godkänt', num: true, render: (r) => (r.total_approved ? h('strong', {}, fmtMoney(r.total_approved)) : '') },
          { label: 'Väntar på attest', num: true, render: (r) => (r.time_unapproved + r.other_unapproved ? fmtMoney(round(r.time_unapproved + r.other_unapproved)) : '') },
          { label: 'Fastpris (tim)', num: true, render: (r) => (r.fixed_hours ? fmtNum(r.fixed_hours) : '') },
          { label: '', class: 'actions', render: (r) => h('a', { class: 'btn sm primary', href: `#/fakturering/projekt/${r.key}` }, 'Öppna') },
        ],
        footer: (c, i) => [`Summa`, '', '', fmtMoney(t.total_approved), fmtMoney(waiting), fmtNum(t.fixed_hours), ''][i],
      }),
    ),
    h('p', { class: 'muted small' }, 'Här ligger allt som ännu inte fakturerats eller avskrivits, så att inget glöms bort. Öppna ett projekt för att välja vad som ska med på nästa fakturaunderlag.'),
  );
}

const round = (n) => Math.round(n * 100) / 100;

// ── Projekt- eller kundvy med radval ───────────────────────────────────
async function workbench(root, scope, id) {
  const filter = { from: '', to: '', show: 'open' };
  const selected = new Set();
  let data;
  let byKey = new Map();
  const tiles = h('div', { class: 'kpis' });
  const title = h('div');
  const table = h('div', { class: 'card flush' });
  const bar = h('div', { class: 'sticky-actions' });

  const key = (i) => `${i.kind}:${i.id}`;
  const idParam = scope === 'projekt' ? 'project_id' : 'customer_id';

  async function load() {
    data = await get(`/api/billing/items${qs({ [idParam]: id, ...filter })}`);
    byKey = new Map(data.items.map((i) => [key(i), i]));
    for (const k of [...selected]) if (!byKey.has(k)) selected.delete(k);
    draw();
  }

  const picked = () => [...selected].map((k) => byKey.get(k));
  const idsOf = (rows) => ({
    time_ids: rows.filter((r) => r.kind === 'time').map((r) => r.id),
    expense_ids: rows.filter((r) => r.kind === 'expense').map((r) => r.id),
    mileage_ids: rows.filter((r) => r.kind === 'mileage').map((r) => r.id),
  });

  function drawHeader() {
    const m = data.meta;
    const s = data.summary;
    setKids(
      title,
      h(
        'div',
        { class: 'row between' },
        h(
          'div',
          {},
          h('h1', {}, scope === 'projekt' ? `${m.code} ${m.name}` : m.customer_name),
          h(
            'p',
            { class: 'muted' },
            scope === 'projekt' ? [`${m.customer_name} · `, { hourly: 'Löpande räkning', fixed: 'Fast pris', internal: 'Internt' }[m.billing_type], ' · ', h('a', { href: `#/fakturering/kund/${m.customer_id}` }, 'Visa hela kunden')] : 'Alla projekt för kunden',
          ),
        ),
        h('a', { class: 'btn', href: '#/fakturering' }, '← Att fakturera'),
      ),
    );
    const budgetHours = m.budget_hours ? s.hours / m.budget_hours : null;
    setKids(
      tiles,
      kpi('Rapporterat', `${fmtNum(s.hours)} h`, h('div', { class: 'small muted' }, `varav ${fmtNum(s.billable_hours)} h debiterbara`)),
      kpi('Godkänt, redo att fakturera', fmtMoney(s.open_approved)),
      kpi('Väntar på attest', fmtMoney(s.open_unapproved)),
      kpi('Fakturerat', fmtMoney(s.invoiced)),
      s.waived ? kpi('Avskrivet', fmtMoney(s.waived)) : null,
      budgetHours !== null
        ? kpi('Budget (timmar)', `${Math.round(budgetHours * 100)} %`, h('div', { class: `budget ${budgetHours > 1 ? 'over' : ''}` }, h('span', { style: null })))
        : null,
    );
    const fill = tiles.querySelector('.budget span');
    if (fill) fill.style.width = `${Math.min(100, Math.round(budgetHours * 100))}%`;
  }

  function statusChip(i) {
    if (i.selectable) return h('span', { class: 'chip ready' }, 'Att fakturera');
    if (i.invoice_number) return h('span', { class: 'chip approved', title: `Fakturadatum ${i.invoice_date}` }, `Fakturerad ${i.invoice_number}`);
    if (i.reason === 'Avskriven') return h('span', { class: 'chip', title: i.waived_note }, 'Avskriven');
    const cls = i.reason === 'Väntar på attest' ? 'submitted' : i.reason === 'Avslagen' ? 'rejected' : 'warn';
    return h('span', { class: `chip ${cls}` }, i.reason);
  }

  const rowChecks = new Map();
  const groupChecks = [];

  function draw() {
    drawHeader();
    rowChecks.clear();
    groupChecks.length = 0;
    if (!data.items.length) {
      setKids(table, h('div', { class: 'empty' }, filter.show === 'open' ? 'Inget ofakturerat i den här vyn. 🎉' : 'Inga rader för urvalet.'));
      drawBar();
      return;
    }
    const customerScope = scope === 'kund';
    const tbody = h('tbody');
    const months = new Map();
    for (const i of data.items) {
      const m = i.date.slice(0, 7);
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(i);
    }
    for (const [month, rows] of months) {
      // Månadsrutan väljer det som går att fakturera. Finns inget sådant väljer den resten (för avskrivning).
      const ready = rows.filter((r) => r.selectable);
      const usable = ready.length ? ready : rows.filter((r) => !r.invoice_id);
      const all = h('input', {
        type: 'checkbox',
        'aria-label': `Markera alla i ${fmtMonth(month)}`,
        disabled: !usable.length,
        onchange: (e) => {
          for (const r of usable) e.target.checked ? selected.add(key(r)) : selected.delete(key(r));
          sync();
        },
      });
      groupChecks.push({ box: all, rows: usable });
      add(
        tbody,
        h(
          'tr',
          { class: 'group-row' },
          h('td', { class: 'check' }, all),
          h('td', { colspan: customerScope ? 9 : 8 }, fmtMonth(month), h('span', { class: 'muted small' }, `  ${rows.length} rader`)),
        ),
      );
      for (const i of rows) {
        const box = h('input', {
          type: 'checkbox',
          'aria-label': 'Markera rad',
          disabled: !!i.invoice_id,
          checked: selected.has(key(i)),
          onchange: (e) => {
            e.target.checked ? selected.add(key(i)) : selected.delete(key(i));
            sync();
          },
        });
        rowChecks.set(key(i), box);
        add(
          tbody,
          h(
            'tr',
            { class: i.selectable ? '' : 'inactive', dataset: { key: key(i) } },
            h('td', { class: 'check' }, box),
            h('td', { class: 'nowrap' }, fmtDate(i.date)),
            customerScope ? h('td', {}, i.project_code) : null,
            h('td', {}, KIND_LABEL[i.kind]),
            h('td', {}, i.user_name),
            h('td', {}, i.what, i.note ? h('div', { class: 'small muted' }, i.note) : null),
            h('td', { class: 'num' }, `${fmtNum(i.quantity)} ${i.unit}`),
            h('td', { class: 'num' }, i.rate ? fmtMoney(i.rate) : ''),
            h('td', { class: 'num' }, i.billable && i.amount ? fmtMoney(i.amount) : ''),
            h('td', {}, statusChip(i)),
          ),
        );
      }
    }
    const head = h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { class: 'check' }),
        h('th', {}, 'Datum'),
        customerScope ? h('th', {}, 'Projekt') : null,
        h('th', {}, 'Typ'),
        h('th', {}, 'Person'),
        h('th', {}, 'Aktivitet / beskrivning'),
        h('th', { class: 'num' }, 'Antal'),
        h('th', { class: 'num' }, 'Pris'),
        h('th', { class: 'num' }, 'Belopp'),
        h('th', {}, 'Status'),
      ),
    );
    setKids(table, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, head, tbody)), data.truncated ? h('div', { class: 'alert warn' }, 'Listan är avkortad. Begränsa perioden för att se allt.') : null);
    sync();
  }

  function sync() {
    for (const [k, box] of rowChecks) {
      box.checked = selected.has(k);
      box.closest('tr')?.classList.toggle('picked', box.checked);
    }
    for (const g of groupChecks) {
      const n = g.rows.filter((r) => selected.has(key(r))).length;
      g.box.checked = n > 0 && n === g.rows.length;
      g.box.indeterminate = n > 0 && n < g.rows.length;
    }
    drawBar();
  }

  function drawBar() {
    const rows = picked();
    const sum = round(rows.reduce((s, r) => s + (r.selectable ? r.amount : 0), 0));
    const canInvoice = rows.length > 0 && rows.every((r) => r.selectable);
    const canWaive = rows.length > 0 && rows.every((r) => !r.invoice_id && r.reason !== 'Avskriven');
    const canRestore = rows.length > 0 && rows.every((r) => r.reason === 'Avskriven');
    const readyCount = data.items.filter((i) => i.selectable).length;
    setKids(
      bar,
      h('button', { class: 'btn', type: 'button', disabled: !readyCount, onclick: () => { for (const i of data.items) if (i.selectable) selected.add(key(i)); sync(); } }, `Markera allt fakturerbart (${readyCount})`),
      h('button', { class: 'btn ghost', type: 'button', disabled: !rows.length, onclick: () => { selected.clear(); sync(); } }, 'Rensa'),
      h('span', { class: 'spacer' }, rows.length ? `${rows.length} markerade${canInvoice ? ` · ${fmtMoney(sum)}` : ''}` : ''),
      canRestore ? h('button', { class: 'btn', type: 'button', onclick: restore }, 'Ångra avskrivning') : null,
      h('button', { class: 'btn danger', type: 'button', disabled: !canWaive, title: canWaive || !rows.length ? '' : 'Fakturerade rader kan inte avskrivas', onclick: waive }, 'Avskriv …'),
      h(
        'button',
        { class: 'btn primary', type: 'button', disabled: !canInvoice, title: canInvoice || !rows.length ? '' : 'Bara godkända, debiterbara rader som inte redan är fakturerade kan faktureras', onclick: createInvoice },
        'Skapa fakturaunderlag …',
      ),
    );
  }

  function createInvoice() {
    const rows = picked();
    const total = round(rows.reduce((s, r) => s + r.amount, 0));
    editDialog({
      title: 'Skapa fakturaunderlag',
      saveLabel: 'Skapa underlag',
      values: { invoice_date: localToday() },
      fields: [
        { name: 'invoice_date', label: 'Fakturadatum', type: 'date', required: true, hint: 'Avgör från vilket datum raderna räknas som fakturerade i upplupet.' },
        { name: 'note', label: 'Anteckning', maxlength: 500, full: true },
      ],
      extra: h('p', { class: 'muted' }, `${rows.length} rader, totalt ${fmtMoney(total)} exkl. moms. Allt annat ligger kvar att fakturera senare.`),
      onSave: async (v) => {
        const r = await post('/api/invoices', { customer_id: data.meta.customer_id, invoice_date: v.invoice_date, note: v.note, ...idsOf(rows) });
        toast(`Underlag ${r.number} skapat (${fmtMoney(r.total)}).`, 'ok');
        selected.clear();
        await load();
      },
    });
  }

  async function waive() {
    const rows = picked();
    const note = await promptDialog({
      title: `Avskriv ${rows.length} rader`,
      label: 'Anledning (till exempel kulans, eller faktureras som fast pris)',
      confirmLabel: 'Avskriv',
    });
    if (!note) return;
    try {
      await post('/api/billing/waive', { ...idsOf(rows), note });
      toast('Raderna är avskrivna och lämnar upplupet.', 'ok');
      selected.clear();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function restore() {
    try {
      await post('/api/billing/restore', idsOf(picked()));
      toast('Avskrivningen är ångrad.', 'ok');
      selected.clear();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const sel = (id2, label, options, value, onchange) =>
    h('div', { class: 'field' }, h('label', { for: id2 }, label), h('select', { id: id2, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));

  add(
    root,
    title,
    tiles,
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'filters' },
        sel('b-show', 'Visa', [['open', 'Ofakturerat'], ['all', 'Allt'], ['invoiced', 'Fakturerat'], ['waived', 'Avskrivet']], filter.show, (v) => { filter.show = v; selected.clear(); load().catch((e) => toast(e.message, 'error')); }),
        h('div', { class: 'field' }, h('label', { for: 'b-from' }, 'Från datum'), h('input', { id: 'b-from', type: 'date', onchange: (e) => { filter.from = e.target.value; load().catch((er) => toast(er.message, 'error')); } })),
        h('div', { class: 'field' }, h('label', { for: 'b-to' }, 'Till datum'), h('input', { id: 'b-to', type: 'date', onchange: (e) => { filter.to = e.target.value; load().catch((er) => toast(er.message, 'error')); } })),
      ),
    ),
    table,
    bar,
  );
  await load();
}

// ── Skapade underlag ───────────────────────────────────────────────────
async function invoiceHistory(root) {
  const box = h('div', { class: 'card flush' });
  const lineColumns = [
    { label: 'Typ', render: (r) => r.kind },
    { label: 'Projekt', render: (r) => r.project },
    { label: 'Beskrivning', render: (r) => r.description },
    { label: 'Antal', num: true, render: (r) => `${fmtNum(r.quantity)} ${r.unit}` },
    { label: 'À-pris', num: true, render: (r) => fmtMoney(r.rate) },
    { label: 'Belopp', num: true, render: (r) => fmtMoney(r.amount) },
  ];

  async function open(r) {
    const inv = await get(`/api/invoices/${r.id}`);
    openDialog({
      title: `Fakturaunderlag ${inv.number} · ${inv.customer_name}`,
      wide: true,
      content: [
        h('p', { class: 'muted' }, `Fakturadatum ${fmtDate(inv.invoice_date)} · avser ${fmtDate(inv.period_from)} – ${fmtDate(inv.period_to)}${inv.note ? ` · ${inv.note}` : ''}`),
        dataTable({ columns: lineColumns, rows: inv.lines, footer: (c, i) => (i === 0 ? 'Summa' : c.label === 'Belopp' ? fmtMoney(inv.total) : '') }),
      ],
    });
  }

  async function reload() {
    const rows = await get('/api/invoices');
    setKids(
      box,
      dataTable({
        rows,
        empty: 'Inga underlag skapade ännu.',
        columns: [
          { label: 'Nr', render: (r) => r.number },
          { label: 'Kund', render: (r) => r.customer_name },
          { label: 'Fakturadatum', render: (r) => fmtDate(r.invoice_date), class: 'nowrap' },
          { label: 'Avser', render: (r) => `${fmtDate(r.period_from)} – ${fmtDate(r.period_to)}`, class: 'nowrap' },
          { label: 'Belopp', num: true, render: (r) => fmtMoney(r.total_amount) },
          {
            label: '',
            class: 'actions',
            render: (r) => [
              h('button', { class: 'btn sm', type: 'button', onclick: () => open(r).catch((e) => toast(e.message, 'error')) }, 'Öppna'),
              ' ',
              h('a', { class: 'btn sm', href: `/api/invoices/${r.id}?format=csv` }, 'CSV'),
              ' ',
              h(
                'button',
                {
                  class: 'btn sm danger',
                  type: 'button',
                  onclick: async () => {
                    if (!(await confirmDialog(`Ångra underlag ${r.number}? Raderna blir fakturerbara igen.`, { confirmLabel: 'Ångra underlag', danger: true }))) return;
                    try {
                      await del(`/api/invoices/${r.id}`);
                      toast('Underlaget är ångrat.', 'ok');
                      await reload();
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                'Ångra',
              ),
            ],
          },
        ],
      }),
    );
  }
  add(root, h('h1', {}, 'Fakturering'), subnav('underlag'), box);
  await reload();
}

export async function renderBilling(root, params) {
  const [view, id] = params;
  if ((view === 'projekt' || view === 'kund') && Number.isInteger(Number(id))) return workbench(root, view, Number(id));
  if (view === 'underlag') return invoiceHistory(root);
  return overview(root);
}
