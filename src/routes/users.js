import { bad, conflict, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow, tx } from '../db.js';
import { hashPassword, checkPasswordPolicy, destroyUserSessions } from '../auth.js';
import { isAdmin } from '../domain.js';

const USER_COLUMNS = `u.id, u.email, u.name, u.role, u.category_id, c.name AS category_name, u.manager_id,
  m.name AS manager_name, u.bm_id, bm.name AS bm_name, u.cost_rate, u.default_bill_rate, u.weekly_hours, u.active, u.must_change_password`;

const USER_SCHEMA = {
  email: f.email({ required: true, label: 'E-post' }),
  name: f.str({ required: true, max: 100, label: 'Namn' }),
  role: f.oneOf(['admin', 'user'], { required: true, label: 'Roll' }),
  category_id: f.int({ nullable: true, min: 1, label: 'Kategori' }),
  manager_id: f.int({ nullable: true, min: 1, label: 'Chef' }),
  bm_id: f.int({ nullable: true, min: 1, label: 'BM' }),
  cost_rate: f.num({ min: 0, max: 100000, label: 'Timkostnad' }),
  default_bill_rate: f.num({ min: 0, max: 100000, label: 'Standardpris' }),
  weekly_hours: f.num({ min: 0, max: 80, label: 'Arbetstid per vecka' }),
  active: f.bool({ label: 'Aktiv' }),
};

const CATEGORY_SCHEMA = {
  name: f.str({ required: true, max: 60, label: 'Namn' }),
  sort: f.int({ min: 0, max: 10000, label: 'Sortering' }),
};

function assertRefs(db, data) {
  if (data.category_id != null && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(data.category_id)) {
    throw bad('Kategorin finns inte.');
  }
  if (data.manager_id != null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(data.manager_id)) {
    throw bad('Chefen finns inte.');
  }
  if (data.bm_id != null && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(data.bm_id)) {
    throw bad('BM finns inte eller är inaktiv.');
  }
}

function activeAdminCount(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get().n;
}

export function registerUsers({ db, router }) {
  // Namnlista för väljare. Inga priser eller kostnader.
  router.add('GET', '/api/people', {}, () =>
    db
      .prepare(
        `SELECT u.id, u.name, u.category_id, c.name AS category_name, u.active
         FROM users u LEFT JOIN categories c ON c.id = u.category_id
         ORDER BY u.active DESC, u.name`,
      )
      .all(),
  );

  router.add('GET', '/api/users', { auth: 'admin' }, () =>
    db
      .prepare(
        `SELECT ${USER_COLUMNS}
         FROM users u
         LEFT JOIN categories c ON c.id = u.category_id
         LEFT JOIN users m ON m.id = u.manager_id
         LEFT JOIN users bm ON bm.id = u.bm_id
         ORDER BY u.active DESC, u.name`,
      )
      .all(),
  );

  router.add('POST', '/api/users', { auth: 'admin' }, async ({ body }) => {
    const data = parse(body, USER_SCHEMA);
    assertRefs(db, data);
    const problem = checkPasswordPolicy(body.password);
    if (problem) throw bad(problem);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email)) {
      throw conflict('E-postadressen används redan.');
    }
    const id = insertRow(db, 'users', {
      ...data,
      password_hash: await hashPassword(body.password),
      must_change_password: 1,
    });
    return { id };
  });

  router.add('PATCH', '/api/users/:id', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) throw notFound('Användaren finns inte.');
    const data = parse(body, USER_SCHEMA, { partial: true });
    assertRefs(db, data);
    if (data.manager_id === id) throw bad('En användare kan inte vara sin egen chef.');
    if (data.bm_id === id) throw bad('En användare kan inte vara sin egen BM.');
    if (data.email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(data.email, id)) {
      throw conflict('E-postadressen används redan.');
    }
    const losesAdmin =
      existing.role === 'admin' && existing.active && (data.role === 'user' || data.active === 0);
    if (losesAdmin && activeAdminCount(db) <= 1) throw bad('Det måste finnas minst en aktiv administratör.');
    if (id === user.id && data.active === 0) throw bad('Du kan inte inaktivera dig själv.');

    tx(db, () => {
      updateRow(db, 'users', id, data);
      if (data.active === 0) destroyUserSessions(db, id);
    });
    return { ok: true };
  });

  // Administratören sätter ett tillfälligt lösenord. Användaren måste byta vid nästa inloggning.
  router.add('POST', '/api/users/:id/password', { auth: 'admin' }, async ({ params, body }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('Användaren finns inte.');
    const problem = checkPasswordPolicy(body.password);
    if (problem) throw bad(problem);
    const hash = await hashPassword(body.password);
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, id);
      destroyUserSessions(db, id);
    });
    return { ok: true };
  });

  // Kategorier
  router.add('GET', '/api/categories', {}, () =>
    db
      .prepare(
        `SELECT c.id, c.name, c.sort, (SELECT COUNT(*) FROM users u WHERE u.category_id = c.id) AS users
         FROM categories c ORDER BY c.sort, c.name`,
      )
      .all(),
  );

  router.add('POST', '/api/categories', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, CATEGORY_SCHEMA);
    if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(data.name)) throw conflict('Kategorin finns redan.');
    return { id: insertRow(db, 'categories', data) };
  });

  router.add('PATCH', '/api/categories/:id', { auth: 'admin' }, ({ params, body }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw notFound();
    const data = parse(body, CATEGORY_SCHEMA, { partial: true });
    if (data.name && db.prepare('SELECT 1 FROM categories WHERE name = ? AND id <> ?').get(data.name, id)) {
      throw conflict('Kategorin finns redan.');
    }
    updateRow(db, 'categories', id, data);
    return { ok: true };
  });

  router.add('DELETE', '/api/categories/:id', { auth: 'admin' }, ({ params }) => {
    const id = Number(params.id);
    const used = db.prepare('SELECT COUNT(*) AS n FROM users WHERE category_id = ?').get(id).n;
    if (used) throw conflict(`Kategorin används av ${used} användare. Flytta dem först.`);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return { ok: true };
  });

  // Frånvarotyper
  router.add('GET', '/api/absence-types', {}, ({ user }) =>
    db
      .prepare(`SELECT id, name, active FROM absence_types ${isAdmin(user) ? '' : 'WHERE active = 1'} ORDER BY name`)
      .all(),
  );

  const ABSENCE_SCHEMA = {
    name: f.str({ required: true, max: 60, label: 'Namn' }),
    active: f.bool({ label: 'Aktiv' }),
  };
  router.add('POST', '/api/absence-types', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, ABSENCE_SCHEMA);
    if (db.prepare('SELECT 1 FROM absence_types WHERE name = ?').get(data.name)) throw conflict('Typen finns redan.');
    return { id: insertRow(db, 'absence_types', data) };
  });
  router.add('PATCH', '/api/absence-types/:id', { auth: 'admin' }, ({ params, body }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM absence_types WHERE id = ?').get(id)) throw notFound();
    const data = parse(body, ABSENCE_SCHEMA, { partial: true });
    if (data.name && db.prepare('SELECT 1 FROM absence_types WHERE name = ? AND id <> ?').get(data.name, id)) {
      throw conflict('Typen finns redan.');
    }
    updateRow(db, 'absence_types', id, data);
    return { ok: true };
  });
}
