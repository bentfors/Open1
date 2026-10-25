import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HANDLED, bad, conflict, forbidden, notFound } from '../http.js';
import { f, parse, optDate, optId } from '../validate.js';
import { insertRow, updateRow } from '../db.js';
import { getSettings, isAdmin, isFinance } from '../domain.js';

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

// Filtyp bestäms av innehållet (magic bytes), aldrig av filnamn eller uppgiven typ.
function sniffReceipt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', ext: 'png' };
  }
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { type: 'image/webp', ext: 'webp' };
  }
  if (buf.length > 5 && buf.toString('latin1', 0, 5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  return null;
}

const COMMON = {
  date: f.date({ required: true, label: 'Datum' }),
  project_id: f.int({ nullable: true, min: 1, label: 'Projekt' }),
  billable: f.bool({ label: 'Vidarefakturera' }),
};

const EXPENSE_SCHEMA = {
  ...COMMON,
  description: f.str({ required: true, max: 200, label: 'Beskrivning' }),
  amount: f.num({ required: true, min: 0.01, max: 10000000, label: 'Belopp' }),
  vat: f.num({ min: 0, max: 10000000, label: 'Moms' }),
};

const MILEAGE_SCHEMA = {
  ...COMMON,
  from_place: f.str({ max: 100, label: 'Från' }),
  to_place: f.str({ max: 100, label: 'Till' }),
  purpose: f.str({ required: true, max: 200, label: 'Syfte' }),
  km: f.num({ required: true, min: 0.1, max: 5000, label: 'Kilometer' }),
};

export function registerExpenses({ db, router, dataDir }) {
  const receiptDir = path.join(dataDir, 'receipts');

  function assertProject(userId, projectId, billable) {
    if (projectId == null) {
      if (billable) throw bad('Välj ett projekt för att kunna vidarefakturera.');
      return;
    }
    const p = db
      .prepare(
        `SELECT p.status, p.billing_type, p.open_for_all,
                EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) AS is_member
         FROM projects p WHERE p.id = ?`,
      )
      .get(userId, projectId);
    if (!p) throw bad('Projektet finns inte.');
    if (p.status !== 'active') throw bad('Projektet är avslutat.');
    if (!p.open_for_all && !p.is_member) throw forbidden('Du är inte medlem i projektet.');
    if (billable && p.billing_type === 'internal') throw bad('Interna projekt kan inte faktureras.');
  }

  function assertNotLocked(user, date) {
    const { locked_until } = getSettings(db);
    if (locked_until && date <= locked_until && !isAdmin(user)) {
      throw forbidden(`Perioden är låst till och med ${locked_until}. Kontakta en administratör.`);
    }
  }

  function scopeUserId(user, query) {
    if (query.user_id) {
      const id = optId(query.user_id, 'Användare');
      if (id !== user.id && !isAdmin(user)) throw forbidden();
      return id;
    }
    return query.all === '1' && isAdmin(user) ? null : user.id;
  }

  function saveReceipt(receipt) {
    if (!receipt || typeof receipt.data !== 'string') throw bad('Ogiltigt kvitto.');
    const buf = Buffer.from(receipt.data, 'base64');
    if (!buf.length) throw bad('Kvittot är tomt.');
    if (buf.length > MAX_RECEIPT_BYTES) throw bad('Kvittot är för stort (högst 5 MB).');
    const kind = sniffReceipt(buf);
    if (!kind) throw bad('Kvittot måste vara en bild (JPEG, PNG, WebP) eller PDF.');
    fs.mkdirSync(receiptDir, { recursive: true });
    const file = `${randomUUID()}.${kind.ext}`;
    fs.writeFileSync(path.join(receiptDir, file), buf);
    const name = String(receipt.name || 'kvitto').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
    return { receipt_file: file, receipt_name: name, receipt_type: kind.type };
  }

  const removeReceiptFile = (file) => {
    if (file) fs.rmSync(path.join(receiptDir, path.basename(file)), { force: true });
  };

  // Utlägg ─────────────────────────────────────────────────────────────
  const EXPENSE_LIST = `
    SELECT e.id, e.user_id, u.name AS user_name, e.expense_date AS date, e.project_id, p.code AS project_code,
           p.name AS project_name, e.description, e.amount, e.vat, e.billable, e.receipt_name,
           e.receipt_file IS NOT NULL AS has_receipt, e.status, e.reject_note, e.invoice_id
    FROM expenses e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id`;

  router.add('GET', '/api/expenses', {}, ({ user, query }) => {
    const from = optDate(query.from, 'Från') ?? '0000-01-01';
    const to = optDate(query.to, 'Till') ?? '9999-12-31';
    const uid = scopeUserId(user, query);
    return db
      .prepare(`${EXPENSE_LIST} WHERE e.expense_date BETWEEN ? AND ? AND (? IS NULL OR e.user_id = ?) ORDER BY e.expense_date DESC, e.id DESC`)
      .all(from, to, uid, uid);
  });

  router.add('POST', '/api/expenses', { bodyLimit: 8 * 1024 * 1024 }, ({ user, body }) => {
    const data = parse(body, EXPENSE_SCHEMA);
    assertProject(user.id, data.project_id, data.billable);
    assertNotLocked(user, data.date);
    const receipt = body.receipt ? saveReceipt(body.receipt) : {};
    const id = insertRow(db, 'expenses', {
      user_id: user.id,
      expense_date: data.date,
      project_id: data.project_id ?? null,
      description: data.description,
      amount: data.amount,
      vat: data.vat ?? 0,
      billable: data.billable ?? 0,
      ...receipt,
    });
    return { id };
  });

  function loadOwned(table, id, user) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw notFound();
    if (row.user_id !== user.id && !isAdmin(user)) throw forbidden();
    if (row.status === 'approved') throw conflict('Godkända poster kan inte ändras.');
    if (row.invoice_id) throw conflict('Posten är fakturerad.');
    return row;
  }

  router.add('PATCH', '/api/expenses/:id', { bodyLimit: 8 * 1024 * 1024 }, ({ user, params, body }) => {
    const row = loadOwned('expenses', Number(params.id), user);
    const data = parse(body, EXPENSE_SCHEMA, { partial: true });
    const merged = { project_id: row.project_id, billable: row.billable, ...data };
    assertProject(row.user_id, merged.project_id, merged.billable);
    assertNotLocked(user, row.expense_date);
    if (data.date) assertNotLocked(user, data.date);

    const update = { ...data, status: 'submitted', reject_note: null };
    if (data.date) {
      update.expense_date = data.date;
      delete update.date;
    }
    let oldFile = null;
    if (body.receipt) {
      Object.assign(update, saveReceipt(body.receipt));
      oldFile = row.receipt_file;
    } else if (body.remove_receipt) {
      Object.assign(update, { receipt_file: null, receipt_name: null, receipt_type: null });
      oldFile = row.receipt_file;
    }
    updateRow(db, 'expenses', row.id, update);
    removeReceiptFile(oldFile);
    return { ok: true };
  });

  router.add('DELETE', '/api/expenses/:id', {}, ({ user, params }) => {
    const row = loadOwned('expenses', Number(params.id), user);
    assertNotLocked(user, row.expense_date);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id);
    removeReceiptFile(row.receipt_file);
    return { ok: true };
  });

  // Kvittot får ses av ägaren, administratörer och den som kan attestera posten.
  router.add('GET', '/api/expenses/:id/receipt', {}, ({ user, params, res }) => {
    const row = db
      .prepare(
        `SELECT e.user_id, e.receipt_file, e.receipt_type, e.receipt_name, p.manager_id AS pm, u.manager_id AS um, u.bm_id AS bm
         FROM expenses e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id WHERE e.id = ?`,
      )
      .get(Number(params.id));
    if (!row || !row.receipt_file) throw notFound('Kvittot finns inte.');
    // Ägaren, BM, projektledaren, chefen när ingen annan finns, samt administratörer och ekonomi (som fakturerar utläggen).
    const allowed = isFinance(user) || row.user_id === user.id || row.bm === user.id || row.pm === user.id || (!row.pm && !row.bm && row.um === user.id);
    if (!allowed) throw forbidden();
    const file = path.join(receiptDir, path.basename(row.receipt_file));
    if (!fs.existsSync(file)) throw notFound('Kvittot finns inte.');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': row.receipt_type,
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `inline; filename="receipt${ext}"`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
    return HANDLED;
  });

  // Körjournal ─────────────────────────────────────────────────────────
  const MILEAGE_LIST = `
    SELECT m.id, m.user_id, u.name AS user_name, m.trip_date AS date, m.project_id, p.code AS project_code,
           p.name AS project_name, m.from_place, m.to_place, m.purpose, m.km, m.rate_per_km,
           ROUND(m.km * m.rate_per_km, 2) AS amount, m.billable, m.status, m.reject_note, m.invoice_id
    FROM mileage m JOIN users u ON u.id = m.user_id LEFT JOIN projects p ON p.id = m.project_id`;

  router.add('GET', '/api/mileage', {}, ({ user, query }) => {
    const from = optDate(query.from, 'Från') ?? '0000-01-01';
    const to = optDate(query.to, 'Till') ?? '9999-12-31';
    const uid = scopeUserId(user, query);
    return db
      .prepare(`${MILEAGE_LIST} WHERE m.trip_date BETWEEN ? AND ? AND (? IS NULL OR m.user_id = ?) ORDER BY m.trip_date DESC, m.id DESC`)
      .all(from, to, uid, uid);
  });

  router.add('POST', '/api/mileage', {}, ({ user, body }) => {
    const data = parse(body, MILEAGE_SCHEMA);
    assertProject(user.id, data.project_id, data.billable);
    assertNotLocked(user, data.date);
    const id = insertRow(db, 'mileage', {
      user_id: user.id,
      trip_date: data.date,
      project_id: data.project_id ?? null,
      from_place: data.from_place ?? '',
      to_place: data.to_place ?? '',
      purpose: data.purpose,
      km: data.km,
      rate_per_km: getSettings(db).mileage_rate,
      billable: data.billable ?? 0,
    });
    return { id };
  });

  router.add('PATCH', '/api/mileage/:id', {}, ({ user, params, body }) => {
    const row = loadOwned('mileage', Number(params.id), user);
    const data = parse(body, MILEAGE_SCHEMA, { partial: true });
    const merged = { project_id: row.project_id, billable: row.billable, ...data };
    assertProject(row.user_id, merged.project_id, merged.billable);
    assertNotLocked(user, row.trip_date);
    if (data.date) assertNotLocked(user, data.date);
    const update = { ...data, status: 'submitted', reject_note: null };
    if (data.date) {
      update.trip_date = data.date;
      delete update.date;
    }
    updateRow(db, 'mileage', row.id, update);
    return { ok: true };
  });

  router.add('DELETE', '/api/mileage/:id', {}, ({ user, params }) => {
    const row = loadOwned('mileage', Number(params.id), user);
    assertNotLocked(user, row.trip_date);
    db.prepare('DELETE FROM mileage WHERE id = ?').run(row.id);
    return { ok: true };
  });
}
