import { bad, conflict, forbidden } from '../http.js';
import { tx } from '../db.js';
import { optDate, optId } from '../validate.js';
import { approverClause, approverParams, getSettings, isAdmin, resolveRates } from '../domain.js';

// Per typ: tabell, datumkolumn och hur raden kopplas till projekt.
const KINDS = {
  time: {
    table: 'time_entries',
    date: 'work_date',
    from: `time_entries x
           JOIN users u ON u.id = x.user_id
           LEFT JOIN activities a ON a.id = x.activity_id
           LEFT JOIN projects p ON p.id = a.project_id`,
    submitted: `x.status = 'submitted'`,
    reopenTo: 'open',
  },
  expense: {
    table: 'expenses',
    date: 'expense_date',
    from: `expenses x JOIN users u ON u.id = x.user_id LEFT JOIN projects p ON p.id = x.project_id`,
    submitted: `x.status = 'submitted'`,
    reopenTo: 'submitted',
  },
  mileage: {
    table: 'mileage',
    date: 'trip_date',
    from: `mileage x JOIN users u ON u.id = x.user_id LEFT JOIN projects p ON p.id = x.project_id`,
    submitted: `x.status = 'submitted'`,
    reopenTo: 'submitted',
  },
};

const idList = (ids) => ids.map(() => '?').join(',');

function parseIds(body) {
  const ids = body.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw bad('Välj minst en rad (högst 500).');
  }
  return [...new Set(ids)];
}

