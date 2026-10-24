import { get, post } from '../api.js';
import { h, fmtHours, fmtDate, fmtMoney, fmtNum, fmtDow, toast, promptDialog, confirmDialog, dataTable, add, setKids } from '../dom.js';
import { state, isAdmin, refreshApprovalCount } from '../state.js';

const KINDS = [
  { id: 'time', api: 'time', key: 'time', label: 'Tid' },
  { id: 'expense', api: 'expense', key: 'expenses', label: 'Utlägg' },
  { id: 'mileage', api: 'mileage', key: 'mileage', label: 'Körjournal' },
];

const where = (r) => (r.project_code ? `${r.project_code} ${r.project_name}` : '–');

const COLUMNS = {
  time: [
    { label: 'Datum', render: (r) => `${fmtDow(r.date)} ${fmtDate(r.date)}`, class: 'nowrap' },
    { label: 'Projekt / aktivitet', render: (r) => (r.absence_name ? h('span', { class: 'chip warn' }, r.absence_name) : `${where(r)} › ${r.activity_name}`) },
    { label: 'Timmar', num: true, render: (r) => fmtHours(r.minutes) },
    { label: 'Anteckning', render: (r) => r.note },
  ],
  expense: [
    { label: 'Datum', render: (r) => fmtDate(r.date), class: 'nowrap' },
    { label: 'Beskrivning', render: (r) => [r.description, ' ', r.billable ? h('span', { class: 'chip accent' }, 'Vidarefaktureras') : null] },
    { label: 'Projekt', render: where },
    { label: 'Belopp', num: true, render: (r) => fmtMoney(r.amount) },
    { label: 'Moms', num: true, render: (r) => (r.vat ? fmtMoney(r.vat) : '') },
    {
      label: 'Kvitto',
      render: (r) => (r.has_receipt ? h('a', { href: `/api/expenses/${r.id}/receipt`, target: '_blank', rel: 'noopener' }, 'Visa') : h('span', { class: 'muted' }, 'saknas')),
    },
  ],
  mileage: [
    { label: 'Datum', render: (r) => fmtDate(r.date), class: 'nowrap' },
    { label: 'Resa', render: (r) => [r.purpose, r.from_place || r.to_place ? h('div', { class: 'small muted' }, `${r.from_place} → ${r.to_place}`) : null] },
    { label: 'Projekt', render: where },
    { label: 'Km', num: true, render: (r) => fmtNum(r.km, 1) },
    { label: 'Belopp', num: true, render: (r) => fmtMoney(r.km * r.rate_per_km) },
  ],
};

