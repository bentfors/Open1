import { conflict, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow } from '../db.js';

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

  router.add('POST', '/api/customers', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, CUSTOMER_SCHEMA);
    if (db.prepare('SELECT 1 FROM customers WHERE name = ?').get(data.name)) throw conflict('Kunden finns redan.');
    return { id: insertRow(db, 'customers', data) };
  });

  router.add('PATCH', '/api/customers/:id', { auth: 'admin' }, ({ params, body }) => {
    const id = Number(params.id);
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw notFound('Kunden finns inte.');
    const data = parse(body, CUSTOMER_SCHEMA, { partial: true });
    if (data.name && db.prepare('SELECT 1 FROM customers WHERE name = ? AND id <> ?').get(data.name, id)) {
      throw conflict('Kunden finns redan.');
    }
    updateRow(db, 'customers', id, data);
    return { ok: true };
  });

  router.add('DELETE', '/api/customers/:id', { auth: 'admin' }, ({ params }) => {
    const id = Number(params.id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE customer_id = ?').get(id).n;
    if (n) throw conflict('Kunden har projekt och kan inte tas bort. Inaktivera kunden i stället.');
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    return { ok: true };
  });
}
