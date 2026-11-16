import { addDays, isoWeek, previousMonthEnd, today } from './dates.js';
import { approverClause, approverParams, getSettings, holidayOptions, isAdmin, isFinance, isFinanceSuper, round2 } from './domain.js';
import { holidaysBetween } from './holidays.js';
import { submissionStatus } from './oversight.js';
import { ITEMS_CTE } from './billing.js';
import { payrollBasis } from './payroll.js';
import { contractWarnings } from './warnings.js';

/**
 * Startsidan: det var och en behöver göra, samlat. Bara de delar som gäller användaren skickas med.
 *  - me: egen tid den här veckan och veckor som inte är inskickade, avslagna rader.
 *  - approvals: att attestera.
 *  - team: inrapporteringen för dem man följer upp (BM, chef) eller alla (ekonomi).
 *  - expiring: uppdrag som tar slut för ens konsulter.
 *  - billing, lock, payroll: ekonomins månadsrutiner för förra månaden.
 *  - warnings: luckor i avtalsregistret.
 */
const LATE = ['missing', 'draft', 'rejected'];

const KINDS = {
  time: `time_entries x JOIN users u ON u.id = x.user_id LEFT JOIN activities a ON a.id = x.activity_id LEFT JOIN projects p ON p.id = a.project_id`,
  expense: `expenses x JOIN users u ON u.id = x.user_id LEFT JOIN projects p ON p.id = x.project_id`,
  mileage: `mileage x JOIN users u ON u.id = x.user_id LEFT JOIN projects p ON p.id = x.project_id`,
};

export function buildOverview(db, user) {
  const t = today();
  const settings = getSettings(db);
  const out = { today: t };

  // Inrapporteringen för fem veckor: den egna raden och, för den som följer upp andra, deras.
  const sub = submissionStatus(db, user, { to: t, weeks: 5 });
  const me = sub.people.find((p) => p.id === user.id);
  if (me) {
    const cells = me.weeks.map((c, i) => ({ ...c, week: sub.weeks[i].week, current: sub.weeks[i].current }));
    out.me = {
      this_week: cells.at(-1),
      late: cells.filter((c) => !c.current && LATE.includes(c.status)),
    };
  }
  const rejected = {
    time: db.prepare("SELECT COUNT(*) AS n FROM time_entries WHERE user_id = ? AND status = 'rejected'").get(user.id).n,
    expense: db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND status = 'rejected'").get(user.id).n,
    mileage: db.prepare("SELECT COUNT(*) AS n FROM mileage WHERE user_id = ? AND status = 'rejected'").get(user.id).n,
  };
  if (rejected.time || rejected.expense || rejected.mileage) out.rejected = rejected;

  // Att attestera, med samma regler som attestvyn.
  const params = approverParams(user);
  const approvals = {};
  for (const [kind, from] of Object.entries(KINDS)) {
    const status = "x.status = 'submitted'";
    approvals[kind] = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${status} AND ${approverClause({ entry: 'x', bm: true })}`).get(params).n;
  }
  const approvalTotal = approvals.time + approvals.expense + approvals.mileage;
  if (approvalTotal) out.approvals = { ...approvals, total: approvalTotal };

  // De man följer upp: alla utom en själv.
  const others = sub.people.filter((p) => p.id !== user.id);
  if (others.length) {
    const late = others
      .map((p) => ({ name: p.name, weeks: p.weeks.map((c, i) => ({ ...c, week: sub.weeks[i].week, current: sub.weeks[i].current })).filter((c) => !c.current && LATE.includes(c.status)) }))
      .filter((p) => p.weeks.length);
    const counts = { missing: 0, draft: 0, rejected: 0, submitted: 0 };
    for (const p of others) p.weeks.forEach((c, i) => { if (!sub.weeks[i].current && Object.hasOwn(counts, c.status)) counts[c.status]++; });
    out.team = { people: others.length, counts, late: late.slice(0, 8), late_people: late.length, scope: isFinance(user) ? 'all' : 'mine' };
  }

  const expiring = db
    .prepare(
      `SELECT u.name, c.name AS customer, a.end_date FROM assignments a JOIN users u ON u.id = a.user_id JOIN customers c ON c.id = a.customer_id
       WHERE u.bm_id = ? AND u.active = 1 AND a.end_date BETWEEN ? AND ? ORDER BY a.end_date LIMIT 6`,
    )
    .all(user.id, t, addDays(t, 60));
  if (expiring.length) out.expiring = expiring;

  if (isFinance(user)) {
    const month = previousMonthEnd(t).slice(0, 7);
    const to = previousMonthEnd(t);
    const from = `${month}-01`;
    const b = db
      .prepare(
        `${ITEMS_CTE}
         SELECT
           COALESCE(SUM(CASE WHEN i.status = 'approved' AND i.billable = 1 AND i.invoice_id IS NULL AND i.waived_at IS NULL
                             AND NOT (i.kind = 'time' AND i.billing_type <> 'hourly') AND i.date <= :to THEN i.amount END), 0) AS ready,
           COALESCE(SUM(CASE WHEN i.status IN ('open','submitted') AND i.billable = 1 AND i.invoice_id IS NULL AND i.waived_at IS NULL
                             AND NOT (i.kind = 'time' AND i.billing_type <> 'hourly') AND i.date BETWEEN :from AND :to THEN i.amount END), 0) AS waiting
         FROM items i`,
      )
      .get({ from, to });
    out.billing = { month, ready: round2(b.ready), waiting: round2(b.waiting) };
    out.lock = { locked_until: settings.locked_until || null, month_end: to, behind: !settings.locked_until || settings.locked_until < to };
  }
  if (isFinanceSuper(user)) {
    const p = payrollBasis(db, { from: `${previousMonthEnd(t).slice(0, 7)}-01`, to: previousMonthEnd(t) });
    out.payroll = { month: previousMonthEnd(t).slice(0, 7), people: p.rows.length, pending_people: p.totals.pending_people };
    const warnings = contractWarnings(db);
    if (warnings.length) out.warnings = { count: warnings.length, first: warnings.slice(0, 4).map((w) => w.text) };
  }

  const upcoming = holidaysBetween(t, addDays(t, 45), holidayOptions(settings)).filter((x) => {
    const dow = new Date(`${x.date}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  });
  if (upcoming.length) out.next_holiday = { ...upcoming[0], week: isoWeek(upcoming[0].date) };
  out.is_admin = isAdmin(user);
  return out;
}
