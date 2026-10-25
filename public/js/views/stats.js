import { get, qs } from '../api.js';
import { h, s, add, setKids, fmtMoney, fmtNum, fmtDate, fmtSpan, fmtDaysLeft, fmtK, shortMonth, fmtMonth, dataTable, toast, localToday } from '../dom.js';
import { isFinanceSuper } from '../state.js';
import { basisText, showBasis } from './reports.js';

const KIND_LABEL = { tb_percent: 'Procent av TB', per_consultant: 'Belopp per konsult', tb_tiered: 'Trappa på antal konsulter' };
const STATE = { actual: ['Utfall', 'approved'], running: ['Pågår, prognos', 'warn'], forecast: ['Prognos', 'accent'] };

const kpi = (label, value, note) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), note ? h('div', { class: 'small muted' }, note) : null);

// Rundar upp till ett "snyggt" tal (1, 2, 5 × tiopotens) för diagrammets övre gräns.
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= v);
}

function chart(months, nowMonth) {
  const W = 920;
  const H = 270;
  const pad = { l: 58, r: 12, t: 18, b: 34 };
  const top = niceMax(Math.max(...months.map((m) => m.actual + m.forecast)));
  const plotH = H - pad.t - pad.b;
  const bw = (W - pad.l - pad.r) / months.length;
  const y = (v) => pad.t + plotH - (v / top) * plotH;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Provision per månad, utfall och prognos' });

  for (const f of [0, 0.5, 1]) {
    svg.append(s('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(top * f), y2: y(top * f) }), s('text', { x: pad.l - 8, y: y(top * f) + 4, 'text-anchor': 'end' }, fmtK(top * f)));
  }
  months.forEach((m, i) => {
    const x = pad.l + i * bw + bw * 0.14;
    const w = bw * 0.72;
    const ha = (m.actual / top) * plotH;
    const hf = (m.forecast / top) * plotH;
    const label = `${fmtMonth(m.month)}: ${m.actual ? `utfall ${fmtMoney(m.actual)}` : ''}${m.actual && m.forecast ? ', ' : ''}${m.forecast ? `prognos ${fmtMoney(m.forecast)}` : ''}${!m.actual && !m.forecast ? '0 kr' : ''}`;
    const g = s('g', {}, s('title', {}, label));
    if (ha > 0) g.append(s('rect', { class: 'bar-actual', x, y: y(m.actual), width: w, height: ha }));
    if (hf > 0) g.append(s('rect', { class: 'bar-forecast', x, y: y(m.actual + m.forecast), width: w, height: hf }));
    g.append(s('rect', { x: pad.l + i * bw, y: pad.t, width: bw, height: plotH, fill: 'transparent' }));
    svg.append(g);
    const first = m.month.endsWith('-01') || i === 0;
    svg.append(s('text', { x: pad.l + i * bw + bw / 2, y: H - 16, 'text-anchor': 'middle' }, shortMonth(m.month)));
    if (first) svg.append(s('text', { x: pad.l + i * bw + bw / 2, y: H - 3, 'text-anchor': 'middle' }, m.month.slice(0, 4)));
    if (m.month === nowMonth) {
      const nx = pad.l + i * bw + bw / 2;
      svg.append(s('line', { class: 'now-line', x1: nx, x2: nx, y1: pad.t - 4, y2: pad.t + plotH }), s('text', { class: 'now-label', x: nx, y: pad.t - 6, 'text-anchor': 'middle' }, 'nu'));
    }
  });
  return h('div', { class: 'table-wrap' }, svg);
}

function scenarioCard(earnerId) {
  const result = h('div');
  const err = h('div', { class: 'alert error hidden' });
  const input = (id, label, props = {}) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { id, type: 'number', ...props }));
  const count = input('sc-count', 'Antal konsulter', { value: 1, min: 1, max: 20, step: 1 });
  const rate = input('sc-rate', 'Timpris (kr/tim)', { min: 0, step: 10, placeholder: 'till exempel 1100' });
  const cost = input('sc-cost', 'Timkostnad (kr/tim)', { min: 0, step: 10, placeholder: 'lön + bikostnader' });
  const hours = input('sc-hours', 'Timmar per vecka', { value: 40, min: 0.5, max: 80, step: 0.5 });
  const nextMonth = (() => {
    const d = new Date(`${localToday().slice(0, 8)}01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const start = h('div', { class: 'field' }, h('label', { for: 'sc-start' }, 'Startar'), h('input', { id: 'sc-start', type: 'date', value: nextMonth }));
  const length = input('sc-length', 'Längd (månader, tomt = löpande)', { min: 1, max: 60, step: 1 });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Räkna');

  go.addEventListener('click', async () => {
    err.classList.add('hidden');
    go.disabled = true;
    try {
      const q = qs({
        earner_id: earnerId,
        count: count.querySelector('input').value,
        rate: rate.querySelector('input').value,
        cost: cost.querySelector('input').value,
        hours_per_week: hours.querySelector('input').value,
        start: start.querySelector('input').value,
        length_months: length.querySelector('input').value,
      });
      const r = await get(`/api/stats/scenario${q}`);
      const changed = r.months.filter((m) => m.delta !== 0);
      setKids(
        result,
        r.has_rules
          ? [
              h('div', { class: 'result-big' }, `${r.delta_total >= 0 ? '+' : ''}${fmtMoney(r.delta_total)}`),
              h('p', { class: 'muted' }, `i provision under de närmaste ${r.months.length} månaderna, jämfört med utan försäljningen (${fmtMoney(r.baseline_total)} → ${fmtMoney(r.scenario_total)}).`),
              ...(r.tier_steps.length ? [h('div', { class: 'alert' }, r.tier_steps.map((t) => `${t.rule || 'Trappa'} ${t.period}: procenten går från ${fmtNum(t.from)} % till ${fmtNum(t.to)} %. `))] : []),
              changed.length
                ? dataTable({
                    rows: changed,
                    columns: [
                      { label: 'Månad', render: (m) => fmtMonth(m.month), class: 'nowrap' },
                      { label: 'Utan', num: true, render: (m) => fmtMoney(m.baseline) },
                      { label: 'Med', num: true, render: (m) => fmtMoney(m.scenario) },
                      { label: 'Skillnad', num: true, render: (m) => h('strong', { class: m.delta >= 0 ? 'pos' : 'neg' }, `${m.delta >= 0 ? '+' : ''}${fmtMoney(m.delta)}`) },
                    ],
                  })
                : h('p', { class: 'muted' }, 'Ingen skillnad i provision under perioden.'),
              h('p', { class: 'muted small' }, 'Räknar bara med uppdragstiden och att de nya konsulterna ingår i dina TB-regler och räknas med i regler som räknar antal konsulter. Provisionen tjänas in när perioden slutar.'),
            ]
          : h('div', { class: 'alert warn' }, 'Du har inga provisionsregler, så det finns ingen provision att räkna på.'),
      );
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      toast(e.message, 'error');
    } finally {
      go.disabled = false;
    }
  });

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Vad händer om jag säljer in mer?'),
    h('p', { class: 'muted' }, 'Lägg in en tänkt försäljning och se vad den ger i provision. Summan jämförs med prognosen här ovanför.'),
    err,
    h('div', { class: 'scenario-form' }, count, rate, cost, hours, start, length, h('div', { class: 'field' }, go)),
    result,
  );
}

export async function renderStats(root, params) {
  const requested = parseId(params[0]);
  const people = isFinanceSuper() ? await get('/api/stats/people') : [];
  const earnerId = requested ?? people[0]?.id;
  const data = await get(`/api/stats${qs({ earner_id: earnerId })}`);

  const head = [h('h1', {}, isFinanceSuper() ? 'Statistik' : 'Min statistik')];
  if (isFinanceSuper()) {
    const sel = h(
      'select',
      { id: 'who', 'aria-label': 'Välj person', onchange: (e) => (location.hash = `#/statistik/${e.target.value}`) },
      people.map((p) => h('option', { value: p.id, selected: p.id === data.earner.id }, `${p.name}${p.category ? ` (${p.category})` : ''}`)),
    );
    head.push(h('div', { class: 'field', 'aria-label': 'Person' }, h('label', { for: 'who' }, 'Visar statistik för'), sel));
  } else {
    head.push(h('p', { class: 'muted' }, `${data.earner.name}${data.earner.category ? ` · ${data.earner.category}` : ''}`));
  }
  add(root, ...head);

  if (!data.rules.length && !data.consultants.length) {
    add(root, h('div', { class: 'card empty' }, 'Det finns inga provisionsregler eller konsulter kopplade till dig ännu. Fråga din administratör.'));
    return;
  }

  const k = data.kpis;
  add(
    root,
    h(
      'div',
      { class: 'kpis' },
      kpi('Konsulter', `${k.in_assignment} / ${k.consultants}`, 'i uppdrag nu av dina'),
      kpi('TB förra månaden', fmtMoney(k.tb_last_month), 'attesterat, dina konsulter'),
      kpi('Intjänat i år', fmtMoney(k.commission_ytd), 'avslutade perioder'),
      kpi(`Prognos, ${data.horizon_months} mån`, fmtMoney(k.forecast_total), 'enligt avtalen'),
      kpi('Uppdrag som löper ut', String(k.expiring), 'inom 120 dagar'),
    ),
  );

  if (data.warnings.length) {
    add(root, h('div', { class: 'alert warn' }, 'Prognosen kan bli missvisande:', h('ul', { class: 'warn-list' }, data.warnings.map((w) => h('li', {}, w)))));
  }

  add(
    root,
    h(
      'div',
      { class: 'card flush' },
      h('div', { class: 'group-head' }, 'Provision per månad', h('span', { class: 'muted small' }, 'tjänas in när perioden slutar')),
      chart(data.months, data.as_of.slice(0, 7)),
      h('div', { class: 'chart-legend' }, h('span', { class: 'l-actual' }, 'Utfall (attesterad tid)'), h('span', { class: 'l-forecast' }, `Prognos (avtal, ${fmtNum(data.utilization)} % beläggning)`)),
    ),
  );

  // Konsulter
  add(
    root,
    h(
      'div',
      { class: 'card flush' },
      h('div', { class: 'group-head' }, 'Mina konsulter'),
      dataTable({
        rows: data.consultants,
        empty: 'Inga konsulter är kopplade till dig.',
        columns: [
          { label: 'Konsult', render: (c) => [h('strong', {}, c.name), h('div', { class: 'small muted' }, [c.category || '', c.category ? ' · ' : '', c.relation.join(', ')])] },
          {
            label: 'Anställd',
            render: (c) =>
              c.employment
                ? [`sedan ${fmtDate(c.employment.start_date)}`, h('div', { class: 'small muted' }, `${fmtSpan(c.employment.start_date, data.as_of)}${c.employment.end_date ? ` · slutar ${fmtDate(c.employment.end_date)}` : ''}`)]
                : h('span', { class: 'muted' }, 'saknas i registret'),
          },
          {
            label: 'Uppdrag',
            render: (c) =>
              c.assignments.length
                ? c.assignments.map((a) => h('div', {}, `${a.customer_name}${a.project_code ? ` (${a.project_code})` : ''}`, h('div', { class: 'small muted' }, `${a.start_date > data.as_of ? `från ${fmtDate(a.start_date)}` : 'pågår'} · ${a.end_date ? `till ${fmtDate(a.end_date)}, ${fmtDaysLeft(a.days_left)}` : 'löpande'} · ${fmtMoney(a.hourly_rate)}/tim`)))
                : h('span', { class: 'chip warn' }, c.bench_hours ? `bänk, ${fmtNum(c.bench_hours, 0)} tim` : 'inget uppdrag'),
          },
          { label: 'TB förra mån.', num: true, render: (c) => h('span', { class: c.last_month.tb < 0 ? 'neg' : '' }, fmtMoney(c.last_month.tb)) },
          { label: 'TB hittills', num: true, render: (c) => h('span', { class: c.this_month.tb < 0 ? 'neg' : '' }, fmtMoney(c.this_month.tb)) },
          { label: 'Prognos TB, 3 mån', num: true, render: (c) => h('span', { class: c.forecast_tb_3m < 0 ? 'neg' : '' }, fmtMoney(c.forecast_tb_3m)) },
        ],
      }),
    ),
  );

  // Uppdrag som löper ut
  if (data.expiring.length) {
    add(
      root,
      h(
        'div',
        { class: 'card flush' },
        h('div', { class: 'group-head' }, 'Uppdrag som löper ut', h('span', { class: 'muted small' }, 'förlängning eller ersättare räddar provisionen')),
        dataTable({
          rows: data.expiring,
          columns: [
            { label: 'Konsult', render: (e) => e.consultant },
            { label: 'Kund', render: (e) => [e.customer, e.project_code || e.title ? h('div', { class: 'small muted' }, [e.project_code, e.title].filter(Boolean).join(' · ')) : null] },
            { label: 'Slutar', render: (e) => [fmtDate(e.end_date), h('div', { class: 'small muted' }, fmtDaysLeft(e.days_left))], class: 'nowrap' },
            { label: 'Provision som står på spel', num: true, render: (e) => h('strong', {}, fmtMoney(e.at_risk)) },
          ],
        }),
      ),
    );
  }

  // Prognos per regel
  const shown = h('div', { class: 'card flush' });
  let showPast = false;
  const drawTimeline = () => {
    const rows = data.timeline.filter((r) => showPast || r.state !== 'actual');
    setKids(
      shown,
      h(
        'div',
        { class: 'group-head' },
        'Per regel och period',
        h('span', { class: 'spacer' }),
        h('label', { class: 'small row' }, h('input', { type: 'checkbox', checked: showPast, onchange: (e) => { showPast = e.target.checked; drawTimeline(); } }), 'Visa utfall bakåt'),
      ),
      dataTable({
        rows,
        empty: 'Inga perioder att visa.',
        columns: [
          { label: 'Regel', render: (r) => [r.rule_name || KIND_LABEL[r.kind], h('div', { class: 'small muted' }, basisText(r))] },
          { label: 'Period', render: (r) => r.period_label, class: 'nowrap' },
          { label: 'Status', render: (r) => h('span', { class: `chip ${STATE[r.state][1]}` }, STATE[r.state][0]) },
          {
            label: 'Provision',
            num: true,
            render: (r) => [h('strong', {}, fmtMoney(r.commission)), r.state === 'running' && r.actual_to_date !== null ? h('div', { class: 'small muted' }, `hittills ${fmtMoney(r.actual_to_date)}`) : null],
          },
          { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', type: 'button', onclick: () => showBasis(r, data.bench_cap_hours) }, 'Underlag') },
        ],
      }),
    );
  };
  drawTimeline();
  add(root, shown, scenarioCard(data.earner.id));
  add(
    root,
    h(
      'p',
      { class: 'muted small' },
      `Prognosen bygger på avtalsregistret: anställningar, uppdrag, timpriser och omfattning, med ${fmtNum(data.utilization)} % beläggning för semester och helgdagar. `,
      'Konsulter utan uppdrag räknas som bänk, vilket ger negativ TB de första ',
      data.bench_cap_hours === null ? 'timmarna utan gräns' : `${fmtNum(data.bench_cap_hours)} timmarna`,
      '. Provisionen kan aldrig bli lägre än 0 per regel och period. Utfall bygger på attesterad tid. Det är en uppskattning, inte ett löfte om utbetalning.',
    ),
  );
}

function parseId(param) {
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
