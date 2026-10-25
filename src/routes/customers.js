import { conflict, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow, tx } from '../db.js';
import { audit, changesFor } from '../audit.js';

const CUSTOMER_SCHEMA = {
  name: f.str({ required: true, max: 120, label: 'Kundnamn' }),
  org_no: f.str({ max: 30, label: 'Organisationsnummer' }),
  contact_name: f.str({ max: 100, label: 'Kontaktperson' }),
  email: f.str({ max: 200, label: 'E-post' }),
  phone: f.str({ max: 50, label: 'Telefon' }),
  address: f.str({ max: 300, label: 'Adress' }),
  invoice_ref: f.str({ max: 200, label: 'Fakturareferens' }),
  notes: f.str({ max: 2000, label: 'Anteckningar' }),
  active: f.bool({ label: 'Aktiv' }),
};

export function registerCustomers({ db, router }) {
  router.add('GET', '/api/customers', { auth: 'finance' }, () =>
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM projects p WHERE p.customer_id = c.id) AS projects
         FROM customers c ORDER BY c.active DESC, c.name`,
      )
      .all(),
  );

  router.add('POST', '/api/customers', { auth: 'admin' }, ({ body, user }) => {
    const data = parse(body, CUSTOMER_SCHEMA);
    if (db.prepare('SELECT 1 FROM customers WHERE name = ?').get(data.name)) throw conflict('Kunden finns redan.');
    return tx(db, () => {
      const id = insertRow(db, 'customers', data);
      audit(db, user, { entity: 'customer', action: 'create', entityId: id, label: data.name, customerId: id, changes: changesFor(db, null, data) });
      return { id };
    });
  });

  router.add('PATCH', '/api/customers/:id', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!existing) throw notFound('Kunden finns inte.');
    const data = parse(body, CUSTOMER_SCHEMA, { partial: true });
    if (data.name && db.prepare('SELECT 1 FROM customers WHERE name = ? AND id <> ?').get(data.name, id)) {
      throw conflict('Kunden finns redan.');
    }
    tx(db, () => {
      updateRow(db, 'customers', id, data);
      audit(db, user, { entity: 'customer', action: 'update', entityId: id, label: data.name ?? existing.name, customerId: id, changes: changesFor(db, existing, data) });
    });
    return { ok: true };
  });

  router.add('DELETE', '/api/customers/:id', { auth: 'admin' }, ({ params, user }) => {
    const id = Number(params.id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE customer_id = ?').get(id).n;
    if (n) throw conflict('Kunden har projekt och kan inte tas bort. Inaktivera kunden i stället.');
    const existing = db.prepare('SELECT name FROM customers WHERE id = ?').get(id);
    tx(db, () => {
      if (existing) audit(db, user, { entity: 'customer', action: 'delete', entityId: id, label: existing.name, customerId: id });
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    });
    return { ok: true };
  });
}
