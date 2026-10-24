import { HANDLED, bad, notFound, sendText } from '../http.js';
import { f, parse, reqId, optDate } from '../validate.js';
import { tx } from '../db.js';
import { round2 } from '../domain.js';
import { toCsv } from '../csv.js';

/**
 * Fakturaunderlag. Bara godkänd, ofakturerad tid på löpande räkning samt godkända,
 * vidarefakturerbara utlägg och körningar tas med. Fastprisprojekt ingår inte, de faktureras separat.
 */
export function registerInvoices({ db, router }) {
  function buildLines(customerId, from, to, invoiceId = null) {
    // invoiceId = null: förhandsvisning av ofakturerat. Annars: det som hör till underlaget.
    const filter = (alias) => (invoiceId ? `${alias}.invoice_id = :inv` : `${alias}.invoice_id IS NULL AND ${alias}.status = 'approved'`);
    const params = invoiceId ? { inv: invoiceId } : { cust: customerId, from, to };
    const scope = invoiceId ? '' : 'AND p.customer_id = :cust';

    const time = db
      .prepare(
        `SELECT p.code AS project_code, p.name AS project_name, a.name AS activity_name, u.name AS user_name,
                te.bill_rate AS rate, SUM(te.minutes) AS minutes
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN activities a ON a.id = te.activity_id
         JOIN projects p ON p.id = a.project_id
         WHERE ${filter('te')} AND te.billable = 1 AND p.billing_type = 'hourly' ${scope}
           ${invoiceId ? '' : 'AND te.work_date BETWEEN :from AND :to'}
         GROUP BY p.id, a.id, u.id, te.bill_rate
         ORDER BY p.code, a.name, u.name`,
      )
      .all(params)
      .map((r) => ({
        kind: 'Tid',
        project: `${r.project_code} ${r.project_name}`,
        description: `${r.activity_name} – ${r.user_name}`,
        quantity: round2(r.minutes / 60),
        unit: 'tim',
        rate: r.rate,
        amount: round2((r.minutes / 60) * r.rate),
      }));

    const expenses = db
      .prepare(
        `SELECT p.code AS project_code, p.name AS project_name, e.expense_date AS date, e.description, u.name AS user_name, e.amount
         FROM expenses e JOIN users u ON u.id = e.user_id JOIN projects p ON p.id = e.project_id
         WHERE ${filter('e')} AND e.billable = 1 ${scope}
           ${invoiceId ? '' : 'AND e.expense_date BETWEEN :from AND :to'}
         ORDER BY p.code, e.expense_date`,
      )
      .all(params)
      .map((r) => ({
        kind: 'Utlägg',
        project: `${r.project_code} ${r.project_name}`,
        description: `${r.date} ${r.description} (${r.user_name})`,
        quantity: 1,
        unit: 'st',
        rate: r.amount,
        amount: round2(r.amount),
      }));

    const mileage = db
      .prepare(
        `SELECT p.code AS project_code, p.name AS project_name, u.name AS user_name, m.rate_per_km AS rate, SUM(m.km) AS km
         FROM mileage m JOIN users u ON u.id = m.user_id JOIN projects p ON p.id = m.project_id
         WHERE ${filter('m')} AND m.billable = 1 ${scope}
           ${invoiceId ? '' : 'AND m.trip_date BETWEEN :from AND :to'}
         GROUP BY p.id, u.id, m.rate_per_km
         ORDER BY p.code, u.name`,
      )
      .all(params)
      .map((r) => ({
        kind: 'Körning',
        project: `${r.project_code} ${r.project_name}`,
        description: `Bilersättning – ${r.user_name}`,
        quantity: round2(r.km),
        unit: 'km',
        rate: r.rate,
        amount: round2(r.km * r.rate),
      }));

    const lines = [...time, ...expenses, ...mileage];
    return { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) };
  }

  const loadInvoice = (id) => {
    const inv = db
      .prepare(
        `SELECT i.*, c.name AS customer_name, u.name AS created_by_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?`,
      )
      .get(id);
    if (!inv) throw notFound('Underlaget finns inte.');
    inv.number = `${inv.created_at.slice(0, 4)}-${String(inv.id).padStart(4, '0')}`;
    return inv;
  };

  const periodParams = (src) => {
    const from = optDate(src.from, 'Från');
    const to = optDate(src.to, 'Till');
    if (!from || !to) throw bad('Ange både från- och tilldatum.');
    if (to < from) throw bad('Tilldatum kan inte ligga före fråndatum.');
    return { customerId: reqId(src.customer_id, 'Kund'), from, to };
  };

  router.add('GET', '/api/invoices/preview', { auth: 'admin' }, ({ query }) => {
    const { customerId, from, to } = periodParams(query);
    const { lines, total } = buildLines(customerId, from, to);
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM time_entries te JOIN activities a ON a.id = te.activity_id JOIN projects p ON p.id = a.project_id
         WHERE p.customer_id = ? AND te.status IN ('open','submitted') AND te.billable = 1 AND te.work_date BETWEEN ? AND ?`,
      )
      .get(customerId, from, to).n;
    return { lines, total, unapproved_entries: pending };
  });

  router.add('POST', '/api/invoices', { auth: 'admin' }, ({ user, body }) => {
    const { customerId, from, to } = periodParams(body);
    const note = parse(body, { note: f.str({ max: 500, label: 'Anteckning' }) }).note ?? '';
    return tx(db, () => {
      const { lines, total } = buildLines(customerId, from, to);
      if (!lines.length) throw bad('Det finns inget ofakturerat och godkänt att fakturera för perioden.');
      const id = db
        .prepare(
          'INSERT INTO invoices (customer_id, period_from, period_to, note, total_amount, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(customerId, from, to, note, total, user.id).lastInsertRowid;

      const mark = (table, dateCol, extra = '') =>
        db
          .prepare(
            `UPDATE ${table} SET invoice_id = ?
             WHERE id IN (SELECT x.id FROM ${table} x ${extra} WHERE x.invoice_id IS NULL AND x.status = 'approved'
               AND x.${dateCol} BETWEEN ? AND ? AND p.customer_id = ? AND x.billable = 1 ${table === 'time_entries' ? "AND p.billing_type = 'hourly'" : ''})`,
          )
          .run(id, from, to, customerId);
      mark('time_entries', 'work_date', 'JOIN activities a ON a.id = x.activity_id JOIN projects p ON p.id = a.project_id');
      mark('expenses', 'expense_date', 'JOIN projects p ON p.id = x.project_id');
      mark('mileage', 'trip_date', 'JOIN projects p ON p.id = x.project_id');
      return { id };
    });
  });

  router.add('GET', '/api/invoices', { auth: 'admin' }, () =>
    db
      .prepare(
        `SELECT i.id, i.customer_id, c.name AS customer_name, i.period_from, i.period_to, i.total_amount,
                i.created_at, substr(i.created_at, 1, 4) || '-' || printf('%04d', i.id) AS number
         FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC`,
      )
      .all(),
  );

  router.add('GET', '/api/invoices/:id', { auth: 'admin' }, ({ params, query, res }) => {
    const inv = loadInvoice(Number(params.id));
    const { lines, total } = buildLines(inv.customer_id, inv.period_from, inv.period_to, inv.id);
    if (query.format === 'csv') {
      const columns = [
        { key: 'kind', label: 'Typ' },
        { key: 'project', label: 'Projekt' },
        { key: 'description', label: 'Beskrivning' },
        { key: 'quantity', label: 'Antal' },
        { key: 'unit', label: 'Enhet' },
        { key: 'rate', label: 'À-pris' },
        { key: 'amount', label: 'Belopp' },
      ];
      sendText(res, 200, toCsv(columns, [...lines, { description: 'Summa', amount: total }]), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="fakturaunderlag-${inv.number}.csv"`,
      });
      return HANDLED;
    }
    return { ...inv, lines, total };
  });

  // Ångra underlaget: raderna blir fakturerbara igen.
  router.add('DELETE', '/api/invoices/:id', { auth: 'admin' }, ({ params }) => {
    const id = Number(params.id);
    loadInvoice(id);
    tx(db, () => {
      for (const t of ['time_entries', 'expenses', 'mileage']) {
        db.prepare(`UPDATE ${t} SET invoice_id = NULL WHERE invoice_id = ?`).run(id);
      }
      db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    });
    return { ok: true };
  });
}
