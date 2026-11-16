import { daysBetween, today } from './dates.js';

/**
 * Luckor i registret som gör prognoserna missvisande. Med "konsult" menas här den som har en BM
 * eller ingår i en provisionsregel, eftersom kategorierna kan döpas om fritt.
 */
export function contractWarnings(db) {
  const now = today();
  const warnings = [];
  const consultants = db
    .prepare(
      `SELECT u.id, u.name, u.pay_type FROM users u WHERE u.active = 1 AND (
         u.bm_id IS NOT NULL OR EXISTS (SELECT 1 FROM commission_rule_sources s WHERE s.user_id = u.id))
       ORDER BY u.name`,
    )
    .all();
  for (const c of consultants) {
    const current = db
      .prepare(`SELECT COUNT(*) AS n FROM assignments WHERE user_id = ? AND (end_date IS NULL OR end_date >= ?)`)
      .get(c.id, now).n;
    if (!current) {
      const bench = c.pay_type === 'subcontractor' ? '' : ' Prognosen räknar med bänktid.';
      warnings.push({ type: 'no_assignment', user_id: c.id, text: `${c.name} har inget pågående eller kommande uppdrag.${bench}` });
    }
    // Underkonsulter är inte anställda och ska inte ha något anställningsavtal.
    if (c.pay_type !== 'subcontractor' && !db.prepare('SELECT 1 FROM employments WHERE user_id = ?').get(c.id)) {
      warnings.push({ type: 'no_employment', user_id: c.id, text: `${c.name} saknar anställningsavtal. Prognosen antar tillsvidareanställning.` });
    }
  }
  const outside = db
    .prepare(
      `SELECT a.id, u.name, a.start_date, a.end_date FROM assignments a JOIN users u ON u.id = a.user_id
       WHERE (a.end_date IS NULL OR a.end_date >= ?)
         AND EXISTS (SELECT 1 FROM employments e WHERE e.user_id = a.user_id)
         AND NOT EXISTS (SELECT 1 FROM employments e WHERE e.user_id = a.user_id AND e.start_date <= a.start_date
                         AND (e.end_date IS NULL OR (a.end_date IS NOT NULL AND e.end_date >= a.end_date)))`,
    )
    .all(now);
  for (const o of outside) warnings.push({ type: 'outside_employment', user_id: null, text: `${o.name} har ett uppdrag (${o.start_date} – ${o.end_date ?? 'löpande'}) som inte ryms inom anställningen.` });
  const ending = db
    .prepare(
      `SELECT a.id, u.name, c.name AS customer, a.end_date FROM assignments a JOIN users u ON u.id = a.user_id JOIN customers c ON c.id = a.customer_id
       WHERE a.end_date BETWEEN ? AND date(?, '+90 days') ORDER BY a.end_date`,
    )
    .all(now, now);
  for (const e of ending) warnings.push({ type: 'ending', user_id: null, text: `${e.name}s uppdrag hos ${e.customer} tar slut ${e.end_date} (om ${daysBetween(now, e.end_date)} dagar).` });

  // Uppdragets pris ska vara det som debiteras, annars stämmer varken prognos eller provision med fakturan.
  // Debiterat pris: medlemmens eget pris, annars projektets, annars personens standardpris (aktivitetspriser undantagna).
  const kr = (n) => `${new Intl.NumberFormat('sv-SE').format(n)} kr/tim`;
  const priced = db
    .prepare(
      `SELECT u.name, c.name AS customer, p.code, a.hourly_rate AS agreed,
              COALESCE(pm.hourly_rate, NULLIF(p.hourly_rate, 0), u.default_bill_rate) AS billed
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN customers c ON c.id = a.customer_id
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = a.user_id
       WHERE (a.end_date IS NULL OR a.end_date >= ?) AND p.billing_type = 'hourly'
       ORDER BY u.name`,
    )
    .all(now);
  for (const x of priced) {
    if (Math.abs(x.agreed - x.billed) > 0.005) {
      warnings.push({ type: 'rate_mismatch', user_id: null, text: `${x.name}s uppdrag hos ${x.customer} har ${kr(x.agreed)} i avtalet men debiteras ${kr(x.billed)} i projektet ${x.code}.` });
    }
  }

  // Används kostnadsställen ska alla konsulter ha ett, annars hamnar deras TB utanför budgeten.
  if (db.prepare('SELECT 1 FROM cost_centers WHERE active = 1 LIMIT 1').get()) {
    for (const c of consultants) {
      if (!db.prepare('SELECT cost_center_id FROM users WHERE id = ?').get(c.id).cost_center_id) {
        warnings.push({ type: 'no_cost_center', user_id: c.id, text: `${c.name} saknar kostnadsställe och räknas inte in i någon KST-budget.` });
      }
    }
  }

  for (const s of db.prepare("SELECT id, name FROM users WHERE active = 1 AND pay_type = 'subcontractor' AND cost_rate = 0 ORDER BY name").all()) {
    warnings.push({ type: 'no_purchase_price', user_id: s.id, text: `${s.name} är underkonsult men saknar inköpspris (timkostnad). Inköpsunderlaget och TB blir fel.` });
  }
  return warnings;
}