export function registerApprovals({ db, router }) {
  const clause = (alias = 'x') => approverClause({ entry: alias });

  router.add('GET', '/api/approvals/count', {}, ({ user }) => {
    const params = approverParams(user);
    let count = 0;
    for (const k of Object.values(KINDS)) {
      count += db
        .prepare(`SELECT COUNT(*) AS n FROM ${k.from} WHERE ${k.submitted} AND ${clause()}`)
        .get(params).n;
    }
    return { count };
  });

  const LIST_SQL = {
    time: `SELECT x.id, x.user_id, u.name AS user_name, x.work_date AS date, x.minutes, x.note,
                  p.id AS project_id, p.code AS project_code, p.name AS project_name, a.name AS activity_name,
                  at.name AS absence_name, c.name AS customer_name
           FROM ${KINDS.time.from}
           LEFT JOIN customers c ON c.id = p.customer_id
           LEFT JOIN absence_types at ON at.id = x.absence_type_id`,
    expenses: `SELECT x.id, x.user_id, u.name AS user_name, x.expense_date AS date, x.description, x.amount, x.vat,
                      x.billable, x.receipt_name, x.receipt_file IS NOT NULL AS has_receipt,
                      p.code AS project_code, p.name AS project_name
               FROM ${KINDS.expense.from}`,
    mileage: `SELECT x.id, x.user_id, u.name AS user_name, x.trip_date AS date, x.from_place, x.to_place, x.purpose,
                     x.km, x.rate_per_km, ROUND(x.km * x.rate_per_km, 2) AS amount, x.billable,
                     p.code AS project_code, p.name AS project_name
              FROM ${KINDS.mileage.from}`,
  };

  router.add('GET', '/api/approvals', {}, ({ user }) => {
    const params = approverParams(user);
    const where = (k) => `WHERE ${k.submitted} AND ${clause()}`;
    return {
      time: db.prepare(`${LIST_SQL.time} ${where(KINDS.time)} ORDER BY u.name, x.work_date, p.code`).all(params),
      expenses: db.prepare(`${LIST_SQL.expenses} ${where(KINDS.expense)} ORDER BY u.name, x.expense_date`).all(params),
      mileage: db.prepare(`${LIST_SQL.mileage} ${where(KINDS.mileage)} ORDER BY u.name, x.trip_date`).all(params),
    };
  });

  // Admin: godkända, ofakturerade rader som kan öppnas igen för rättning.
  router.add('GET', '/api/approvals/approved', { auth: 'admin' }, ({ query }) => {
    const params = {
      from: optDate(query.from, 'Från') ?? '0000-01-01',
      to: optDate(query.to, 'Till') ?? '9999-12-31',
      person: optId(query.user_id, 'Användare') ?? null,
    };
    const where = (date) =>
      `WHERE x.status = 'approved' AND x.invoice_id IS NULL AND x.${date} BETWEEN :from AND :to AND (:person IS NULL OR x.user_id = :person)`;
    return {
      time: db.prepare(`${LIST_SQL.time} ${where('work_date')} ORDER BY x.work_date DESC, u.name LIMIT 500`).all(params),
      expenses: db.prepare(`${LIST_SQL.expenses} ${where('expense_date')} ORDER BY x.expense_date DESC LIMIT 500`).all(params),
      mileage: db.prepare(`${LIST_SQL.mileage} ${where('trip_date')} ORDER BY x.trip_date DESC LIMIT 500`).all(params),
    };
  });

  // Hämtar raderna som användaren får attestera. Allt-eller-inget: en otillåten rad stoppar hela anropet.
  function loadDecidable(kind, ids, user) {
    const params = approverParams(user);
    ids.forEach((id, i) => (params[`i${i}`] = id));
    const placeholders = ids.map((_, i) => `:i${i}`).join(',');
    const extra = kind.table === 'time_entries' ? ', x.user_id, x.activity_id' : '';
    const rows = db
      .prepare(
        `SELECT x.id, x.${kind.date} AS date${extra}
         FROM ${kind.from}
         WHERE x.id IN (${placeholders}) AND ${kind.submitted} AND ${clause()}`,
      )
      .all(params);
    if (rows.length !== ids.length) {
      throw forbidden('Någon av raderna kan inte attesteras av dig, eller är redan hanterad.');
    }
    return rows;
  }

  router.add('POST', '/api/approvals/decide', {}, ({ user, body }) => {
    const kind = Object.hasOwn(KINDS, body.kind) ? KINDS[body.kind] : null;
    if (!kind) throw bad('Okänd typ.');
    const ids = parseIds(body);
    if (!['approve', 'reject'].includes(body.decision)) throw bad('Okänt beslut.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (body.decision === 'reject' && !note) throw bad('Ange en anledning till att du avslår.');

    return tx(db, () => {
      const rows = loadDecidable(kind, ids, user);
      const { locked_until } = getSettings(db);
      if (locked_until && !isAdmin(user) && rows.some((r) => r.date <= locked_until)) {
        throw forbidden(`Perioden är låst till och med ${locked_until}. Kontakta en administratör.`);
      }

      if (body.decision === 'reject') {
        const stmt = db.prepare(`UPDATE ${kind.table} SET status = 'rejected', reject_note = ? WHERE id = ?`);
        for (const r of rows) stmt.run(note, r.id);
        return { rejected: rows.length };
      }

      const approve = db.prepare(
        `UPDATE ${kind.table} SET status = 'approved', reject_note = NULL, approved_by = ?, approved_at = datetime('now')
         WHERE id = ?`,
      );
      // Priset sätts när tiden godkänns, så att prisändringar före attest slår igenom.
      const reprice = db.prepare('UPDATE time_entries SET billable = ?, bill_rate = ?, cost_rate = ? WHERE id = ?');
      for (const r of rows) {
        if (kind.table === 'time_entries' && r.activity_id != null) {
          const rates = resolveRates(db, r.user_id, r.activity_id);
          if (rates) reprice.run(rates.billable, rates.bill_rate, rates.cost_rate, r.id);
        }
        approve.run(user.id, r.id);
      }
      return { approved: rows.length };
    });
  });

  // Administratören kan öppna godkänt igen, så länge raden inte är fakturerad.
  router.add('POST', '/api/approvals/reopen', { auth: 'admin' }, ({ body }) => {
    const kind = Object.hasOwn(KINDS, body.kind) ? KINDS[body.kind] : null;
    if (!kind) throw bad('Okänd typ.');
    const ids = parseIds(body);
    return tx(db, () => {
      const rows = db
        .prepare(
          `SELECT id, invoice_id FROM ${kind.table} WHERE id IN (${idList(ids)}) AND status = 'approved'`,
        )
        .all(...ids);
      if (rows.length !== ids.length) throw bad('Någon av raderna är inte godkänd.');
      if (rows.some((r) => r.invoice_id)) throw conflict('Fakturerade rader kan inte öppnas. Ångra fakturaunderlaget först.');
      db.prepare(
        `UPDATE ${kind.table} SET status = ?, approved_by = NULL, approved_at = NULL WHERE id IN (${idList(ids)})`,
      ).run(kind.reopenTo, ...ids);
      return { reopened: rows.length };
    });
  });
}
