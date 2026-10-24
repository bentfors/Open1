import { get, post, del, qs } from '../api.js';
import { h, fmtMoney, fmtNum, fmtDate, toast, dataTable, openDialog, confirmDialog, monthRange, optionList, add, setKids } from '../dom.js';
import { state, isAdmin } from '../state.js';

const GROUPS = [
  ['project', 'Projekt'],
  ['customer', 'Kund'],
  ['activity', 'Aktivitet'],
  ['user', 'Användare'],
  ['category', 'Kategori'],
  ['month', 'Månad'],
  ['day', 'Dag'],
  ['absence', 'Frånvarotyp'],
];

function select(id, label, options, value, onchange) {
  const el = h(
    'select',
    { id, onchange: (e) => onchange(e.target.value) },
    options.map((o) => h('option', { value: String(o.value ?? ''), selected: String(o.value ?? '') === String(value ?? '') }, o.label)),
  );
  return h('div', { class: 'field' }, h('label', { for: id }, label), el);
}

function periodFields(filter, redraw) {
  const from = h('input', { id: 'r-from', type: 'date', value: filter.from, onchange: (e) => (filter.from = e.target.value) });
  const to = h('input', { id: 'r-to', type: 'date', value: filter.to, onchange: (e) => (filter.to = e.target.value) });
  const quick = (label, range) =>
    h(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        onclick: () => {
          Object.assign(filter, range);
          from.value = filter.from;
          to.value = filter.to;
          redraw();
        },
      },
      label,
    );
  const year = new Date().getFullYear();
  return [
    h('div', { class: 'field' }, h('label', { for: 'r-from' }, 'Från'), from),
    h('div', { class: 'field' }, h('label', { for: 'r-to' }, 'Till'), to),
    h('div', { class: 'row' }, quick('Denna månad', monthRange(0)), quick('Förra månaden', monthRange(-1)), quick('I år', { from: `${year}-01-01`, to: `${year}-12-31` })),
  ];
}

