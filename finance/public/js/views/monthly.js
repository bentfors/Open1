import { get } from '../api.js';
import { h, setKids, dataTable, fmtSek, fmtSekExact, fmtPct, fmtDate, fmtMonth, localToday } from '../dom.js';

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
export const lastCompleteMonth = () => shiftMonth(localToday().slice(0, 7), -1);

const GOAL_STATUS = { reached: 'Uppnått', on_track: 'På rätt väg', behind: 'Efter plan', overdue: 'Datumet har passerat' };

export function insightList(items, { empty } = {}) {
  if (!items.length) return empty ? h('p', { class: 'muted' }, empty) : null;
  const order = { warn: 0, info: 1, ok: 2 };
  return h('div', { class: 'insights' }, [...items].sort((a, b) => order[a.level] - order[b.level]).map((i) =>
    h('div', { class: `alert ${i.level === 'warn' ? 'warn' : i.level === 'ok' ? 'ok' : ''}` }, h('strong', {}, i.title), ' ', i.text)));
}

/** Själva rapporten. Används både av användaren själv och av rådgivarvyn. */
export function reportBody(r, { forAdvisor = false, withInsights = true } = {}) {
  const res = r.result;
  const vsAvg = r.previous ? res.expense - r.previous.expense_avg : null;
  const client = r.insights.filter((i) => i.audience === 'client');
  const advisor = r.insights.filter((i) => i.audience === 'advisor');
  return h('div', {},
    h('div', { class: 'kpis' },
      kpi('Inkomster', fmtSek(res.income), r.previous ? `snitt tidigare ${fmtSek(r.previous.income_avg)}` : '', 'pos'),
      kpi('Utgifter', fmtSek(res.expense), vsAvg === null ? '' : `${vsAvg > 0 ? '+' : ''}${fmtSek(vsAvg)} mot snittet (${fmtSek(r.previous.expense_avg)})`),
      kpi('Resultat', fmtSek(res.net), '', res.net < 0 ? 'neg' : 'pos'),
      kpi('Sparkvot', fmtPct(res.savings_rate), 'resultat / inkomster')),

    withInsights ? h('h2', {}, forAdvisor ? 'Observationer' : 'Att tänka på') : null,
    withInsights ? insightList(client, { empty: 'Inget särskilt att notera den här månaden.' }) : null,
    withInsights && advisor.length ? [h('h2', { class: 'mt-l' }, forAdvisor ? 'Samtalspunkter' : 'Att ta upp med rådgivaren'), h('p', { class: 'muted small' }, 'Iakttagelser ur siffrorna, inte rekommendationer. Tumregler och kan bero på att uppgifter saknas i appen.'), insightList(advisor)] : null,

    r.top_changes.length ? [h('h2', { class: 'mt-l' }, 'Största förändringarna i utgifter'), h('div', { class: 'card flush' }, dataTable({
      rows: r.top_changes,
      columns: [
        { label: 'Kategori', render: (c) => c.category },
        { label: 'Den här månaden', num: true, render: (c) => fmtSekExact(c.amount) },
        { label: 'Snitt tidigare', num: true, render: (c) => fmtSekExact(c.prior_avg) },
        { label: 'Förändring', num: true, render: (c) => h('span', { class: c.delta > 0 ? 'neg' : 'pos' }, `${c.delta > 0 ? '+' : ''}${fmtSekExact(c.delta)}${c.delta_pct === null ? '' : ` (${c.delta > 0 ? '+' : ''}${fmtPct(c.delta_pct)})`}`) },
      ],
    }))] : null,

    r.budget.has ? [h('h2', { class: 'mt-l' }, 'Budget mot utfall'), h('div', { class: 'card flush' }, dataTable({
      rows: r.budget.lines,
      columns: [
        { label: 'Kategori', render: (l) => l.category },
        { label: 'Budget', num: true, render: (l) => fmtSekExact(l.budget) },
        { label: 'Utfall', num: true, render: (l) => fmtSekExact(l.actual) },
        { label: 'Avvikelse', num: true, render: (l) => { const d = l.kind === 'expense' ? l.budget - l.actual : l.actual - l.budget; return h('span', { class: d < 0 ? 'neg' : 'pos' }, fmtSekExact(d)); } },
      ],
    }))] : null,

    h('div', { class: 'two-col mt-l' },
      h('div', {}, h('h2', {}, 'Inkomster'), h('div', { class: 'card flush' }, dataTable({ empty: 'Inga inkomster.', rows: r.income_lines, columns: [{ label: 'Kategori', render: (l) => l.category }, { label: 'Belopp', num: true, render: (l) => fmtSekExact(l.amount) }] }))),
      h('div', {}, h('h2', {}, 'Utgifter'), h('div', { class: 'card flush' }, dataTable({ empty: 'Inga utgifter.', rows: r.expense_lines, columns: [{ label: 'Kategori', render: (l) => l.category }, { label: 'Belopp', num: true, render: (l) => fmtSekExact(l.amount) }, { label: 'Andel', num: true, render: (l) => fmtPct(res.expense ? l.amount / res.expense : 0) }] })))),

    h('h2', { class: 'mt-l' }, 'Läget idag'),
    h('div', { class: 'kpis' },
      kpi('Kontanter', fmtSek(r.balance.cash)),
      kpi('Placeringar', fmtSek(r.balance.invested)),
      kpi('Skulder', fmtSek(r.balance.debts)),
      kpi('Eget kapital', fmtSek(r.balance.equity), 'inklusive övriga tillgångar', r.balance.equity < 0 ? 'neg' : '')),

    r.goals.length ? [h('h2', { class: 'mt-l' }, 'Mål'), h('div', { class: 'card flush' }, dataTable({
      rows: r.goals,
      columns: [
        { label: 'Mål', render: (g) => g.name },
        { label: 'Sparat', num: true, render: (g) => `${fmtSek(g.current)} av ${fmtSek(g.target_amount)}` },
        { label: 'Datum', render: (g) => fmtDate(g.target_date) },
        { label: 'Krävs per månad', num: true, render: (g) => (g.status === 'reached' ? '–' : fmtSek(g.needed_monthly)) },
        { label: 'Status', render: (g) => h('span', { class: `chip ${g.status === 'on_track' || g.status === 'reached' ? 'approved' : g.status === 'overdue' ? 'rejected' : 'warn'}` }, GOAL_STATUS[g.status]) },
      ],
    }))] : null,

    h('p', { class: 'muted small mt-m' }, 'Rapporten bygger på de kontoutdrag som är importerade och kategoriserade. Resultatet räknas utan överföringar mellan egna konton, sparande och amorteringar. "Läget idag" är dagens saldon och kurser, inte månadens slut.'),
  );
}

export async function renderMonthly(root) {
  let month = lastCompleteMonth();
  const mount = h('div');
  setKids(root, mount);

  async function load() {
    const r = await get(`/api/report/monthly?month=${month}`);
    setKids(
      mount,
      h('div', { class: 'row between' },
        h('h1', {}, 'Månadsrapport'),
        h('button', { class: 'btn no-print', type: 'button', onclick: () => window.print() }, 'Skriv ut / spara som PDF')),
      h('div', { class: 'row no-print' },
        h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Föregående månad', onclick: () => ((month = shiftMonth(month, -1)), load()) }, '←'),
        h('strong', {}, fmtMonth(month)),
        h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Nästa månad', disabled: month >= lastCompleteMonth(), onclick: () => ((month = shiftMonth(month, 1)), load()) }, '→')),
      h('div', { class: 'mt-m' }, reportBody(r)),
    );
  }
  await load();
}
