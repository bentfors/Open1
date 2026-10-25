import { addDays, addMonths, daysBetween, monthEnd, monthStart, today } from './dates.js';
import { actualProvider, computeCommissions, listRules } from './commission.js';
import { byPayoutMonth, forecast, sumWindow } from './forecast.js';
import { getSettings, round2 } from './domain.js';

const EXPIRING_DAYS = 120;

const sumCommission = (rows) => round2(rows.reduce((s, r) => s + r.commission, 0));

/**
 * Allt en mottagare (BM, AM, TA …) behöver se om sig själv: konsulter, utfall, prognos och uppdrag som löper ut.
 * Konsulter är de man är BM för plus de vars TB ingår i ens regler.
 */
export function buildStats(db, earnerId, { months = 12 } = {}) {
  const earner = db
    .prepare('SELECT u.id, u.name, c.name AS category FROM users u LEFT JOIN categories c ON c.id = u.category_id WHERE u.id = ?')
    .get(earnerId);
  if (!earner) return null;

  const t = today();
  const settings = getSettings(db);
  const rules = listRules(db, { earnerId });
  const actual = actualProvider(db);

  // Konsulter och hur de hänger ihop med mottagaren
  const relation = new Map();
  const tag = (id, text) => relation.set(id, [...(relation.get(id) ?? []), text]);
  for (const r of db.prepare('SELECT id FROM users WHERE bm_id = ? AND active = 1').all(earnerId)) tag(r.id, 'BM');
  for (const rule of rules) for (const s of rule.sources) tag(s.id, rule.name || 'Provisionsregel');
  const consultantIds = [...relation.keys()];

  // Utfall och prognos
  const pastFrom = addMonths(t, -11);
  const pastRows = computeCommissions(db, { from: pastFrom, to: addDays(t, -1), earnerId, provider: actual }).filter((r) => r.complete);
  const toDate = new Map(computeCommissions(db, { from: t, to: t, earnerId, provider: actual }).map((r) => [`${r.rule_id}|${r.period_label}`, r.commission]));
  const fc = forecast(db, { earnerId, months, includeIds: consultantIds });
  const forecastRows = fc.rows.map((r) => ({
    ...r,
    state: r.period_start <= t ? 'running' : 'forecast',
    actual_to_date: toDate.get(`${r.rule_id}|${r.period_label}`) ?? null,
  }));
  const timeline = [...pastRows.map((r) => ({ ...r, state: 'actual' })), ...forecastRows];

  const actualByMonth = byPayoutMonth(pastRows, pastFrom, fc.horizonEnd);
  const forecastByMonth = byPayoutMonth(forecastRows, pastFrom, fc.horizonEnd);
  const monthsOut = [...actualByMonth.keys()].map((m) => ({ month: m, actual: actualByMonth.get(m), forecast: forecastByMonth.get(m) }));

  // Konsulterna
  const people = consultantIds.length
    ? db
        .prepare(
          `SELECT u.id, u.name, u.weekly_hours, c.name AS category FROM users u LEFT JOIN categories c ON c.id = u.category_id
           WHERE u.id IN (${consultantIds.map(() => '?').join(',')}) ORDER BY u.name`,
        )
        .all(...consultantIds)
    : [];
  const employments = db.prepare('SELECT * FROM employments WHERE user_id = ? ORDER BY start_date DESC');
  const assignments = db.prepare(
    `SELECT a.id, a.title, a.start_date, a.end_date, a.hourly_rate, a.hours_per_week, c.name AS customer_name, p.code AS project_code
     FROM assignments a JOIN customers c ON c.id = a.customer_id LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.user_id = ? AND (a.end_date IS NULL OR a.end_date >= ?) ORDER BY a.start_date`,
  );
  const prevStart = addMonths(t, -1);
  const prevEnd = monthEnd(prevStart);
  const next3End = monthEnd(addMonths(t, 2));
  const warnings = [];

  const consultants = people.map((p) => {
    const emps = employments.all(p.id);
    const emp = emps.find((e) => e.start_date <= t && (!e.end_date || e.end_date >= t)) ?? emps[0] ?? null;
    const list = assignments.all(p.id, t).map((a) => ({ ...a, days_left: a.end_date ? daysBetween(t, a.end_date) : null }));
    const inAssignment = list.some((a) => a.start_date <= t);
    const last = actual.sourceBasis(p.id, prevStart, prevEnd);
    const sofar = actual.sourceBasis(p.id, monthStart(t), t);
    if (!list.length) warnings.push(`${p.name} har inget pågående eller kommande uppdrag i avtalsregistret. Prognosen räknar med bänktid.`);
    if (!emp) warnings.push(`${p.name} saknar anställningsavtal i registret. Prognosen antar tillsvidareanställning.`);
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      relation: relation.get(p.id),
      employment: emp && { type: emp.type, start_date: emp.start_date, end_date: emp.end_date, notice_months: emp.notice_months, tenure_days: daysBetween(emp.start_date, emp.end_date && emp.end_date < t ? emp.end_date : t) },
      assignments: list,
      in_assignment_now: inAssignment,
      bench_hours: round2(actual.carry(p.id, t) / 60),
      last_month: { hours: round2(last.minutes / 60), billable_hours: round2(last.billMin / 60), tb: round2(last.tb) },
      this_month: { tb: round2(sofar.tb) },
      forecast_tb_3m: round2(sumWindow(fc.sim.get(p.id), monthStart(t), next3End).tb),
    };
  });

  // Uppdrag som tar slut, och vad de är värda för mottagaren
  const baseTotal = sumCommission(forecastRows);
  const expiring = [];
  for (const c of consultants) {
    for (const a of c.assignments) {
      if (a.end_date && a.days_left <= EXPIRING_DAYS && expiring.length < 10) {
        const without = forecast(db, { earnerId, months, excludeAssignmentIds: [a.id], includeIds: consultantIds });
        expiring.push({
          assignment_id: a.id,
          consultant: c.name,
          customer: a.customer_name,
          project_code: a.project_code,
          title: a.title,
          end_date: a.end_date,
          days_left: a.days_left,
          at_risk: round2(baseTotal - sumCommission(without.rows)),
        });
      }
    }
  }
  expiring.sort((a, b) => a.days_left - b.days_left);

  const yearStart = `${t.slice(0, 4)}-01-01`;
  return {
    as_of: t,
    earner,
    rules: rules.map((r) => ({ id: r.id, name: r.name, kind: r.kind, period: r.period })),
    horizon_months: months,
    utilization: settings.forecast_utilization,
    bench_cap_hours: settings.bench_cap_hours,
    kpis: {
      consultants: consultants.length,
      in_assignment: consultants.filter((c) => c.in_assignment_now).length,
      tb_last_month: round2(consultants.reduce((s, c) => s + c.last_month.tb, 0)),
      commission_ytd: sumCommission(pastRows.filter((r) => r.period_end >= yearStart)),
      forecast_total: baseTotal,
      expiring: expiring.length,
      company_in_assignment: db
        .prepare(
          `SELECT COUNT(DISTINCT a.user_id) AS n FROM assignments a JOIN users u ON u.id = a.user_id
           WHERE u.active = 1 AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date >= ?)`,
        )
        .get(t, t).n,
    },
    months: monthsOut,
    timeline,
    consultants,
    expiring,
    warnings,
  };
}