// ── Tidrapport ──────────────────────────────────────────────────────────
async function timeReport(root) {
  const admin = isAdmin();
  const filter = { ...monthRange(0), group_by: 'project', billable: '', status: '', user_id: '', customer_id: '', project_id: '', category_id: '' };
  const [people, customers, projects, categories] = await Promise.all([
    get('/api/people'),
    admin ? get('/api/customers') : [],
    admin ? get('/api/projects') : [],
    admin ? get('/api/categories') : [],
  ]);
  const result = h('div', { class: 'card flush' });

  async function run() {
    try {
      const data = await get(`/api/reports/time${qs(filter)}`);
      const cols = [
        { label: data.group_title, render: (r) => r.label },
        { label: 'Timmar', num: true, render: (r) => fmtNum(r.hours) },
        { label: 'Debiterbara', num: true, render: (r) => fmtNum(r.billable_hours) },
        ...(admin
          ? [
              { label: 'Intäkt', num: true, render: (r) => fmtMoney(r.revenue) },
              { label: 'Kostnad', num: true, render: (r) => fmtMoney(r.cost) },
              { label: 'TB', num: true, render: (r) => h('span', { class: r.margin < 0 ? 'neg' : '' }, fmtMoney(r.margin)) },
            ]
          : []),
      ];
      const t = data.total;
      setKids(result, 
        dataTable({
          columns: cols,
          rows: data.rows,
          empty: 'Ingen tid för urvalet.',
          footer: (c, i) => [ 'Summa', fmtNum(t.hours), fmtNum(t.billable_hours), t.revenue !== undefined ? fmtMoney(t.revenue) : '', t.cost !== undefined ? fmtMoney(t.cost) : '', t.margin !== undefined ? fmtMoney(t.margin) : ''][i],
        }),
      );
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  const csv = h('a', { class: 'btn', href: '#', onclick: (e) => { e.currentTarget.href = `/api/reports/time${qs({ ...filter, format: 'csv' })}`; } }, 'Exportera CSV');
  const fields = [
    ...periodFields(filter, run),
    select('r-group', 'Gruppera på', GROUPS.map(([value, label]) => ({ value, label })), filter.group_by, (v) => (filter.group_by = v)),
    select('r-user', 'Person', optionList(people, { blank: 'Alla' }), '', (v) => (filter.user_id = v)),
    ...(admin
      ? [
          select('r-customer', 'Kund', optionList(customers, { blank: 'Alla' }), '', (v) => (filter.customer_id = v)),
          select('r-project', 'Projekt', optionList(projects, { label: (p) => `${p.code} ${p.name}`, blank: 'Alla' }), '', (v) => (filter.project_id = v)),
          select('r-category', 'Kategori', optionList(categories, { blank: 'Alla' }), '', (v) => (filter.category_id = v)),
        ]
      : []),
    select('r-billable', 'Debitering', [{ value: '', label: 'Alla' }, { value: 'yes', label: 'Debiterbar' }, { value: 'no', label: 'Ej debiterbar' }], '', (v) => (filter.billable = v)),
    select('r-status', 'Status', [{ value: '', label: 'All tid' }, { value: 'approved', label: 'Bara godkänd' }], '', (v) => (filter.status = v)),
  ];
  add(root, 
    h('div', { class: 'card' }, h('div', { class: 'filters' }, fields, h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Visa'), csv)),
    result,
    admin ? null : h('p', { class: 'muted small' }, 'Du ser tid för dig själv, dina projekt (som projektledare) och dina underställda. Priser och kostnader visas bara för administratörer.'),
  );
  await run();
}

// ── TB och provision ────────────────────────────────────────────────────
async function marginReport(root) {
  const admin = isAdmin();
  const filter = { ...monthRange(0), status: 'approved' };
  const result = h('div', { class: 'stack' });

  async function run() {
    try {
      const data = await get(`/api/reports/margin${qs(filter)}`);
      const parts = [];
      if (admin) {
        const total = data.consultants.reduce((t, c) => ({ revenue: t.revenue + c.revenue, cost: t.cost + c.cost, margin: t.margin + c.margin, hours: t.hours + c.hours }), { revenue: 0, cost: 0, margin: 0, hours: 0 });
        parts.push(
          h('div', { class: 'kpis' }, kpi('Intäkt', fmtMoney(total.revenue)), kpi('Kostnad', fmtMoney(total.cost)), kpi('TB', fmtMoney(total.margin)), kpi('Provision totalt', fmtMoney(data.earners.reduce((s, e) => s + e.commission, 0)))),
          h(
            'div',
            { class: 'card flush' },
            h('div', { class: 'group-head' }, 'TB per konsult'),
            dataTable({
              rows: data.consultants,
              empty: 'Ingen debiterad eller rapporterad tid i perioden.',
              columns: [
                { label: 'Konsult', render: (r) => r.name },
                { label: 'Kategori', render: (r) => r.category || '' },
                { label: 'Timmar', num: true, render: (r) => fmtNum(r.hours) },
                { label: 'Debiterbara', num: true, render: (r) => fmtNum(r.billable_hours) },
                { label: 'Intäkt', num: true, render: (r) => fmtMoney(r.revenue) },
                { label: 'Kostnad', num: true, render: (r) => fmtMoney(r.cost) },
                { label: 'TB', num: true, render: (r) => h('span', { class: r.margin < 0 ? 'neg' : '' }, fmtMoney(r.margin)) },
              ],
            }),
          ),
        );
      }
      parts.push(
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'group-head' }, admin ? 'Provision per mottagare' : 'Min provision'),
          dataTable({
            rows: data.earners,
            empty: 'Ingen provision i perioden.',
            columns: [
              { label: 'Mottagare', render: (r) => r.name },
              { label: 'Kategori', render: (r) => r.category || '' },
              { label: 'Provision', num: true, render: (r) => h('strong', {}, fmtMoney(r.commission)) },
            ],
          }),
        ),
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'group-head' }, 'Underlag'),
          dataTable({
            rows: data.commissions,
            empty: 'Inga kopplingar med tid i perioden.',
            columns: [
              ...(admin ? [{ label: 'Mottagare', render: (r) => [r.earner_name, ' ', h('span', { class: 'chip' }, r.earner_category || '–')] }] : []),
              { label: 'Konsult', render: (r) => [r.source_name, ' ', h('span', { class: 'chip' }, r.source_category || '–')] },
              { label: 'Gäller', render: (r) => (r.valid_from || r.valid_to ? `${r.valid_from || '…'} – ${r.valid_to || '…'}` : 'Alltid') },
              { label: 'Timmar', num: true, render: (r) => fmtNum(r.hours) },
              { label: 'TB', num: true, render: (r) => fmtMoney(r.margin) },
              { label: 'Andel', num: true, render: (r) => `${fmtNum(r.percent)} %` },
              { label: 'Provision', num: true, render: (r) => fmtMoney(r.commission) },
            ],
          }),
        ),
        h(
          'p',
          { class: 'muted small' },
          'TB = debiterbar intäkt − intern timkostnad. Frånvaro räknas inte. ',
          data.cost_basis === 'billable' ? 'Kostnad räknas bara på debiterbara timmar.' : 'Kostnad räknas på all projekttid, även ej debiterbar.',
          ' Fastprisprojekt räknas med sitt timpris som värde. Negativ TB ger negativ provision.',
        ),
      );
      setKids(result, ...parts);
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  const csv = h('a', { class: 'btn', href: '#', onclick: (e) => { e.currentTarget.href = `/api/reports/margin${qs({ ...filter, format: 'csv' })}`; } }, 'Exportera CSV');
  add(root, 
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'filters' },
        periodFields(filter, run),
        select('m-status', 'Underlag', [{ value: 'approved', label: 'Bara godkänd tid' }, { value: 'all', label: 'All tid (förhandsvisning)' }], 'approved', (v) => (filter.status = v)),
        h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Visa'),
        csv,
      ),
    ),
    result,
  );
  await run();
}

