import { bad, conflict, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow } from '../db.js';
import { today, daysBetween } from '../dates.js';

const EMPLOYMENT_SCHEMA = {
  user_id: f.int({ required: true, min: 1, label: 'Anställd' }),
  type: f.oneOf(['permanent', 'fixed_term', 'probation'], { label: 'Typ' }),
  start_date: f.date({ required: true, label: 'Startdatum' }),
  end_date: f.date({ nullable: true, label: 'Slutdatum' }),
  notice_months: f.int({ min: 0, max: 24, label: 'Uppsägningstid (månader)' }),
  notes: f.str({ max: 1000, label: 'Anteckningar' }),
};

const ASSIGNMENT_SCHEMA = {
  user_id: f.int({ required: true, min: 1, label: 'Konsult' }),
  customer_id: f.int({ required: true, min: 1, label: 'Kund' }),
  project_id: f.int({ nullable: true, min: 1, label: 'Projekt' }),
  title: f.str({ max: 150, label: 'Roll eller benämning' }),
  start_date: f.date({ required: true, label: 'Startdatum' }),
  end_date: f.date({ nullable: true, label: 'Slutdatum' }),
  hourly_rate: f.num({ required: true, min: 0, max: 100000, label: 'Timpris' }),
  hours_per_week: f.num({ required: true, min: 0.5, max: 80, label: 'Timmar per vecka' }),
  notes: f.str({ max: 1000, label: 'Anteckningar' }),
};

const overlaps = (a, b) => a.start_date <= (b.end_date ?? '9999-12-31') && b.start_date <= (a.end_date ?? '9999-12-31');

export function registerContracts({ db, router }) {
  const userRow = (id) => db.prepare('SELECT id, name, weekly_hours, active FROM users WHERE id = ?').get(id);

  // ── Anställningar ─────────────────────────────────────────────────────
  router.add('GET', '/api/employments', { auth: 'admin' }, () =>
    db
      .prepare(
        `SELECT e.*, u.name AS user_name FROM employments e JOIN users u ON u.id = e.user_id
         ORDER BY u.name, e.start_date DESC`,
      )
      .all(),
  );

  function validateEmployment(m, existingId) {
    if (!userRow(m.user_id)) throw bad('Användaren finns inte.');
    if (m.end_date && m.end_date < m.start_date) throw bad('Slutdatum kan inte ligga före startdatum.');
    if (m.type === 'fixed_term' && !m.end_date) throw bad('En visstidsanställning behöver ett slutdatum.');
    const others = db.prepare('SELECT * FROM employments WHERE user_id = ? AND id <> ?').all(m.user_id, existingId ?? 0);
    if (others.some((o) => overlaps(m, o))) throw conflict('Anställningen överlappar en annan anställning för samma person.');
  }

  router.add('POST', '/api/employments', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, EMPLOYMENT_SCHEMA);
    data.end_date ??= null;
    data.type ??= 'permanent';
    validateEmployment(data, null);
    return { id: insertRow(db, 'employments', data) };
  });

  router.add('PATCH', '/api/employments/:id', { auth: 'admin' }, ({ params, body }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM employments WHERE id = ?').get(id);
    if (!existing) throw notFound('Anställningen finns inte.');
    const data = parse(body, EMPLOYMENT_SCHEMA, { partial: true });
    validateEmployment({ ...existing, ...data }, id);
    updateRow(db, 'employments', id, data);
    return { ok: true };
  });

  router.add('DELETE', '/api/employments/:id', { auth: 'admin' }, ({ params }) => {
    db.prepare('DELETE FROM employments WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });

  // ── Uppdrag ───────────────────────────────────────────────────────────
  router.add('GET', '/api/assignments', { auth: 'admin' }, () =>
    db
      .prepare(
        `SELECT a.*, u.name AS user_name, c.name AS customer_name, p.code AS project_code, p.name AS project_name
         FROM assignments a JOIN users u ON u.id = a.user_id JOIN customers c ON c.id = a.customer_id
         LEFT JOIN projects p ON p.id = a.project_id
         ORDER BY u.name, a.start_date DESC`,
      )
      .all(),
  );

  /**
   * Uppdrag får löpa parallellt, men tillsammans inte överstiga personens arbetstid.
   * Annars skulle prognosen räkna med fler debiterbara timmar än som finns.
   */
  function validateAssignment(m, existingId) {
    const user = userRow(m.user_id);
    if (!user) throw bad('Konsulten finns inte.');
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(m.customer_id)) throw bad('Kunden finns inte.');
    if (m.project_id != null) {
      const p = db.prepare('SELECT customer_id FROM projects WHERE id = ?').get(m.project_id);
      if (!p) throw bad('Projektet finns inte.');
      if (p.customer_id !== m.customer_id) throw bad('Projektet tillhör en annan kund.');
    }
    if (m.end_date && m.end_date < m.start_date) throw bad('Slutdatum kan inte ligga före startdatum.');
    if (m.hours_per_week > user.weekly_hours + 0.001) {
      throw conflict(`${user.name} arbetar ${user.weekly_hours} tim/vecka och kan inte ha ett uppdrag på ${m.hours_per_week}.`);
    }
    const others = db.prepare('SELECT * FROM assignments WHERE user_id = ? AND id <> ?').all(m.user_id, existingId ?? 0).filter((o) => overlaps(m, o));
    // Största samtidiga omfattning, kontrollerad vid varje startdatum inom intervallet.
    const points = [m.start_date, ...others.map((o) => o.start_date).filter((d) => d > m.start_date && d <= (m.end_date ?? '9999-12-31'))];
    for (const day of points) {
      const sum = m.hours_per_week + others.filter((o) => o.start_date <= day && day <= (o.end_date ?? '9999-12-31')).reduce((s, o) => s + o.hours_per_week, 0);
      if (sum > user.weekly_hours + 0.001) {
        throw conflict(`Uppdragen skulle tillsammans bli ${sum} tim/vecka ${day}, men ${user.name} arbetar ${user.weekly_hours}.`);
      }
    }
  }

  router.add('POST', '/api/assignments', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, ASSIGNMENT_SCHEMA);
    data.end_date ??= null;
    data.project_id ??= null;
    validateAssignment(data, null);
    return { id: insertRow(db, 'assignments', data) };
  });

  router.add('PATCH', '/api/assignments/:id', { auth: 'admin' }, ({ params, body }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
    if (!existing) throw notFound('Uppdraget finns inte.');
    const data = parse(body, ASSIGNMENT_SCHEMA, { partial: true });
    validateAssignment({ ...existing, ...data }, id);
    updateRow(db, 'assignments', id, data);
    return { ok: true };
  });

  router.add('DELETE', '/api/assignments/:id', { auth: 'admin' }, ({ params }) => {
    db.prepare('DELETE FROM assignments WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });

  /**
   * Luckor i registret som gör prognoserna missvisande. Med "konsult" menas här den som har en BM
   * eller ingår i en provisionsregel, eftersom kategorierna kan döpas om fritt.
   */
  router.add('GET', '/api/contracts/warnings', { auth: 'admin' }, () => {
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
  });
}
