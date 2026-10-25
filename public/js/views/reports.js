import { get, qs } from '../api.js';
import { h, add, setKids, fmtMoney, fmtNum, fmtDate, toast, dataTable, openDialog, monthRange, quarterRange, previousMonthEnd, localToday, optionList } from '../dom.js';
import { state, isAdmin } from '../state.js';

const round = (n) => Math.round(n * 100) / 100;

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

function periodFields(filter, redraw, extraQuick = []) {
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
  const extra = extraQuick.length ? extraQuick : [['I år', { from: `${year}-01-01`, to: `${year}-12-31` }]];
  return [
    h('div', { class: 'field' }, h('label', { for: 'r-from' }, 'Från'), from),
    h('div', { class: 'field' }, h('label', { for: 'r-to' }, 'Till'), to),
    h('div', { class: 'row' }, quick('Denna månad', monthRange(0)), quick('Förra månaden', monthRange(-1)), extra.map(([label, range]) => quick(label, range))),
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
const KIND_LABEL = { tb_percent: 'Procent av TB', per_consultant: 'Belopp per konsult i uppdrag', tb_tiered: 'Procent av TB, trappa på antal konsulter' };

function basisText(r) {
  if (r.kind === 'tb_percent') return `TB ${fmtMoney(r.tb)} × ${fmtNum(r.percent)} %`;
  if (r.kind === 'per_consultant') return `${fmtNum(r.consultants)} konsultmånader × ${fmtMoney(r.amount_per_consultant)}`;
  return `TB ${fmtMoney(r.tb)} × ${fmtNum(r.percent)} % (${fmtNum(r.consultants)} ${r.consultants === 1 ? 'konsult' : 'konsulter'} i snitt)`;
}

function showBasis(r) {
  const parts = [h('p', {}, h('strong', {}, `${r.earner_name} · ${r.rule_name || KIND_LABEL[r.kind]} · ${r.period_label}`)), h('p', { class: 'muted' }, `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}${r.complete ? '' : ' (pågår)'}`)];
  if (r.sources.length) {
    parts.push(
      h('div', { class: 'section-title' }, 'TB per konsult'),
      dataTable({
        rows: r.sources,
        columns: [
          { label: 'Konsult', render: (x) => x.name },
          { label: 'Timmar', num: true, render: (x) => fmtNum(x.hours) },
          { label: 'TB', num: true, render: (x) => fmtMoney(x.tb) },
        ],
        footer: (c, i) => [`Summa`, '', fmtMoney(r.tb)][i],
      }),
    );
  }
  if (r.months.length) {
    parts.push(
      h('div', { class: 'section-title' }, 'Konsulter i uppdrag per månad'),
      dataTable({ rows: r.months, columns: [{ label: 'Månad', render: (m) => m.month }, { label: 'Antal', num: true, render: (m) => m.consultants }] }),
    );
  }
  parts.push(h('p', { class: 'section-title' }, `${basisText(r)} = ${fmtMoney(r.commission)}`));
  openDialog({ title: 'Underlag för provision', wide: true, content: parts });
}

async function marginReport(root) {
  const admin = isAdmin();
  const filter = { ...monthRange(-1) };
  const result = h('div', { class: 'stack' });

  async function run() {
    try {
      const [com, margin] = await Promise.all([get(`/api/reports/commission${qs(filter)}`), admin ? get(`/api/reports/margin${qs(filter)}`) : { consultants: [] }]);
      const parts = [];
      if (admin) {
        const total = margin.consultants.reduce((t, c) => ({ revenue: t.revenue + c.revenue, cost: t.cost + c.cost, margin: t.margin + c.margin }), { revenue: 0, cost: 0, margin: 0 });
        parts.push(
          h('div', { class: 'kpis' }, kpi('Intäkt', fmtMoney(total.revenue)), kpi('Kostnad', fmtMoney(total.cost)), kpi('TB', fmtMoney(total.margin)), kpi('Provision (perioder som överlappar)', fmtMoney(com.earners.reduce((s, e) => s + e.commission, 0)))),
        );
      }
      parts.push(
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'group-head' }, admin ? 'Provision per mottagare' : 'Min provision'),
          dataTable({
            rows: com.earners,
            empty: 'Ingen provision för perioden.',
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
          h('div', { class: 'group-head' }, 'Per regel och period'),
          dataTable({
            rows: com.rows,
            empty: 'Inga regler med underlag i perioden.',
            columns: [
              ...(admin ? [{ label: 'Mottagare', render: (r) => [r.earner_name, ' ', h('span', { class: 'chip' }, r.earner_category || '–')] }] : []),
              { label: 'Regel', render: (r) => [r.rule_name || KIND_LABEL[r.kind], h('div', { class: 'small muted' }, basisText(r))] },
              { label: 'Period', render: (r) => [r.period_label, r.complete ? null : h('span', { class: 'chip warn' }, ' pågår')], class: 'nowrap' },
              { label: 'Provision', num: true, render: (r) => h('strong', { class: r.commission < 0 ? 'neg' : '' }, fmtMoney(r.commission)) },
              { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', type: 'button', onclick: () => showBasis(r) }, 'Underlag') },
            ],
          }),
        ),
      );
      if (admin) {
        parts.push(
          h(
            'div',
            { class: 'card flush' },
            h('div', { class: 'group-head' }, 'TB per konsult'),
            dataTable({
              rows: margin.consultants,
              empty: 'Ingen rapporterad tid i perioden.',
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
          'p',
          { class: 'muted small' },
          'Bara attesterad tid räknas. Kvartal är kalenderkvartal (Q1 = januari–mars). Provision räknas per hel månad eller kvartal enligt reglerna, även om du väljer ett kortare intervall, och perioder som inte är slut markeras som pågående. ',
          'TB = debiterbar intäkt − intern timkostnad, frånvaro räknas inte. ',
          com.cost_basis === 'billable' ? 'Kostnad räknas bara på debiterbara timmar. ' : 'Kostnad räknas på all projekttid, även ej debiterbar. ',
          'Fastprisprojekt räknas med sitt timpris som värde.',
        ),
      );
      setKids(result, ...parts);
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  const csv = h('a', { class: 'btn', href: '#', onclick: (e) => { e.currentTarget.href = `/api/reports/commission${qs({ ...filter, format: 'csv' })}`; } }, 'Exportera CSV');
  const year = new Date().getFullYear();
  add(
    root,
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'filters' },
        periodFields(filter, run, [['Detta kvartal', quarterRange(0)], ['Förra kvartalet', quarterRange(-1)], ['I år', { from: `${year}-01-01`, to: `${year}-12-31` }]]),
        h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Visa'),
        csv,
      ),
    ),
    result,
  );
  await run();
}

const kpi = (label, value) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));

// ── Upplupet ────────────────────────────────────────────────────────────
async function accruedReport(root) {
  const now = localToday();
  const filter = { from: '', to: previousMonthEnd(now), as_of: '', group_by: 'customer' };
  const result = h('div', { class: 'stack' });

  async function run() {
    try {
      const data = await get(`/api/reports/accrued${qs(filter)}`);
      const t = data.total;
      const unapproved = (r) => round(r.time_unapproved + r.other_unapproved);
      const isProject = data.group_by === 'project';
      setKids(
        result,
        h(
          'div',
          { class: 'kpis' },
          kpi('Upplupet, godkänt', fmtMoney(t.total_approved)),
          kpi('Varav tid', fmtMoney(t.time_approved)),
          kpi('Ej godkänt', fmtMoney(round(t.time_unapproved + t.other_unapproved))),
          kpi('Totalt inkl. ej godkänt', fmtMoney(t.total)),
        ),
        h(
          'div',
          { class: 'card flush' },
          dataTable({
            rows: data.rows,
            empty: 'Inget upplupet för perioden. Allt som utförts är fakturerat.',
            columns: [
              { label: data.group_title, render: (r) => (isProject ? h('a', { href: `#/fakturering/projekt/${r.key}` }, r.label) : data.group_by === 'customer' ? h('a', { href: `#/fakturering/kund/${r.key}` }, r.label) : r.label) },
              ...(isProject ? [{ label: 'Kund', render: (r) => r.customer_name }] : []),
              { label: 'Äldsta', render: (r) => fmtDate(r.oldest), class: 'nowrap' },
              { label: 'Timmar', num: true, render: (r) => fmtNum(r.hours_approved) },
              { label: 'Tid godkänd', num: true, render: (r) => fmtMoney(r.time_approved) },
              { label: 'Utlägg/körning', num: true, render: (r) => fmtMoney(r.other_approved) },
              { label: 'Summa godkänt', num: true, render: (r) => h('strong', {}, fmtMoney(r.total_approved)) },
              { label: 'Ej godkänt', num: true, render: (r) => (unapproved(r) ? fmtMoney(unapproved(r)) : '') },
              ...(t.fixed_hours ? [{ label: 'Fastpris (tim)', num: true, render: (r) => (r.fixed_hours ? fmtNum(r.fixed_hours) : '') }] : []),
            ],
            footer: (c, i) => {
              const cells = [
                'Summa',
                ...(isProject ? [''] : []),
                '',
                fmtNum(t.hours_approved),
                fmtMoney(t.time_approved),
                fmtMoney(t.other_approved),
                fmtMoney(t.total_approved),
                fmtMoney(round(t.time_unapproved + t.other_unapproved)),
                ...(t.fixed_hours ? [fmtNum(t.fixed_hours)] : []),
              ];
              return cells[i];
            },
          }),
        ),
        t.fixed_hours ? h('div', { class: 'alert' }, `Fastpris: ${fmtNum(t.fixed_hours)} timmar (värde enligt timpris ${fmtMoney(t.fixed_value)}) ingår inte, eftersom fast pris faktureras separat.`) : null,
        h(
          'p',
          { class: 'muted small' },
          `Avser tid, utlägg och körning med datum ${data.from === '0000-01-01' ? 'från början' : `från ${fmtDate(data.from)}`} till och med ${data.to === '9999-12-31' ? 'idag och framåt' : fmtDate(data.to)}. `,
          `Som fakturerat räknas underlag med fakturadatum till och med ${fmtDate(data.as_of)}. Avslagen tid ingår inte. Ej godkänd tid värderas med priset vid senaste sparning.`,
        ),
      );
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  const from = h('input', { id: 'a-from', type: 'date', value: filter.from, onchange: (e) => (filter.from = e.target.value) });
  const to = h('input', { id: 'a-to', type: 'date', value: filter.to, onchange: (e) => (filter.to = e.target.value) });
  const asOf = h('input', { id: 'a-asof', type: 'date', value: filter.as_of, onchange: (e) => (filter.as_of = e.target.value) });
  const preset = (label, values) =>
    h('button', { class: 'btn sm', type: 'button', onclick: () => { Object.assign(filter, values); from.value = filter.from; to.value = filter.to; run(); } }, label);
  const csv = h('a', { class: 'btn', href: '#', onclick: (e) => { e.currentTarget.href = `/api/reports/accrued${qs({ ...filter, format: 'csv' })}`; } }, 'Exportera CSV');
  const prevMonth = monthRange(-1);

  add(
    root,
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'filters' },
        h('div', { class: 'field' }, h('label', { for: 'a-from' }, 'Från datum (tomt = från början)'), from),
        h('div', { class: 'field' }, h('label', { for: 'a-to' }, 'Till och med datum'), to),
        select('a-group', 'Gruppera på', [['customer', 'Kund'], ['project', 'Projekt'], ['user', 'Användare'], ['month', 'Månad'], ['all', 'Totalt']].map(([value, label]) => ({ value, label })), filter.group_by, (v) => (filter.group_by = v)),
        h('div', { class: 'field' }, h('label', { for: 'a-asof' }, 'Fakturerat till och med (tomt = idag)'), asOf),
        h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Visa'),
        csv,
      ),
      h(
        'div',
        { class: 'row', 'aria-label': 'Snabbval' },
        preset('T.o.m. förra månadens slut', { from: '', to: previousMonthEnd(now) }),
        preset('T.o.m. idag', { from: '', to: now }),
        preset('Bara förra månaden', { from: prevMonth.from, to: prevMonth.to }),
        preset('I år', { from: `${new Date().getFullYear()}-01-01`, to: now }),
      ),
    ),
    result,
  );
  await run();
}

export async function renderReports(root, params) {
  const earner = state.user.is_earner;
  const tabs = [
    ['tid', 'Tidrapport', true],
    ['provision', isAdmin() ? 'TB och provision' : 'Min provision', isAdmin() || earner],
    ['upplupet', 'Upplupet', isAdmin()],
  ].filter((t) => t[2]);
  const active = tabs.some((t) => t[0] === params[0]) ? params[0] : 'tid';
  add(root, 
    h('h1', {}, 'Rapporter'),
    h('div', { class: 'subnav' }, tabs.map(([id, label]) => h('a', { href: `#/rapporter/${id}`, 'aria-current': id === active ? 'page' : null }, label))),
  );
  const body = h('div', { class: 'stack' });
  add(root, body);
  await { tid: timeReport, provision: marginReport, upplupet: accruedReport }[active](body);
}
