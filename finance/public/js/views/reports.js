import { get, qs } from '../api.js';
import { h, s, setKids, dataTable, fmtSek, fmtSekExact, fmtPct, fmtMonth, shortMonth, fmtK, fmtDate, monthRange, quarterRange, localToday } from '../dom.js';

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= v);
}

// Staplar för inkomst och utgift per månad (öre in, kronor på axeln).
export function monthChart(months) {
  const W = 920;
  const H = 262;
  const pad = { l: 62, r: 12, t: 14, b: 42 };
  const top = niceMax(Math.max(...months.flatMap((m) => [m.income, m.expense])) / 100);
  const plotH = H - pad.t - pad.b;
  const bw = (W - pad.l - pad.r) / months.length;
  const y = (kr) => pad.t + plotH - (kr / top) * plotH;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Inkomster och utgifter per månad' });
  for (const f of [0, 0.5, 1]) svg.append(s('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(top * f), y2: y(top * f) }), s('text', { x: pad.l - 8, y: y(top * f) + 4, 'text-anchor': 'end' }, fmtK(top * f)));
  months.forEach((m, i) => {
    const x0 = pad.l + i * bw;
    const w = Math.min(bw * 0.36, 34);
    const g = s('g', {}, s('title', {}, `${fmtMonth(m.month)}: inkomst ${fmtSek(m.income)}, utgift ${fmtSek(m.expense)}, netto ${fmtSek(m.net)}`));
    const inc = (m.income / 100 / top) * plotH;
    const exp = (m.expense / 100 / top) * plotH;
    if (inc > 0) g.append(s('rect', { class: 'bar-income', x: x0 + bw / 2 - w - 1, y: y(m.income / 100), width: w, height: inc }));
    if (exp > 0) g.append(s('rect', { class: 'bar-expense', x: x0 + bw / 2 + 1, y: y(m.expense / 100), width: w, height: exp }));
    g.append(s('rect', { x: x0, y: pad.t, width: bw, height: plotH, fill: 'transparent' }));
    svg.append(g, s('text', { x: x0 + bw / 2, y: H - 24, 'text-anchor': 'middle' }, shortMonth(m.month)));
    if (m.month.endsWith('-01') || i === 0) svg.append(s('text', { x: x0 + bw / 2, y: H - 8, 'text-anchor': 'middle' }, m.month.slice(0, 4)));
  });
  return h('div', {}, h('div', { class: 'table-wrap' }, svg), h('div', { class: 'chart-legend' }, h('span', { class: 'l-income' }, 'Inkomster'), h('span', { class: 'l-expense' }, 'Utgifter')));
}

function lines(title, rows, total, cls) {
  return h(
    'div',
    { class: 'card flush' },
    dataTable({
      empty: `Inga ${title.toLowerCase()} under perioden.`,
      rows,
      columns: [
        { label: title, render: (l) => h('span', {}, l.category, l.uncategorized ? h('span', { class: 'chip warn ml-s' }, 'kategorisera') : null) },
        { label: 'Belopp', num: true, render: (l) => fmtSekExact(l.amount) },
        { label: 'Andel', num: true, render: (l) => (total ? fmtPct(l.amount / total) : '') },
      ],
      footer: (c, i) => (i === 0 ? h('strong', {}, 'Summa') : c.label === 'Belopp' ? h('strong', { class: cls }, fmtSekExact(total)) : ''),
    }),
  );
}

export async function renderIncome(root) {
  const now = new Date();
  const presets = {
    month: ['Denna månad', () => monthRange(0)],
    prev: ['Förra månaden', () => monthRange(-1)],
    quarter: ['Detta kvartal', () => quarterRange(0)],
    year: ['I år', () => ({ from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` })],
    last12: ['Senaste 12 månaderna', () => ({ from: monthRange(-11).from, to: monthRange(0).to })],
    custom: ['Eget intervall', null],
  };
  let current = presets.prev[1]();
  const mount = h('div');
  const from = h('input', { id: 'r-from', type: 'date', value: current.from, onchange: () => ((current = { from: from.value, to: to.value }), (preset.value = 'custom'), load()) });
  const to = h('input', { id: 'r-to', type: 'date', value: current.to, onchange: () => ((current = { from: from.value, to: to.value }), (preset.value = 'custom'), load()) });
  const preset = h('select', { id: 'r-preset', onchange: () => { if (presets[preset.value][1]) { current = presets[preset.value][1](); from.value = current.from; to.value = current.to; load(); } } }, Object.entries(presets).map(([k, [label]]) => h('option', { value: k, selected: k === 'prev' }, label)));

  setKids(
    root,
    h('div', { class: 'row between' }, h('h1', {}, 'Resultatrapport'), h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Skriv ut')),
    h('div', { class: 'card no-print' }, h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'r-preset' }, 'Period'), preset), h('div', { class: 'field' }, h('label', { for: 'r-from' }, 'Från'), from), h('div', { class: 'field' }, h('label', { for: 'r-to' }, 'Till'), to))),
    mount,
  );

  async function load() {
    if (!current.from || !current.to) return;
    const r = await get(`/api/reports/income${qs(current)}`);
    setKids(
      mount,
      h('p', { class: 'muted' }, `${fmtDate(r.from)} – ${fmtDate(r.to)}`),
      r.uncategorized.count
        ? h('div', { class: 'alert warn' }, `${r.uncategorized.count} transaktioner är okategoriserade (${fmtSekExact(r.uncategorized.amount)} netto) och redovisas på egna rader. `, h('a', { href: '#/transaktioner?uncategorized=1' }, 'Kategorisera dem'), ' för en rättvisande rapport.')
        : null,
      h('div', { class: 'kpis' }, kpi('Inkomster', fmtSek(r.income), '', 'pos'), kpi('Utgifter', fmtSek(r.expense)), kpi('Resultat', fmtSek(r.net), '', r.net < 0 ? 'neg' : 'pos'), kpi('Sparkvot', fmtPct(r.savings_rate), 'resultat / inkomster')),
      r.months.length > 1 ? h('div', { class: 'card flush mb-m' }, monthChart(r.months)) : null,
      h('div', { class: 'two-col' }, lines('Inkomster', r.income_lines, r.income, 'pos'), lines('Utgifter', r.expense_lines, r.expense, '')),
      r.transfers.count
        ? h('p', { class: 'muted small' }, `Ingår inte: ${r.transfers.count} överföringar (in ${fmtSek(r.transfers.in)}, ut ${fmtSek(r.transfers.out)}). Överföringar mellan egna konton, sparande och amorteringar flyttar pengar men är varken inkomst eller utgift.`)
        : null,
      h('p', { class: 'muted small' }, 'Rapporten bygger på de kontoutdrag du importerat. Konton utan importerade utdrag saknas i den. Räntor på lån räknas som utgift först när de är kategoriserade som Räntekostnader.'),
    );
  }

  await load();
}

// ── Balansrapport ──────────────────────────────────────────────────────
export function historyChart(history) {
  const W = 920;
  const H = 200;
  const pad = { l: 70, r: 14, t: 14, b: 26 };
  const vals = history.map((p) => (p.assets - p.liabilities) / 100);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) (lo -= 1), (hi += 1);
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;
  const x = (i) => pad.l + (history.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (history.length - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Nettoförmögenhet över tid' });
  for (const f of [0, 0.5, 1]) {
    const v = lo + (hi - lo) * f;
    svg.append(s('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }), s('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, fmtK(v)));
  }
  svg.append(s('polyline', { class: 'line-main', points: vals.map((v, i) => `${x(i)},${y(v)}`).join(' '), fill: 'none' }));
  history.forEach((p, i) => svg.append(s('circle', { class: 'dot', cx: x(i), cy: y(vals[i]), r: 3.5 }, s('title', {}, `${fmtDate(p.date)}: ${fmtSek(p.assets - p.liabilities)}`))));
  svg.append(s('text', { x: pad.l, y: H - 6 }, fmtDate(history[0].date)), s('text', { x: W - pad.r, y: H - 6, 'text-anchor': 'end' }, fmtDate(history.at(-1).date)));
  return h('div', { class: 'table-wrap' }, svg);
}

export async function renderBalance(root) {
  const r = await get('/api/reports/balance');
  const side = (title, rows, total) =>
    h(
      'div',
      { class: 'card flush' },
      dataTable({
        empty: `Inga ${title.toLowerCase()}.`,
        rows,
        columns: [
          { label: title, render: (l) => h('div', {}, l.name, h('div', { class: 'small muted' }, l.kind_label, l.stale ? ' · gammal kurs' : '')) },
          { label: 'Belopp', num: true, render: (l) => fmtSekExact(l.amount) },
        ],
        footer: (c, i) => (i === 0 ? h('strong', {}, `Summa ${title.toLowerCase()}`) : h('strong', {}, fmtSekExact(total))),
      }),
    );
  setKids(
    root,
    h('div', { class: 'row between' }, h('h1', {}, 'Balansrapport'), h('button', { class: 'btn no-print', type: 'button', onclick: () => window.print() }, 'Skriv ut')),
    h('p', { class: 'muted' }, `Per ${fmtDate(r.date)}`),
    r.unpriced.length ? h('div', { class: 'alert warn' }, `${r.unpriced.length} innehav saknar kurs och är inte med: ${r.unpriced.map((u) => u.name).join(', ')}. Eget kapital är därför för lågt. `, h('a', { href: '#/innehav' }, 'Åtgärda'), '.') : null,
    h('div', { class: 'kpis' }, kpi('Tillgångar', fmtSek(r.total_assets)), kpi('Skulder', fmtSek(r.total_liabilities)), kpi('Eget kapital', fmtSek(r.equity), 'tillgångar − skulder', r.equity < 0 ? 'neg' : '')),
    h('div', { class: 'two-col' }, side('Tillgångar', r.assets, r.total_assets), side('Skulder', r.liabilities, r.total_liabilities)),
    r.history.length > 1 ? [h('h2', { class: 'mt-l' }, 'Utveckling'), h('div', { class: 'card flush' }, historyChart(r.history))] : h('p', { class: 'muted small' }, 'En ögonblicksbild sparas varje dag du öppnar rapporten. Efter några dagar visas utvecklingen här.'),
    h('p', { class: 'muted small' }, 'Kontosaldon är ingångsvärde plus importerade transaktioner. Värdepapper värderas till senaste kända kurs. Bostad, bil och annat som inte är konton läggs till som "Annan tillgång" under Konton.'),
  );
}