const kpi = (label, value) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));

// ── Fakturaunderlag ─────────────────────────────────────────────────────
async function invoiceBasis(root) {
  const customers = (await get('/api/customers')).filter((c) => c.active);
  const filter = { ...monthRange(-1), customer_id: '' };
  const preview = h('div');
  const history = h('div', { class: 'card flush' });

  const lineColumns = [
    { label: 'Typ', render: (r) => r.kind },
    { label: 'Projekt', render: (r) => r.project },
    { label: 'Beskrivning', render: (r) => r.description },
    { label: 'Antal', num: true, render: (r) => `${fmtNum(r.quantity)} ${r.unit}` },
    { label: 'À-pris', num: true, render: (r) => fmtMoney(r.rate) },
    { label: 'Belopp', num: true, render: (r) => fmtMoney(r.amount) },
  ];

  async function loadHistory() {
    const rows = await get('/api/invoices');
    setKids(history, 
      h('div', { class: 'group-head' }, 'Skapade underlag'),
      dataTable({
        rows,
        empty: 'Inga underlag skapade ännu.',
        columns: [
          { label: 'Nr', render: (r) => r.number },
          { label: 'Kund', render: (r) => r.customer_name },
          { label: 'Period', render: (r) => `${fmtDate(r.period_from)} – ${fmtDate(r.period_to)}` },
          { label: 'Belopp', num: true, render: (r) => fmtMoney(r.total_amount) },
          {
            label: '',
            class: 'actions',
            render: (r) => [
              h('button', { class: 'btn sm', type: 'button', onclick: () => open(r) }, 'Öppna'),
              ' ',
              h('a', { class: 'btn sm', href: `/api/invoices/${r.id}?format=csv` }, 'CSV'),
              ' ',
              h(
                'button',
                {
                  class: 'btn sm danger',
                  type: 'button',
                  onclick: async () => {
                    if (!(await confirmDialog(`Ångra underlag ${r.number}? Raderna kan faktureras igen.`, { confirmLabel: 'Ångra underlag', danger: true }))) return;
                    try {
                      await del(`/api/invoices/${r.id}`);
                      toast('Underlaget är ångrat.', 'ok');
                      await loadHistory();
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

  async function open(r) {
    const inv = await get(`/api/invoices/${r.id}`);
    openDialog({
      title: `Fakturaunderlag ${inv.number} · ${inv.customer_name}`,
      wide: true,
      content: [h('p', { class: 'muted' }, `${fmtDate(inv.period_from)} – ${fmtDate(inv.period_to)}${inv.note ? ` · ${inv.note}` : ''}`), dataTable({ columns: lineColumns, rows: inv.lines, footer: (c, i) => (i === 0 ? 'Summa' : c.label === 'Belopp' ? fmtMoney(inv.total) : '') })],
    });
  }

  const note = h('input', { id: 'inv-note', type: 'text', maxlength: 500, placeholder: 'Valfri anteckning' });
  async function run() {
    if (!filter.customer_id) {
      setKids(preview, h('p', { class: 'muted' }, 'Välj en kund och en period och klicka på Förhandsgranska.'));
      return;
    }
    try {
      const data = await get(`/api/invoices/preview${qs(filter)}`);
      setKids(preview, 
        data.unapproved_entries
          ? h('div', { class: 'alert warn' }, `${data.unapproved_entries} debiterbara tidsrader i perioden är inte godkända och tas inte med.`)
          : null,
        h(
          'div',
          { class: 'card flush' },
          dataTable({ columns: lineColumns, rows: data.lines, empty: 'Inget godkänt och ofakturerat för perioden.', footer: (c, i) => (i === 0 ? 'Summa' : c.label === 'Belopp' ? fmtMoney(data.total) : '') }),
          data.lines.length
            ? h(
                'div',
                { class: 'sticky-actions' },
                note,
                h(
                  'button',
                  {
                    class: 'btn primary',
                    type: 'button',
                    onclick: async () => {
                      try {
                        await post('/api/invoices', { ...filter, note: note.value });
                        toast('Underlaget är skapat.', 'ok');
                        await run();
                        await loadHistory();
                      } catch (err) {
                        toast(err.message, 'error');
                      }
                    },
                  },
                  'Skapa underlag och markera som fakturerat',
                ),
              )
            : null,
        ),
      );
    } catch (err) {
      setKids(preview, h('div', { class: 'alert error' }, err.message));
    }
  }

  add(root, 
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'filters' },
        select('inv-customer', 'Kund', optionList(customers, { blank: 'Välj kund …' }), filter.customer_id, (v) => (filter.customer_id = v)),
        periodFields(filter, run),
        h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Förhandsgranska'),
      ),
      h('p', { class: 'muted small' }, 'Med: godkänd tid på löpande räkning, samt godkända utlägg och körningar som är markerade för vidarefakturering. Fastprisprojekt ingår inte. Belopp är exklusive moms.'),
    ),
    preview,
    history,
  );
  await loadHistory();
  await run();
}

export async function renderReports(root, params) {
  const earner = state.user.is_earner;
  const tabs = [
    ['tid', 'Tidrapport', true],
    ['provision', isAdmin() ? 'TB och provision' : 'Min provision', isAdmin() || earner],
    ['underlag', 'Fakturaunderlag', isAdmin()],
  ].filter((t) => t[2]);
  const active = tabs.some((t) => t[0] === params[0]) ? params[0] : 'tid';
  add(root, 
    h('h1', {}, 'Rapporter'),
    h('div', { class: 'subnav' }, tabs.map(([id, label]) => h('a', { href: `#/rapporter/${id}`, 'aria-current': id === active ? 'page' : null }, label))),
  );
  const body = h('div', { class: 'stack' });
  add(root, body);
  await { tid: timeReport, provision: marginReport, underlag: invoiceBasis }[active](body);
}
