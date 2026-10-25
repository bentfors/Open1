import { s, h, fmtK, fmtDate } from '../dom.js';

const MONTHS = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', month: 'short', year: 'numeric' });
const fmtYm = (ym) => MONTHS.format(new Date(`${ym}-01T00:00:00Z`));

/**
 * Linjediagram för flera serier över månader. series: [{ key, label, className, values: öre[] }], months: 'ÅÅÅÅ-MM'[].
 * Varje punkt har en title med exakt värde, så uppgifterna finns kvar för skärmläsare och som tooltip.
 */
export function lineChart({ months, series, label }) {
  const W = 920;
  const H = 280;
  const pad = { l: 72, r: 14, t: 14, b: 30 };
  const all = series.flatMap((x) => x.values).map((v) => v / 100);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  // Runda axeln till jämna steg (1, 2 eller 5 gånger en tiopotens) så att etiketterna blir läsbara.
  const raw = (max - min || 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step || step;
  const n = months.length;
  const x = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (kr) => pad.t + (H - pad.t - pad.b) * (1 - (kr - lo) / (hi - lo));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  for (let v = lo; v <= hi + step / 2; v += step) {
    svg.append(s('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }), s('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, fmtK(v)));
  }
  if (lo < 0) svg.append(s('line', { class: 'zero-line', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) }));
  const yearTicks = months.map((m, i) => [m, i]).filter(([m, i]) => m.endsWith('-01') || i === 0);
  const every = Math.ceil(yearTicks.length / 8);
  yearTicks.forEach(([m, i], k) => {
    if (k % every === 0) svg.append(s('text', { x: x(i), y: H - 10, 'text-anchor': 'middle' }, m.slice(0, 4)));
  });
  for (const ser of series) {
    svg.append(s('polyline', { class: `line ${ser.className}`, fill: 'none', points: ser.values.map((v, i) => `${x(i)},${y(v / 100)}`).join(' ') }));
  }
  // Osynliga träffytor per månad med tooltip över alla serier
  const bw = (W - pad.l - pad.r) / Math.max(1, n - 1);
  months.forEach((m, i) => {
    svg.append(s('rect', { x: x(i) - bw / 2, y: pad.t, width: bw, height: H - pad.t - pad.b, fill: 'transparent' }, s('title', {}, `${fmtYm(m)}\n${series.map((ser) => `${ser.label}: ${Math.round(ser.values[i] / 100).toLocaleString('sv-SE')} kr`).join('\n')}`)));
  });
  return h(
    'div',
    {},
    h('div', { class: 'table-wrap' }, svg),
    h('div', { class: 'chart-legend' }, series.map((ser) => h('span', { class: `lg ${ser.className}` }, ser.label))),
  );
}

export { fmtDate };
