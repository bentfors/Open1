import { HANDLED, bad, conflict, notFound, sendText } from '../http.js';
import { f, parse, reqId, optId, optDate } from '../validate.js';
import { tx } from '../db.js';
import { monthEnd, previousMonthEnd, today } from '../dates.js';
import { getSettings, round2 } from '../domain.js';
import { toCsv } from '../csv.js';
import { ITEMS_CTE, INVOICE_NUMBER_SQL, TABLES, classify } from '../billing.js';
import { audit } from '../audit.js';

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

const KIND_TEXT = { time: ['tidpost', 'tidposter'], expense: ['utlägg', 'utlägg'], mileage: ['körning', 'körningar'] };
const countText = (ids) =>
  Object.entries(ids)
    .filter(([, list]) => list.length)
    .map(([kind, list]) => `${list.length} ${KIND_TEXT[kind][list.length === 1 ? 0 : 1]}`)
    .join(', ');

export function registerBilling({ db, router }) {
  // Vilket projekt och vilken person raderna gäller, om det bara är ett. Annars lämnas fältet tomt i loggen.
  function scopeOf(ids) {
    const projects = new Set();
    const users = new Set();
    for (const [kind, list] of Object.entries(ids)) {
      if (!list.length) continue;
      const sql =
        kind === 'time'
          ? `SELECT DISTINCT a.project_id AS p, te.user_id AS u FROM time_entries te JOIN activities a ON a.id = te.activity_id WHERE te.id IN (${placeholders(list)})`
          : `SELECT DISTINCT project_id AS p, user_id AS u FROM ${TABLES[kind].table} WHERE id IN (${placeholders(list)})`;
      for (const r of db.prepare(sql).all(...list)) {
        projects.add(r.p);
        users.add(r.u);
      }
    }
    return {
      projectId: projects.size === 1 ? ([...projects][0] ?? null) : null,
      userId: users.size === 1 ? [...users][0] : null,
      more: projects.size > 1 ? ` (${projects.size} projekt)` : '',
    };
  }

  // ── Projekt- och kundvy ───────────────────────────────────────────────
  router.add('GET', '/api/billing/items', { auth: 'finance' }, ({ query }) => {
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
  router.add('POST', '/api/billing/waive', { auth: 'finance_super' }, ({ user, body }) => {
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
      const scope = scopeOf(ids);
      audit(db, user, { entity: 'billing', action: 'waive', label: countText(ids), projectId: scope.projectId, userId: scope.userId, note: `Anledning: ${note}${scope.more}` });
      return { waived: n };
    });
  });

  router.add('POST', '/api/billing/restore', { auth: 'finance_super' }, ({ user, body }) => {
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
      const scope = scopeOf(ids);
      audit(db, user, { entity: 'billing', action: 'restore', label: countText(ids), projectId: scope.projectId, userId: scope.userId, note: scope.more.trim() });
      return { restored: n };
    });
  });

  // ── Fakturaunderlag ───────────────────────────────────────────────────
  // Raderna på ett underlag, med artikel- och projektnummer så att de kan föras över till ekonomisystemet.
  function buildLines(invoiceId) {
    const settings = getSettings(db);
    const time = db
      .prepare(
        `SELECT p.code AS project_code, p.name AS project_name, a.name AS activity_name, a.article_no, u.name AS user_name,
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
        article_no: r.article_no,
        project_code: r.project_code,
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
        article_no: settings.article_no_expense,
        project_code: r.project_code,
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
        article_no: settings.article_no_mileage,
        project_code: r.project_code,
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

  /**
   * Skapar ett fakturaunderlag av valda rader för en kund. Anropas inuti en transaktion.
   * Alla rader måste gå att fakturera, annars skapas inget.
   */
  function createInvoice(user, customerId, ids, { invoice_date, note }) {
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
      .run(customerId, dates[0], dates.at(-1), note ?? '', user.id, invoice_date ?? today()).lastInsertRowid;
    for (const [kind, list] of Object.entries(ids)) {
      if (list.length) db.prepare(`UPDATE ${TABLES[kind].table} SET invoice_id = ? WHERE id IN (${placeholders(list)})`).run(invoiceId, ...list);
    }
    const { total } = buildLines(invoiceId);
    db.prepare('UPDATE invoices SET total_amount = ? WHERE id = ?').run(total, invoiceId);
    const { number } = db.prepare(`SELECT ${INVOICE_NUMBER_SQL} AS number FROM invoices inv WHERE inv.id = ?`).get(invoiceId);
    const scope = scopeOf(ids);
    audit(db, user, { entity: 'invoice', action: 'create', entityId: invoiceId, label: number, customerId, projectId: scope.projectId, note: `${countText(ids)}, ${total} kr${scope.more}` });
    return { id: invoiceId, total, number };
  }

  router.add('POST', '/api/invoices', { auth: 'finance' }, ({ user, body }) => {
    const customerId = reqId(body.customer_id, 'Kund');
    const ids = idLists(body);
    const data = parse(body, {
      invoice_date: f.date({ label: 'Fakturadatum' }),
      note: f.str({ max: 500, label: 'Anteckning' }),
    });
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw bad('Kunden finns inte.');
    return tx(db, () => createInvoice(user, customerId, ids, data));
  });

  // ── Månadsfakturering ─────────────────────────────────────────────────
  // Det som kan faktureras nu: godkänt, debiterbart, på löpande räkning, varken fakturerat eller avskrivet.
  const READY = `i.status = 'approved' AND i.billable = 1 AND i.invoice_id IS NULL AND i.waived_at IS NULL AND NOT (i.kind = 'time' AND i.billing_type <> 'hourly')`;
  const IN_SCOPE = `i.date <= :to AND (:older = 1 OR i.date >= :from)`;

  // Månaden som körs (förvalt förra månaden). Äldre ofakturerat följer med som standard, så att inget blir liggande.
  function monthScope(input) {
    const month = input.month || previousMonthEnd(today()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Ange månad som ÅÅÅÅ-MM.');
    const older = !(input.include_older === false || input.include_older === '0');
    const from = `${month}-01`;
    return { month, from, to: monthEnd(from), older: older ? 1 : 0, params: { from, to: monthEnd(from), older: older ? 1 : 0 } };
  }

  router.add('GET', '/api/billing/month', { auth: 'finance' }, ({ query }) => {
    const scope = monthScope(query);
    const rows = db
      .prepare(
        `${ITEMS_CTE}
         SELECT c.id AS customer_id, c.name AS customer_name, c.ext_no,
                COUNT(DISTINCT CASE WHEN ${READY} AND ${IN_SCOPE} THEN i.project_id END) AS projects,
                SUM(CASE WHEN ${READY} AND ${IN_SCOPE} THEN 1 ELSE 0 END) AS ready_rows,
                SUM(CASE WHEN ${READY} AND ${IN_SCOPE} THEN i.amount ELSE 0 END) AS ready,
                SUM(CASE WHEN ${READY} AND :older = 1 AND i.date < :from THEN i.amount ELSE 0 END) AS older_amount,
                SUM(CASE WHEN i.status = 'submitted' AND i.billable = 1 AND i.invoice_id IS NULL AND i.waived_at IS NULL
                          AND NOT (i.kind = 'time' AND i.billing_type <> 'hourly') AND i.date BETWEEN :from AND :to THEN i.amount ELSE 0 END) AS waiting,
                SUM(CASE WHEN i.kind = 'time' AND i.status = 'open' AND i.billable = 1 AND i.date BETWEEN :from AND :to THEN i.minutes ELSE 0 END) AS draft_minutes,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type = 'fixed' AND i.status <> 'rejected' AND i.invoice_id IS NULL AND i.waived_at IS NULL
                          AND i.date BETWEEN :from AND :to THEN i.minutes ELSE 0 END) AS fixed_minutes
         FROM items i JOIN customers c ON c.id = i.customer_id
         WHERE i.date <= :to
         GROUP BY c.id
         HAVING ready > 0 OR waiting > 0 OR draft_minutes > 0 OR fixed_minutes > 0
         ORDER BY c.name`,
      )
      .all(scope.params)
      .map((r) => ({
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        ext_no: r.ext_no,
        projects: r.projects,
        ready_rows: r.ready_rows,
        ready: round2(r.ready),
        older: round2(r.older_amount),
        waiting: round2(r.waiting),
        draft_hours: round2(r.draft_minutes / 60),
        fixed_hours: round2(r.fixed_minutes / 60),
      }));
    const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
    return {
      month: scope.month,
      from: scope.from,
      to: scope.to,
      include_older: !!scope.older,
      rows,
      totals: { ready: sum('ready'), older: sum('older'), waiting: sum('waiting'), draft_hours: sum('draft_hours'), fixed_hours: sum('fixed_hours'), customers: rows.filter((r) => r.ready > 0).length },
    };
  });

  // Ett underlag per vald kund med allt som kan faktureras i perioden. Allt eller inget: misslyckas en kund skapas inget.
  router.add('POST', '/api/billing/month', { auth: 'finance' }, ({ user, body }) => {
    const scope = monthScope(body);
    const data = parse(body, { invoice_date: f.date({ label: 'Fakturadatum' }) });
    const raw = body.customer_ids;
    if (!Array.isArray(raw) || !raw.length || raw.length > 1000 || !raw.every((n) => Number.isInteger(n) && n > 0)) throw bad('Välj minst en kund.');
    const customerIds = [...new Set(raw)];
    const itemsOf = db.prepare(`${ITEMS_CTE} SELECT i.kind, i.id FROM items i WHERE i.customer_id = :customer AND ${READY} AND ${IN_SCOPE} ORDER BY i.date`);
    const created = tx(db, () =>
      customerIds.map((customerId) => {
        const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
        if (!customer) throw bad('En vald kund finns inte.');
        const ids = { time: [], expense: [], mileage: [] };
        for (const r of itemsOf.all({ ...scope.params, customer: customerId })) ids[r.kind].push(r.id);
        if (!ids.time.length && !ids.expense.length && !ids.mileage.length) throw conflict(`${customer.name} har inget att fakturera för ${scope.month}.`);
        return { customer_id: customerId, customer_name: customer.name, ...createInvoice(user, customerId, ids, { invoice_date: data.invoice_date, note: `Månadsfakturering ${scope.month}` }) };
      }),
    );
    return { month: scope.month, created, total: round2(created.reduce((s, c) => s + c.total, 0)) };
  });

  const loadInvoice = (id) => {
    const inv = db
      .prepare(
        `SELECT inv.*, ${INVOICE_NUMBER_SQL} AS number, c.name AS customer_name, c.ext_no AS customer_no, u.name AS created_by_name
         FROM invoices inv JOIN customers c ON c.id = inv.customer_id LEFT JOIN users u ON u.id = inv.created_by
         WHERE inv.id = ?`,
      )
      .get(id);
    if (!inv) throw notFound('Underlaget finns inte.');
    return inv;
  };

  router.add('GET', '/api/invoices', { auth: 'finance' }, () =>
    db
      .prepare(
        `SELECT inv.id, inv.customer_id, c.name AS customer_name, inv.period_from, inv.period_to, inv.invoice_date,
                inv.total_amount, inv.created_at, inv.note, ${INVOICE_NUMBER_SQL} AS number
         FROM invoices inv JOIN customers c ON c.id = inv.customer_id ORDER BY inv.id DESC`,
      )
      .all(),
  );

  router.add('GET', '/api/invoices/:id', { auth: 'finance' }, ({ params, query, res }) => {
    const inv = loadInvoice(Number(params.id));
    const { lines, total } = buildLines(inv.id);
    if (query.format === 'csv') {
      // Kundnummer, artikelnummer och projektnummer per rad, i den form fakturarader har i ekonomisystem som Fortnox.
      const columns = [
        { key: 'customer_no', label: 'Kundnummer' },
        { key: 'kind', label: 'Typ' },
        { key: 'article_no', label: 'Artikelnummer' },
        { key: 'project_code', label: 'Projektnummer' },
        { key: 'project', label: 'Projekt' },
        { key: 'description', label: 'Beskrivning' },
        { key: 'quantity', label: 'Antal' },
        { key: 'unit', label: 'Enhet' },
        { key: 'rate', label: 'À-pris' },
        { key: 'amount', label: 'Belopp' },
      ];
      const rows = lines.map((l) => ({ ...l, customer_no: inv.customer_no }));
      sendText(res, 200, toCsv(columns, [...rows, { description: 'Summa', amount: total }]), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="fakturaunderlag-${inv.number}.csv"`,
      });
      return HANDLED;
    }
    return { ...inv, lines, total };
  });

  // Ångra underlaget: raderna blir fakturerbara igen.
  router.add('DELETE', '/api/invoices/:id', { auth: 'finance_super' }, ({ params, user }) => {
    const id = Number(params.id);
    const inv = loadInvoice(id);
    tx(db, () => {
      const rows = Object.fromEntries(Object.entries(TABLES).map(([kind, { table }]) => [kind, db.prepare(`SELECT id FROM ${table} WHERE invoice_id = ?`).all(id).map((r) => r.id)]));
      const scope = scopeOf(rows);
      audit(db, user, { entity: 'invoice', action: 'undo', entityId: id, label: inv.number, customerId: inv.customer_id, projectId: scope.projectId, note: `${countText(rows)}, ${inv.total_amount} kr${scope.more}. Raderna kan faktureras igen.` });
      for (const { table } of Object.values(TABLES)) db.prepare(`UPDATE ${table} SET invoice_id = NULL WHERE invoice_id = ?`).run(id);
      db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    });
    return { ok: true };
  });
}