/**
 * Vad skulle en ny konsult ge? De tänkta konsulterna läggs till i mottagarens TB-regler och räknas med
 * i regler som räknar antal konsulter. Resultatet jämförs med prognosen utan dem.
 */
export function scenario(db, earnerId, { count, rate, cost, hours_per_week, start, end, months }) {
  const t = today();
  const base = forecast(db, { earnerId, months });
  const virtual = Array.from({ length: count }, (_, i) => ({ name: `Ny konsult ${i + 1}`, rate, cost, hours_per_week, start, end }));
  const withNew = forecast(db, { earnerId, months, virtual });

  const from = monthStart(t);
  const baseline = byPayoutMonth(base.rows, from, base.horizonEnd);
  const scen = byPayoutMonth(withNew.rows, from, base.horizonEnd);
  const monthsOut = [...baseline.keys()].map((m) => ({ month: m, baseline: baseline.get(m), scenario: scen.get(m), delta: round2(scen.get(m) - baseline.get(m)) }));

  // Perioder där en tröskel passeras, till exempel ett högre trappsteg
  const before = new Map(base.rows.map((r) => [`${r.rule_id}|${r.period_label}`, r]));
  const steps = withNew.rows
    .filter((r) => r.kind === 'tb_tiered' && before.get(`${r.rule_id}|${r.period_label}`)?.percent !== r.percent)
    .map((r) => ({ rule: r.rule_name, period: r.period_label, from: before.get(`${r.rule_id}|${r.period_label}`).percent, to: r.percent }));

  return {
    months: monthsOut,
    baseline_total: sumCommission(base.rows),
    scenario_total: sumCommission(withNew.rows),
    delta_total: round2(sumCommission(withNew.rows) - sumCommission(base.rows)),
    tier_steps: steps,
    has_rules: base.rows.length > 0 || withNew.rows.length > 0,
  };
}
