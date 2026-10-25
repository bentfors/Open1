import { HANDLED, bad, conflict, notFound, sendText } from '../http.js';
import { f, parse, reqId, optId, optDate } from '../validate.js';
import { tx } from '../db.js';
import { today } from '../dates.js';
import { round2 } from '../domain.js';
import { toCsv } from '../csv.js';
import { ITEMS_CTE, INVOICE_NUMBER_SQL, TABLES, classify } from '../billing.js';

const MAX_ROWS = 3000;
const MAX_IDS = 5000;

function idLists(body) {
  const out = {};
  let total = 0;
  for (const [kind, key] of [['time', 'time_ids'], ['expense', 'expense_ids'], ['mileage', 'mileage_ids']]) {
    const raw = body[key] ?? [];
    if (!Array.isArray(raw) || !raw.every((n) => Number.isInteger(n) && n > 0)) throw bad('Ogiltig radlista.');
    out[kind] = [...new Set(raw)];
    total += out[kind].length;
  }
  if (!total) throw bad('Markera minst en rad.');
  if (total > MAX_IDS) throw bad(`Högst ${MAX_IDS} rader åt gången.`);
  return out;
}

const placeholders = (ids) => ids.map(() => '?').join(',');

export function registerBilling({ db, router }) {
  // ── Projekt- och kundvy ───────────────────────────────────────────────
  router.add('GET', '/api/billing/items', { auth: 'admin' }, ({ query }) => {
    const project = optId(query.project_id, 'Projekt') ?? null;
    const customer = optId(query.customer_id, 'Kund') ?? null;
    if (!project && !customer) throw bad('Ange projekt eller kund.');
    const show = ['open', 'invoiced', 'waived', 'all'].includes(query.show) ? query.show : 'open';
    const params = {
      project,
      customer,
      from: optDate(query.from, 'Från') ?? '0000-01-01',
      to: optDate(query.to, 'Till') ?? '9999-12-31',
      show,
    };
    const scope = `(:project IS NULL OR i.project_id = :project) AND (:customer IS NULL OR i.customer_id = :customer)`;

    const rows = db
      .prepare(
        `${ITEMS_CTE}
         SELECT i.*, u.name AS user_name, p.code AS project_code, p.name AS project_name, c.name AS customer_name,
                inv.invoice_date AS invoice_date, ${INVOICE_NUMBER_SQL} AS invoice_number
         FROM items i
         JOIN users u ON u.id = i.user_id
         JOIN projects p ON p.id = i.project_id
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN invoices inv ON inv.id = i.invoice_id
         WHERE ${scope} AND i.date BETWEEN :from AND :to
           AND (:show = 'all'
                OR (:show = 'open' AND i.invoice_id IS NULL AND i.waived_at IS NULL)
                OR (:show = 'invoiced' AND i.invoice_id IS NOT NULL)
                OR (:show = 'waived' AND i.waived_at IS NOT NULL))
         ORDER BY i.date, i.kind, i.id
         LIMIT ${MAX_ROWS + 1}`,
      )
      .all(params);
    const truncated = rows.length > MAX_ROWS;
    if (truncated) rows.pop();

    const items = rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      date: r.date,
      user_name: r.user_name,
      project_id: r.project_id,
      project_code: r.project_code,
      project_name: r.project_name,
      customer_name: r.customer_name,
      billing_type: r.billing_type,
      what: r.what,
      note: r.note,
      quantity: round2(r.quantity),
      unit: r.unit,
      rate: r.rate,
      amount: round2(r.amount),
      billable: !!r.billable,
      status: r.status,
      invoice_id: r.invoice_id,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      waived_note: r.waived_note,
      ...classify(r),
    }));

    // Sammanställning för hela omfattningen, oberoende av period och visningsfilter.
    const s = db
      .prepare(
        `${ITEMS_CTE}
         SELECT
           COALESCE(SUM(CASE WHEN i.kind = 'time' AND i.status <> 'rejected' THEN i.minutes END), 0) AS minutes_all,
           COALESCE(SUM(CASE WHEN i.kind = 'time' AND i.status <> 'rejected' AND i.billable = 1 THEN i.minutes END), 0) AS minutes_billable,
           COALESCE(SUM(CASE WHEN i.invoice_id IS NOT NULL THEN i.amount END), 0) AS invoiced,
           COALESCE(SUM(CASE WHEN i.invoice_id IS NULL AND i.waived_at IS NULL AND i.status = 'approved' AND i.billable = 1
                              AND NOT (i.kind = 'time' AND i.billing_type <> 'hourly') THEN i.amount END), 0) AS open_approved,
           COALESCE(SUM(CASE WHEN i.invoice_id IS NULL AND i.waived_at IS NULL AND i.status IN ('open','submitted') AND i.billable = 1
                              AND NOT (i.kind = 'time' AND i.billing_type <> 'hourly') THEN i.amount END), 0) AS open_unapproved,
           COALESCE(SUM(CASE WHEN i.waived_at IS NOT NULL AND i.invoice_id IS NULL THEN i.amount END), 0) AS waived
         FROM items i WHERE ${scope}`,
      )
      .get({ project, customer });

    const meta = project
      ? db
          .prepare(
            `SELECT p.id, p.code, p.name, p.billing_type, p.budget_hours, p.budget_amount, p.customer_id, c.name AS customer_name
             FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`,
          )
          .get(project)
      : db.prepare('SELECT id AS customer_id, name AS customer_name FROM customers WHERE id = ?').get(customer);
    if (!meta) throw notFound('Projektet eller kunden finns inte.');

    return {
      scope: project ? 'project' : 'customer',
      meta,
      items,
      truncated,
      summary: {
        hours: round2(s.minutes_all / 60),
        billable_hours: round2(s.minutes_billable / 60),
        invoiced: round2(s.invoiced),
        open_approved: round2(s.open_approved),
        open_unapproved: round2(s.open_unapproved),
        waived: round2(s.waived),
      },
    };
  });

  // ── Avskrivning ───────────────────────────────────────────────────────
  // Rader som aldrig ska faktureras (kulans timmar, fast pris som faktureras separat) lämnar kön
  // och upplupet, men finns kvar i projektvyn under "Avskrivet".
  router.add('POST', '/api/billing/waive', { auth: 'admin' }, ({ user, body }) => {
    const ids = idLists(body);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    if (!note) throw bad('Ange en anledning.');
    return tx(db, () => {
      let n = 0;
      for (const [kind, list] of Object.entries(ids)) {
        if (!list.length) continue;
        const t = TABLES[kind].table;
        const found = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE id IN (${placeholders(list)}) AND invoice_id IS NULL AND waived_at IS NULL`).get(...list).n;
        if (found !== list.length) throw conflict('Någon rad är redan fakturerad eller avskriven.');
        db.prepare(`UPDATE ${t} SET waived_at = datetime('now'), waived_by = ?, waived_note = ? WHERE id IN (${placeholders(list)})`).run(user.id, note, ...list);
        n += list.length;
      }
      return { waived: n };
    });
  });

  router.add('POST', '/api/billing/restore', { auth: 'admin' }, ({ body }) => {
    const ids = idLists(body);
    return tx(db, () => {
      let n = 0;
      for (const [kind, list] of Object.entries(ids)) {
        if (!list.length) continue;
        const t = TABLES[kind].table;
        const found = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE id IN (${placeholders(list)}) AND waived_at IS NOT NULL AND invoice_id IS NULL`).get(...list).n;
        if (found !== list.length) throw conflict('Någon rad är inte avskriven.');
        db.prepare(`UPDATE ${t} SET waived_at = NULL, waived_by = NULL, waived_note = NULL WHERE id IN (${placeholders(list)})`).run(...list);
        n += list.length;
      }
      return { restored: n };
    });
  });

  // ── Fakturaunderlag ───────────────────────────────────────────────────
  function buildLines(invoiceId) {
    const time = db
      .prepare(
        `SELECT p.code AS project_code, p.name AS project_name, a.name AS activity_name, u.name AS user_name,
                te.bill_rate AS rate, SUM(te.minutes) AS minutes
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN activities a ON a.id = te.activity_id
         JOIN projects p ON p.id = a.project_id
         WHERE te.invoice_id = ?
         GROUP BY p.id, a.id, u.id, te.bill_rate
         ORDER BY p.code, a.name, u.name`,
      )
      .all(invoiceId)
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
         WHERE e.invoice_id = ? ORDER BY p.code, e.expense_date`,
      )
      .all(invoiceId)
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
         WHERE m.invoice_id = ? GROUP BY p.id, u.id, m.rate_per_km ORDER BY p.code, u.name`,
      )
      .all(invoiceId)
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

  // Villkoren för att en rad får faktureras. Samma regler som classify() i webbvyn.
  const INVOICABLE = {
    time: `SELECT te.id, te.work_date AS date FROM time_entries te
           JOIN activities a ON a.id = te.activity_id JOIN projects p ON p.id = a.project_id
           WHERE te.id IN (%IDS%) AND p.customer_id = ? AND te.status = 'approved' AND te.billable = 1
             AND te.invoice_id IS NULL AND te.waived_at IS NULL AND p.billing_type = 'hourly'`,
    expense: `SELECT e.id, e.expense_date AS date FROM expenses e JOIN projects p ON p.id = e.project_id
              WHERE e.id IN (%IDS%) AND p.customer_id = ? AND e.status = 'approved' AND e.billable = 1
                AND e.invoice_id IS NULL AND e.waived_at IS NULL`,
    mileage: `SELECT m.id, m.trip_date AS date FROM mileage m JOIN projects p ON p.id = m.project_id
              WHERE m.id IN (%IDS%) AND p.customer_id = ? AND m.status = 'approved' AND m.billable = 1
                AND m.invoice_id IS NULL AND m.waived_at IS NULL`,
  };

  router.add('POST', '/api/invoices', { auth: 'admin' }, ({ user, body }) => {
    const customerId = reqId(body.customer_id, 'Kund');
    const ids = idLists(body);
    const data = parse(body, {
      invoice_date: f.date({ label: 'Fakturadatum' }),
      note: f.str({ max: 500, label: 'Anteckning' }),
    });
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw bad('Kunden finns inte.');

    return tx(db, () => {
      const dates = [];
      for (const [kind, list] of Object.entries(ids)) {
        if (!list.length) continue;
        const found = db.prepare(INVOICABLE[kind].replace('%IDS%', placeholders(list))).all(...list, customerId);
        if (found.length !== list.length) {
          throw conflict('Någon rad kan inte faktureras. Den kan vara felaktigt vald, ej godkänd, avskriven, redan fakturerad eller höra till en annan kund.');
        }
        dates.push(...found.map((r) => r.date));
      }
      dates.sort();
      const invoiceId = db
        .prepare(
          `INSERT INTO invoices (customer_id, period_from, period_to, note, total_amount, created_by, invoice_date)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(customerId, dates[0], dates.at(-1), data.note ?? '', user.id, data.invoice_date ?? today()).lastInsertRowid;
      for (const [kind, list] of Object.entries(ids)) {
        if (list.length) db.prepare(`UPDATE ${TABLES[kind].table} SET invoice_id = ? WHERE id IN (${placeholders(list)})`).run(invoiceId, ...list);
      }
      const { total } = buildLines(invoiceId);
      db.prepare('UPDATE invoices SET total_amount = ? WHERE id = ?').run(total, invoiceId);
      const { number } = db.prepare(`SELECT ${INVOICE_NUMBER_SQL} AS number FROM invoices inv WHERE inv.id = ?`).get(invoiceId);
      return { id: invoiceId, total, number };
    });
  });

  const loadInvoice = (id) => {
    const inv = db
      .prepare(
        `SELECT inv.*, ${INVOICE_NUMBER_SQL} AS number, c.name AS customer_name, u.name AS created_by_name
         FROM invoices inv JOIN customers c ON c.id = inv.customer_id LEFT JOIN users u ON u.id = inv.created_by
         WHERE inv.id = ?`,
      )
      .get(id);
    if (!inv) throw notFound('Underlaget finns inte.');
    return inv;
  };

  router.add('GET', '/api/invoices', { auth: 'admin' }, () =>
    db
      .prepare(
        `SELECT inv.id, inv.customer_id, c.name AS customer_name, inv.period_from, inv.period_to, inv.invoice_date,
                inv.total_amount, inv.created_at, inv.note, ${INVOICE_NUMBER_SQL} AS number
         FROM invoices inv JOIN customers c ON c.id = inv.customer_id ORDER BY inv.id DESC`,
      )
      .all(),
  );

  router.add('GET', '/api/invoices/:id', { auth: 'admin' }, ({ params, query, res }) => {
    const inv = loadInvoice(Number(params.id));
    const { lines, total } = buildLines(inv.id);
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
      for (const { table } of Object.values(TABLES)) db.prepare(`UPDATE ${table} SET invoice_id = NULL WHERE invoice_id = ?`).run(id);
      db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    });
    return { ok: true };
  });
}
