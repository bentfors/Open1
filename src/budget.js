import { monthEnd, monthStart, today } from './dates.js';
import { getSettings, round2 } from './domain.js';
import { companyForecast, sumWindow } from './forecast.js';

/**
 * Budget mot utfall och prognos, per månad och kostnadsställe.
 *
 *  - Budget: inlagd per KST och månad (intäkt och TB).
 *  - Utfall: attesterad tid, intäkt = debiterbar tid × pris, TB = intäkt − kostnad enligt inställningen för TB.
 *    Tiden räknas på personens nuvarande kostnadsställe.
 *  - Prognos: avtalsregistret, från innevarande månad och framåt, med samma beläggning och helgdagar som annars.
 *
 * kst: null = alla, 0 = personer utan kostnadsställe, annars kostnadsställets id.
 */
export function budgetView(db, { year, kst }) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const current = today().slice(0, 7);
  const settings = getSettings(db);
  const match = (userKst) => kst === null || (kst === 0 ? userKst == null : userKst === kst);
  const empty = () => ({ revenue: 0, margin: 0 });

  const budget = new Map(months.map((m) => [m, empty()]));
  for (const b of db.prepare('SELECT kst, month, revenue, margin FROM budgets WHERE month BETWEEN ? AND ?').all(months[0], months[11])) {
    if (kst !== null && b.kst !== kst) continue;
    const x = budget.get(b.month);
    if (!x) continue;
    x.revenue += b.revenue;
    x.margin += b.margin;
  }

  const actual = new Map(months.map((m) => [m, { ...empty(), hours: 0 }]));
  const rows = db
    .prepare(
      `SELECT substr(te.work_date, 1, 7) AS month, u.cost_center_id AS kst,
              SUM(CASE WHEN te.billable = 1 THEN te.minutes ELSE 0 END) AS billable_minutes,
              SUM(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
              SUM(CASE WHEN :worked = 1 OR te.billable = 1 THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.activity_id IS NOT NULL AND te.status = 'approved' AND te.work_date BETWEEN :from AND :to
       GROUP BY month, u.cost_center_id`,
    )
    .all({ worked: settings.tb_cost_basis === 'billable' ? 0 : 1, from: `${year}-01-01`, to: `${year}-12-31` });
  for (const r of rows) {
    if (!match(r.kst)) continue;
    const x = actual.get(r.month);
    x.revenue += r.revenue;
    x.margin += r.revenue - r.cost;
    x.hours += r.billable_minutes / 60;
  }

  const forecast = new Map();
  const fcFrom = `${year}-01-01` > monthStart(today()) ? `${year}-01-01` : monthStart(today());
  if (fcFrom <= `${year}-12-31`) {
    const { people, sim } = companyForecast(db, { from: fcFrom, to: `${year}-12-31` });
    const mine = people.filter((p) => match(p.cost_center_id));
    for (const m of months) {
      if (m < current) continue;
      const x = empty();
      for (const p of mine) {
        const s = sumWindow(sim.get(p.id), `${m}-01`, monthEnd(`${m}-01`));
        x.revenue += s.revenue;
        x.margin += s.revenue - s.cost;
      }
      forecast.set(m, x);
    }
  }

  const r2 = (x) => x && { revenue: round2(x.revenue), margin: round2(x.margin), ...(x.hours !== undefined ? { hours: round2(x.hours) } : {}) };
  const out = months.map((m) => {
    const state = m < current ? 'past' : m === current ? 'current' : 'future';
    const a = state === 'future' ? null : r2(actual.get(m));
    const f = state === 'past' ? null : r2(forecast.get(m) ?? empty());
    const outcome = state === 'past' ? a : f;
    const b = r2(budget.get(m));
    return { month: m, state, budget: b, actual: a, forecast: f, outcome, deviation: { revenue: round2(outcome.revenue - b.revenue), margin: round2(outcome.margin - b.margin) } };
  });
  const total = (pick) => {
    const xs = out.map(pick).filter(Boolean);
    return { revenue: round2(xs.reduce((s, x) => s + x.revenue, 0)), margin: round2(xs.reduce((s, x) => s + x.margin, 0)) };
  };
  const totals = { budget: total((r) => r.budget), actual: total((r) => r.actual), outcome: total((r) => r.outcome) };
  totals.deviation = { revenue: round2(totals.outcome.revenue - totals.budget.revenue), margin: round2(totals.outcome.margin - totals.budget.margin) };
  return { year, kst, months: out, totals, utilization: settings.forecast_utilization };
}
