import { periods, monthWindows, today } from './dates.js';
import { getSettings, round2 } from './domain.js';

/**
 * Provisionsregler. En regel hör till en mottagare och räknas per kalendermånad eller kvartal.
 *
 *  tb_percent      procent av TB för angivna konsulter (källor)
 *  per_consultant  fast belopp × antal konsulter i uppdrag (summerat över månaderna i perioden)
 *  tb_tiered       procent av källornas TB, där procenten väljs av genomsnittligt antal konsulter i uppdrag
 *
 * En konsult är "i uppdrag" en månad om hen har mer än min_hours debiterbara timmar den månaden.
 * Kategorier på regeln begränsar vilka som räknas. Ingen vald kategori betyder alla.
 * TB per tidspost = debiterbar intäkt − kostnad (se inställningen tb_cost_basis). Frånvaro räknas inte.
 */

export function parseTiers(raw) {
  try {
    const t = JSON.parse(raw || '[]');
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

export function listRules(db, { earnerId = null, ruleId = null } = {}) {
  const rules = db
    .prepare(
      `SELECT r.*, u.name AS earner_name, c.name AS earner_category
       FROM commission_rules r
       JOIN users u ON u.id = r.earner_id
       LEFT JOIN categories c ON c.id = u.category_id
       WHERE (:earner IS NULL OR r.earner_id = :earner) AND (:rule IS NULL OR r.id = :rule)
       ORDER BY u.name, r.id`,
    )
    .all({ earner: earnerId, rule: ruleId });
  const sources = db.prepare(
    `SELECT s.user_id AS id, u.name FROM commission_rule_sources s JOIN users u ON u.id = s.user_id
     WHERE s.rule_id = ? ORDER BY u.name`,
  );
  const cats = db.prepare(
    `SELECT rc.category_id AS id, c.name FROM commission_rule_categories rc JOIN categories c ON c.id = rc.category_id
     WHERE rc.rule_id = ? ORDER BY c.sort, c.name`,
  );
  return rules.map((r) => ({
    ...r,
    tiers: parseTiers(r.tiers),
    floor_zero: !!r.floor_zero,
    sources: sources.all(r.id),
    categories: cats.all(r.id),
  }));
}

const tierPercent = (tiers, n) => {
  let percent = 0;
  for (const t of [...tiers].sort((a, b) => a.min - b.min)) if (n >= t.min) percent = t.percent;
  return percent;
};

const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);

/**
 * Räknar provision för alla perioder som överlappar [from, to]. Perioden räknas alltid hel,
 * även om intervallet bara täcker en del av den, och markeras som ofullständig tills den är slut.
 */
export function computeCommissions(db, { from, to, approvedOnly = true, earnerId = null }) {
  const worked = getSettings(db).tb_cost_basis === 'billable' ? 0 : 1;
  const statusSql = approvedOnly ? `te.status = 'approved'` : `te.status IN ('open','submitted','approved')`;

  const tbBySource = db.prepare(
    `SELECT te.user_id AS user_id, u.name AS name,
            SUM(te.minutes) AS minutes,
            SUM(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
            SUM(CASE WHEN :worked = 1 OR te.billable = 1 THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost
     FROM time_entries te JOIN users u ON u.id = te.user_id
     WHERE te.activity_id IS NOT NULL AND ${statusSql}
       AND te.work_date BETWEEN :from AND :to
       AND te.user_id IN (SELECT user_id FROM commission_rule_sources WHERE rule_id = :rule)
     GROUP BY te.user_id ORDER BY u.name`,
  );
  const consultantCount = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT te.user_id
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.billable = 1 AND te.activity_id IS NOT NULL AND ${statusSql}
         AND te.work_date BETWEEN :from AND :to
         AND (NOT EXISTS (SELECT 1 FROM commission_rule_categories WHERE rule_id = :rule)
              OR u.category_id IN (SELECT category_id FROM commission_rule_categories WHERE rule_id = :rule))
       GROUP BY te.user_id HAVING SUM(te.minutes) > :minMinutes
     )`,
  );

  const now = today();
  const rows = [];
  for (const rule of listRules(db, { earnerId })) {
    for (const period of periods(from, to, rule.period)) {
      const start = rule.valid_from ? max(period.start, rule.valid_from) : period.start;
      const end = rule.valid_to ? min(period.end, rule.valid_to) : period.end;
      if (start > end) continue;

      const row = {
        rule_id: rule.id,
        rule_name: rule.name,
        kind: rule.kind,
        period_type: rule.period,
        period_label: period.label,
        period_start: period.start,
        period_end: period.end,
        complete: period.end < now,
        earner_id: rule.earner_id,
        earner_name: rule.earner_name,
        earner_category: rule.earner_category,
        tb: null,
        percent: null,
        consultants: null,
        amount_per_consultant: null,
        sources: [],
        months: [],
        commission: 0,
      };

      const needsTb = rule.kind !== 'per_consultant';
      const needsCount = rule.kind !== 'tb_percent';

      if (needsTb) {
        row.sources = tbBySource
          .all({ worked, from: start, to: end, rule: rule.id })
          .map((s) => ({ user_id: s.user_id, name: s.name, hours: round2(s.minutes / 60), tb: round2(s.revenue - s.cost) }));
        row.tb = round2(row.sources.reduce((sum, s) => sum + s.tb, 0));
      }
      if (needsCount) {
        row.months = monthWindows(start, end).map((w) => ({
          month: w.start.slice(0, 7),
          consultants: consultantCount.get({ from: w.start, to: w.end, rule: rule.id, minMinutes: rule.min_hours * 60 }).n,
        }));
      }

      if (rule.kind === 'tb_percent') {
        row.percent = rule.percent;
        row.commission = (row.tb * rule.percent) / 100;
      } else if (rule.kind === 'per_consultant') {
        row.consultants = row.months.reduce((sum, m) => sum + m.consultants, 0);
        row.amount_per_consultant = rule.amount;
        row.commission = row.consultants * rule.amount;
      } else {
        const avg = row.months.length ? Math.round(row.months.reduce((s, m) => s + m.consultants, 0) / row.months.length) : 0;
        row.consultants = avg;
        row.percent = tierPercent(rule.tiers, avg);
        row.commission = (row.tb * row.percent) / 100;
      }
      if (rule.floor_zero && row.commission < 0) row.commission = 0;
      row.commission = round2(row.commission);
      rows.push(row);
    }
  }
  return rows;
}

export function summarizeEarners(rows) {
  const earners = new Map();
  for (const r of rows) {
    const e = earners.get(r.earner_id) ?? { earner_id: r.earner_id, name: r.earner_name, category: r.earner_category, commission: 0 };
    e.commission = round2(e.commission + r.commission);
    earners.set(r.earner_id, e);
  }
  return [...earners.values()];
}