export async function renderApprovals(root, params) {
  const mode = params[0] === 'godkant' && isAdmin() ? 'approved' : 'pending';
  let activeKind = 'time';
  const filters = { from: '', to: '', user_id: '' };
  const selected = { time: new Set(), expense: new Set(), mileage: new Set() };
  let data;
  let people = [];

  async function load() {
    if (mode === 'approved') {
      const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
      data = await get(`/api/approvals/approved?${q}`);
    } else {
      data = await get('/api/approvals');
    }
    for (const k of KINDS) {
      const ids = new Set(data[k.key].map((r) => r.id));
      for (const id of [...selected[k.id]]) if (!ids.has(id)) selected[k.id].delete(id);
    }
  }

  async function decide(kind, decision) {
    const ids = [...selected[kind.id]];
    if (!ids.length) return;
    let note = '';
    if (decision === 'reject') {
      note = await promptDialog({ title: 'Avslå', label: 'Anledning (visas för den som rapporterat)', confirmLabel: 'Avslå' });
      if (!note) return;
    }
    try {
      if (mode === 'approved') {
        if (!(await confirmDialog(`${ids.length} rader öppnas igen och måste skickas in och godkännas på nytt.`, { confirmLabel: 'Öppna igen', danger: true }))) return;
        await post('/api/approvals/reopen', { kind: kind.api, ids });
        toast('Raderna är öppnade igen.', 'ok');
      } else {
        await post('/api/approvals/decide', { kind: kind.api, ids, decision, note });
        toast(decision === 'approve' ? `${ids.length} godkända.` : `${ids.length} avslagna.`, 'ok');
      }
      selected[kind.id].clear();
      await load();
      draw();
      refreshApprovalCount();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function group(kind, rows) {
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { name: r.user_name, rows: [] });
      byUser.get(r.user_id).rows.push(r);
    }
    const sel = selected[kind.id];
    return [...byUser.values()].map((g) => {
      const ids = g.rows.map((r) => r.id);
      const all = h('input', {
        type: 'checkbox',
        'aria-label': `Markera alla för ${g.name}`,
        checked: ids.every((id) => sel.has(id)),
        onchange: (e) => {
          for (const id of ids) e.target.checked ? sel.add(id) : sel.delete(id);
          draw();
        },
      });
      const total = kind.id === 'time' ? `${fmtHours(g.rows.reduce((s, r) => s + r.minutes, 0))} h` : kind.id === 'expense' ? fmtMoney(g.rows.reduce((s, r) => s + r.amount, 0)) : `${fmtNum(g.rows.reduce((s, r) => s + r.km, 0), 1)} km`;
      const cols = [
        {
          label: '',
          render: (r) =>
            h('input', {
              type: 'checkbox',
              'aria-label': 'Markera rad',
              checked: sel.has(r.id),
              onchange: (e) => {
                e.target.checked ? sel.add(r.id) : sel.delete(r.id);
                drawBar();
              },
            }),
        },
        ...COLUMNS[kind.id],
      ];
      return h('div', { class: 'card flush' }, h('div', { class: 'group-head' }, all, g.name, h('span', { class: 'muted' }, `${g.rows.length} rader · ${total}`)), dataTable({ columns: cols, rows: g.rows }));
    });
  }

  const content = h('div', { class: 'stack' });
  const bar = h('div', { class: 'sticky-actions' });
  const tabs = h('div', { class: 'subnav' });

  function drawBar() {
    const kind = KINDS.find((k) => k.id === activeKind);
    const n = selected[kind.id].size;
    setKids(bar, 
      ...(mode === 'approved'
        ? [h('button', { class: 'btn danger', type: 'button', disabled: !n, onclick: () => decide(kind, 'reopen') }, `Öppna igen (${n})`)]
        : [
            h('button', { class: 'btn primary', type: 'button', disabled: !n, onclick: () => decide(kind, 'approve') }, `Godkänn (${n})`),
            h('button', { class: 'btn danger', type: 'button', disabled: !n, onclick: () => decide(kind, 'reject') }, `Avslå (${n})`),
          ]),
      h('span', { class: 'muted small' }, n ? '' : 'Markera rader för att fortsätta.'),
    );
  }

  function draw() {
    setKids(tabs, 
      ...KINDS.map((k) =>
        h(
          'a',
          {
            href: '#',
            'aria-current': k.id === activeKind ? 'page' : null,
            onclick: (e) => {
              e.preventDefault();
              activeKind = k.id;
              draw();
            },
          },
          `${k.label} (${data[k.key].length})`,
        ),
      ),
    );
    const kind = KINDS.find((k) => k.id === activeKind);
    const rows = data[kind.key];
    setKids(content, ...(rows.length ? group(kind, rows) : [h('div', { class: 'card empty' }, mode === 'approved' ? 'Inga godkända rader för urvalet.' : 'Inget väntar på attest. 🎉')]));
    drawBar();
  }

  add(root, h('h1', {}, mode === 'approved' ? 'Öppna godkänt igen' : 'Attest'));
  if (isAdmin()) {
    add(root, 
      h(
        'div',
        { class: 'subnav' },
        h('a', { href: '#/attest', 'aria-current': mode === 'pending' ? 'page' : null }, 'Väntar på attest'),
        h('a', { href: '#/attest/godkant', 'aria-current': mode === 'approved' ? 'page' : null }, 'Godkända (rättning)'),
      ),
    );
  }
  if (mode === 'approved') {
    people = await get('/api/people');
    const userSel = h('select', { id: 'f-user', onchange: (e) => (filters.user_id = e.target.value) }, h('option', { value: '' }, 'Alla'), people.map((p) => h('option', { value: p.id }, p.name)));
    const from = h('input', { id: 'f-from', type: 'date', onchange: (e) => (filters.from = e.target.value) });
    const to = h('input', { id: 'f-to', type: 'date', onchange: (e) => (filters.to = e.target.value) });
    add(root, 
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'filters' },
          h('div', { class: 'field' }, h('label', { for: 'f-user' }, 'Person'), userSel),
          h('div', { class: 'field' }, h('label', { for: 'f-from' }, 'Från'), from),
          h('div', { class: 'field' }, h('label', { for: 'f-to' }, 'Till'), to),
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onclick: async () => {
                try {
                  await load();
                  draw();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            'Visa',
          ),
        ),
        h('p', { class: 'muted small' }, 'Fakturerade rader visas inte. Ångra fakturaunderlaget först.'),
      ),
    );
  }
  add(root, tabs, content, bar);
  await load();
  draw();
  // Visa första fliken som har innehåll.
  const firstWithRows = KINDS.find((k) => data[k.key].length);
  if (firstWithRows && firstWithRows.id !== activeKind && !data[KINDS[0].key].length) {
    activeKind = firstWithRows.id;
    draw();
  }
}
