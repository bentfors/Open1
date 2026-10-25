import { bad, conflict, forbidden, notFound } from '../http.js';
import { f, parse, isDate, reqId } from '../validate.js';
import { insertRow } from '../db.js';
import { today, weekStart, weekDays } from '../dates.js';
import { getSettings, isAdmin, resolveRates } from '../domain.js';

const ENTRY_SCHEMA = {
  date: f.date({ required: true, label: 'Datum' }),
  activity_id: f.int({ nullable: true, min: 1, label: 'Aktivitet' }),
  absence_type_id: f.int({ nullable: true, min: 1, label: 'Frånvarotyp' }),
  minutes: f.int({ required: true, min: 0, max: 1440, label: 'Tid' }),
  note: f.str({ max: 500, label: 'Anteckning' }),
  user_id: f.int({ min: 1, label: 'Användare' }),
};

const ENTRY_SELECT = `
  SELECT te.id, te.user_id, te.work_date, te.activity_id, te.absence_type_id, te.minutes, te.note,
         te.status, te.reject_note, te.invoice_id,
         a.name AS activity_name, a.billable AS activity_billable,
         p.id AS project_id, p.code AS project_code, p.name AS project_name,
         c.name AS customer_name, at.name AS absence_name
  FROM time_entries te
  LEFT JOIN activities a ON a.id = te.activity_id
  LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN absence_types at ON at.id = te.absence_type_id`;

function assertMonday(date) {
  if (!isDate(date) || weekStart(date) !== date) throw bad('Veckan måste anges som en måndag (ÅÅÅÅ-MM-DD).');
}

function assertNotLocked(db, user, date) {
  const { locked_until } = getSettings(db);
  if (locked_until && date <= locked_until && !isAdmin(user)) {
    throw forbidden(`Perioden är låst till och med ${locked_until}. Kontakta ekonomi eller en administratör.`);
  }
}

