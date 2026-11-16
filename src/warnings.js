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
      `SELECT u.id, u.name FROM users u WHERE u.active = 1 AND (
         u.bm_id IS NOT NULL OR EXISTS (SELECT 1 FROM commission_rule_sources s WHERE s.user_id = u.id))
       ORDER BY u.name`,
    )
    .all();
  for (const c of consultants) {
    const current = db
      .prepare(`SELECT COUNT(*) AS n FROM assignments WHERE user_id = ? AND (end_date IS NULL OR end_date >= ?)`)
      .get(c.id, now).n;
    if (!current) warnings.push({ type: 'no_assignment', user_id: c.id, text: `${c.name} har inget pågående eller kommande uppdrag. Prognosen räknar med bänktid.` });
    if (!db.prepare('SELECT 1 FROM employments WHERE user_id = ?').get(c.id)) {
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
  return warnings;
}
