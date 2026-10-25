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
 *
 * Tre regler gäller alla beräkningar, och den som får provisionen kan aldrig få mindre än 0:
 *  - Bara attesterad tid räknas.
 *  - En enskild konsult får bidra med negativ TB. Bidragen summeras per regel och period.
 *  - Summan per regel och period golvas vid 0. Negativt på en regel kvittas inte mot en annan.
 *  - En konsult utan någon debiterbar tid ("bänk") räknas bara som negativ för de första
 *    bench_cap_hours timmarna i sträck. Därefter bidrar hen med 0 tills hen har debiterbar tid igen.
 *    En dag med minst en debiterbar timme räknas som uppdrag och nollställer räknaren.
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
  // floor_zero finns kvar i tabellen men används inte: golvet vid 0 gäller alltid.
  return rules.map(({ floor_zero, ...r }) => ({
    ...r,
    tiers: parseTiers(r.tiers),
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
 * Källan till siffrorna bakom en provisionsberäkning. Utfallet läser attesterad tid ur databasen.
 * Prognosen (forecast.js) ger samma tre funktioner men simulerar från avtal. All annan logik delas.
 */
export function actualProvider(db) {
  const settings = getSettings(db);
  const worked = settings.tb_cost_basis === 'billable' ? 0 : 1;
  const capMinutes = settings.bench_cap_hours === null ? null : settings.bench_cap_hours * 60;

  // En rad per arbetsdag med projekttid. Frånvaro (activity_id saknas) ingår inte.
  const dailyStmt = db.prepare(
    `SELECT te.work_date AS d,
            SUM(CASE WHEN te.billable = 1 THEN te.minutes ELSE 0 END) AS bill_min,
            SUM(CASE WHEN te.billable = 0 THEN te.minutes ELSE 0 END) AS non_min,
            SUM(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
            SUM(CASE WHEN :worked = 1 OR te.billable = 1 THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost
     FROM time_entries te
     WHERE te.user_id = :user AND te.activity_id IS NOT NULL AND te.status = 'approved'
       AND te.work_date BETWEEN :from AND :to
     GROUP BY te.work_date ORDER BY te.work_date`,
  );
  // Odebiterbara minuter sedan konsultens senaste debiterbara dag före perioden. Dessa är redan "förbrukade".
  const carryStmt = db.prepare(
    `SELECT COALESCE(SUM(te.minutes), 0) AS m
     FROM time_entries te
     WHERE te.user_id = :user AND te.activity_id IS NOT NULL AND te.status = 'approved'
       AND te.billable = 0 AND te.work_date < :start
       AND te.work_date > COALESCE((SELECT MAX(work_date) FROM time_entries
                                    WHERE user_id = :user AND activity_id IS NOT NULL AND status = 'approved'
                                      AND billable = 1 AND work_date < :start), '0000-01-01')`,
  );
  const consultantCount = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT te.user_id
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.billable = 1 AND te.activity_id IS NOT NULL AND te.status = 'approved'
         AND te.work_date BETWEEN :from AND :to
         AND (NOT EXISTS (SELECT 1 FROM commission_rule_categories WHERE rule_id = :rule)
              OR u.category_id IN (SELECT category_id FROM commission_rule_categories WHERE rule_id = :rule))
       GROUP BY te.user_id HAVING SUM(te.minutes) > :minMinutes
     )`,
  );

  return {
    sources: (rule) => rule.sources,
    carry: (userId, start) => carryStmt.get({ user: userId, start }).m,
    // En konsults TB för provision i [start, end], med bänkgränsen tillämpad.
    sourceBasis(userId, start, end) {
      let tb = 0;
      let actual = 0;
      let minutes = 0;
      let billMin = 0;
      let cappedMin = 0;
      let counter = null; // odebiterbara minuter i sträck, hämtas från historiken först när det behövs
      for (const day of dailyStmt.all({ user: userId, from: start, to: end, worked })) {
        const dayTb = day.revenue - day.cost;
        minutes += day.bill_min + day.non_min;
        billMin += day.bill_min;
        actual += dayTb;
        if (capMinutes === null) {
          tb += dayTb;
        } else if (day.bill_min > 0) {
          counter = 0; // i uppdrag: räknaren börjar om och hela dagen räknas
          tb += dayTb;
        } else {
          if (counter === null) counter = carryStmt.get({ user: userId, start }).m;
          const counted = Math.max(0, Math.min(day.non_min, capMinutes - counter));
          counter += day.non_min;
          tb += dayTb * (counted / day.non_min);
          cappedMin += day.non_min - counted;
        }
      }
      return { tb, actual, minutes, billMin, cappedMin };
    },
    consultantCount: (rule, start, end) =>
      consultantCount.get({ from: start, to: end, rule: rule.id, minMinutes: rule.min_hours * 60 }).n,
  };
}

/**
 * Räknar provision för alla perioder som överlappar [from, to]. Perioden räknas alltid hel,
 * även om intervallet bara täcker en del av den, och markeras som ofullständig tills den är slut.
 * Utan egen provider ingår bara attesterad tid.
 */
export function computeCommissions(db, { from, to, earnerId = null, provider = actualProvider(db) }) {
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
        tb_actual: null,
        capped_hours: 0,
        percent: null,
        consultants: null,
        amount_per_consultant: null,
        sources: [],
        months: [],
        raw_commission: 0,
        floored: false,
        commission: 0,
      };

      const needsTb = rule.kind !== 'per_consultant';
      const needsCount = rule.kind !== 'tb_percent';

      if (needsTb) {
        row.sources = provider.sources(rule).map((src) => {
          const b = provider.sourceBasis(src.id, start, end);
          return {
            user_id: src.id,
            name: src.name,
            hours: round2(b.minutes / 60),
            tb: round2(b.tb),
            tb_actual: round2(b.actual),
            capped_hours: round2(b.cappedMin / 60),
          };
        });
        row.tb = round2(row.sources.reduce((sum, x) => sum + x.tb, 0));
        row.tb_actual = round2(row.sources.reduce((sum, x) => sum + x.tb_actual, 0));
        row.capped_hours = round2(row.sources.reduce((sum, x) => sum + x.capped_hours, 0));
      }
      if (needsCount) {
        row.months = monthWindows(start, end).map((w) => ({
          month: w.start.slice(0, 7),
          consultants: provider.consultantCount(rule, w.start, w.end),
        }));
      }

      let raw;
      if (rule.kind === 'tb_percent') {
        row.percent = rule.percent;
        raw = (row.tb * rule.percent) / 100;
      } else if (rule.kind === 'per_consultant') {
        row.consultants = row.months.reduce((sum, m) => sum + m.consultants, 0);
        row.amount_per_consultant = rule.amount;
        raw = row.consultants * rule.amount;
      } else {
        const avg = row.months.length ? Math.round(row.months.reduce((s, m) => s + m.consultants, 0) / row.months.length) : 0;
        row.consultants = avg;
        row.percent = tierPercent(rule.tiers, avg);
        raw = (row.tb * row.percent) / 100;
      }
      row.raw_commission = round2(raw);
      row.floored = raw < 0;
      row.commission = round2(Math.max(0, raw));
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