export function registerTime({ db, router }) {
  router.add('GET', '/api/time/week', {}, ({ user, query }) => {
    const start = query.start || weekStart(today());
    assertMonday(start);
    const userId = query.user_id ? reqId(query.user_id, 'Användare') : user.id;
    if (userId !== user.id && !isAdmin(user)) throw forbidden();
    const owner = db.prepare('SELECT id, name, weekly_hours FROM users WHERE id = ?').get(userId);
    if (!owner) throw notFound('Användaren finns inte.');
    const days = weekDays(start);
    const entries = db
      .prepare(`${ENTRY_SELECT} WHERE te.user_id = ? AND te.work_date BETWEEN ? AND ? ORDER BY c.name, p.code, a.name, at.name`)
      .all(userId, days[0], days[6]);
    return {
      week_start: start,
      days,
      user: owner,
      today: today(),
      locked_until: getSettings(db).locked_until,
      entries,
    };
  });

  router.add('PUT', '/api/time/entries', {}, ({ user, body }) => {
    const data = parse(body, ENTRY_SCHEMA);
    if ((data.activity_id == null) === (data.absence_type_id == null)) {
      throw bad('Ange antingen en aktivitet eller en frånvarotyp.');
    }
    const ownerId = data.user_id ?? user.id;
    if (ownerId !== user.id && !isAdmin(user)) throw forbidden();
    const owner = db.prepare('SELECT id, active FROM users WHERE id = ?').get(ownerId);
    if (!owner || !owner.active) throw bad('Användaren finns inte eller är inaktiv.');

    assertNotLocked(db, user, data.date);

    const where = data.activity_id != null ? 'activity_id = ?' : 'absence_type_id = ?';
    const target = data.activity_id ?? data.absence_type_id;
    const existing = db
      .prepare(`SELECT * FROM time_entries WHERE user_id = ? AND work_date = ? AND ${where}`)
      .get(ownerId, data.date, target);

    if (existing) {
      if (existing.status === 'approved') throw conflict('Tiden är godkänd och kan inte ändras.');
      if (existing.status === 'submitted') throw conflict('Tiden är inskickad. Ta tillbaka veckan för att ändra.');
    }

    if (data.minutes === 0) {
      if (existing) db.prepare('DELETE FROM time_entries WHERE id = ?').run(existing.id);
      return { deleted: true };
    }

    let rates = { billable: 0, bill_rate: 0, cost_rate: 0 };
    if (data.activity_id != null) {
      const row = db
        .prepare(
          `SELECT a.active AS a_active, p.status, p.open_for_all, p.start_date, p.end_date, c.active AS c_active,
                  EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) AS is_member
           FROM activities a JOIN projects p ON p.id = a.project_id JOIN customers c ON c.id = p.customer_id
           WHERE a.id = ?`,
        )
        .get(ownerId, data.activity_id);
      if (!row) throw bad('Aktiviteten finns inte.');
      if (!existing) {
        if (!row.a_active || row.status !== 'active' || !row.c_active) throw bad('Projektet eller aktiviteten är avslutad.');
      }
      if (!row.open_for_all && !row.is_member) throw forbidden('Du är inte medlem i projektet.');
      if (row.start_date && data.date < row.start_date) throw bad(`Projektet startar ${row.start_date}.`);
      if (row.end_date && data.date > row.end_date) throw bad(`Projektet slutar ${row.end_date}.`);
      if (data.date > today()) throw bad('Du kan inte rapportera projekttid framåt i tiden.');
      rates = resolveRates(db, ownerId, data.activity_id);
    } else {
      const type = db.prepare('SELECT active FROM absence_types WHERE id = ?').get(data.absence_type_id);
      if (!type) throw bad('Frånvarotypen finns inte.');
      if (!existing && !type.active) throw bad('Frånvarotypen är inte längre aktiv.');
    }

    const others = db
      .prepare(`SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE user_id = ? AND work_date = ? AND id <> ?`)
      .get(ownerId, data.date, existing?.id ?? 0).m;
    if (others + data.minutes > 1440) throw bad('En dag kan högst ha 24 timmar.');

    const note = data.note ?? existing?.note ?? '';
    let id;
    if (existing) {
      id = existing.id;
      db.prepare(
        `UPDATE time_entries SET minutes = ?, note = ?, status = 'open', reject_note = NULL,
           billable = ?, bill_rate = ?, cost_rate = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(data.minutes, note, rates.billable, rates.bill_rate, rates.cost_rate, id);
    } else {
      id = insertRow(db, 'time_entries', {
        user_id: ownerId,
        work_date: data.date,
        activity_id: data.activity_id ?? null,
        absence_type_id: data.absence_type_id ?? null,
        minutes: data.minutes,
        note,
        billable: rates.billable,
        bill_rate: rates.bill_rate,
        cost_rate: rates.cost_rate,
      });
    }
    return db.prepare(`${ENTRY_SELECT} WHERE te.id = ?`).get(id);
  });

  router.add('POST', '/api/time/submit', {}, ({ user, body }) => {
    assertMonday(body.week_start);
    const days = weekDays(body.week_start);
    const info = db
      .prepare(
        `UPDATE time_entries SET status = 'submitted', reject_note = NULL, updated_at = datetime('now')
         WHERE user_id = ? AND work_date BETWEEN ? AND ? AND status IN ('open','rejected')`,
      )
      .run(user.id, days[0], days[6]);
    if (!info.changes) throw bad('Det finns ingen tid att skicka in för veckan.');
    return { submitted: info.changes };
  });

  router.add('POST', '/api/time/recall', {}, ({ user, body }) => {
    assertMonday(body.week_start);
    const days = weekDays(body.week_start);
    const info = db
      .prepare(
        `UPDATE time_entries SET status = 'open', updated_at = datetime('now')
         WHERE user_id = ? AND work_date BETWEEN ? AND ? AND status = 'submitted'`,
      )
      .run(user.id, days[0], days[6]);
    if (!info.changes) throw bad('Det finns inget inskickat att ta tillbaka. Godkänd tid kan inte tas tillbaka.');
    return { recalled: info.changes };
  });
}
