import { HANDLED, bad, sendText } from '../http.js';
import { optDate, optId } from '../validate.js';
import { getSettings, isAdmin, round2 } from '../domain.js';
import { toCsv } from '../csv.js';
import { computeCommissions, summarizeEarners } from '../commission.js';
import { ITEMS_CTE } from '../billing.js';
import { today, addDays } from '../dates.js';

const GROUPS = {
  customer: { key: 'c.id', label: 'c.name', title: 'Kund' },
  project: { key: 'p.id', label: "p.code || ' ' || p.name", title: 'Projekt' },
  activity: { key: 'a.id', label: "p.code || ' › ' || a.name", title: 'Aktivitet' },
  user: { key: 'u.id', label: 'u.name', title: 'Användare' },
  category: { key: "COALESCE(uc.id, 0)", label: "COALESCE(uc.name, '(ingen kategori)')", title: 'Kategori' },
  month: { key: "substr(te.work_date, 1, 7)", label: "substr(te.work_date, 1, 7)", title: 'Månad' },
  day: { key: 'te.work_date', label: 'te.work_date', title: 'Dag' },
  absence: { key: 'at.id', label: 'at.name', title: 'Frånvarotyp' },
};

const ACCRUED_GROUPS = {
  customer: { key: 'c.id', label: 'c.name', title: 'Kund', extra: '' },
  project: { key: 'p.id', label: "p.code || ' ' || p.name", title: 'Projekt', extra: 'c.name AS customer_name, c.id AS customer_id, p.billing_type AS billing_type,' },
  user: { key: 'u.id', label: 'u.name', title: 'Användare', extra: '' },
  month: { key: 'substr(i.date, 1, 7)', label: 'substr(i.date, 1, 7)', title: 'Månad', extra: '' },
  all: { key: '0', label: "'Totalt'", title: 'Totalt', extra: '' },
};

const hours = (minutes) => round2(minutes / 60);

function sendCsv(res, filename, columns, rows) {
  sendText(res, 200, toCsv(columns, rows), 'text/csv; charset=utf-8', {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  return HANDLED;
}

function period(query) {
  const from = optDate(query.from, 'Från');
  const to = optDate(query.to, 'Till');
  if (!from || !to) throw bad('Ange både från- och tilldatum.');
  if (to < from) throw bad('Tilldatum kan inte ligga före fråndatum.');
  return { from, to };
}

export function registerReports({ db, router }) {
  /**
   * Tidrapport. Admin ser allt inklusive pengar. Övriga ser tid för sig själva, sina projekt
   * (som projektledare) och sina direkt underställda, men aldrig priser, kostnader eller TB.
   */
  router.add('GET', '/api/reports/time', {}, ({ user, query, res }) => {
    const { from, to } = period(query);
    const groupBy = Object.hasOwn(GROUPS, query.group_by) ? query.group_by : 'project';
    const g = GROUPS[groupBy];
    const admin = isAdmin(user);

    const params = {
      from,
      to,
      customer: optId(query.customer_id, 'Kund') ?? null,
      project: optId(query.project_id, 'Projekt') ?? null,
      person: optId(query.user_id, 'Användare') ?? null,
      category: optId(query.category_id, 'Kategori') ?? null,
      isAdmin: admin ? 1 : 0,
      actor: user.id,
      approvedOnly: query.status === 'approved' ? 1 : 0,
      billable: query.billable === 'yes' ? 1 : query.billable === 'no' ? 0 : null,
    };
    if (!['yes', 'no', undefined, '', 'all'].includes(query.billable)) throw bad('Ogiltigt debiteringsfilter.');

    const rows = db
      .prepare(
        `SELECT ${g.key} AS grp_key, ${g.label} AS label,
                SUM(te.minutes) AS minutes,
                SUM(CASE WHEN te.billable = 1 THEN te.minutes ELSE 0 END) AS billable_minutes,
                SUM(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
                SUM(CASE WHEN te.activity_id IS NOT NULL THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         LEFT JOIN categories uc ON uc.id = u.category_id
         LEFT JOIN activities a ON a.id = te.activity_id
         LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN absence_types at ON at.id = te.absence_type_id
         WHERE te.work_date BETWEEN :from AND :to
           AND (:isAdmin = 1 OR te.user_id = :actor OR p.manager_id = :actor OR u.manager_id = :actor)
           AND (:customer IS NULL OR c.id = :customer)
           AND (:project IS NULL OR p.id = :project)
           AND (:person IS NULL OR te.user_id = :person)
           AND (:category IS NULL OR u.category_id = :category)
           AND (:approvedOnly = 0 OR te.status = 'approved')
           AND (:billable IS NULL OR te.billable = :billable)
         GROUP BY grp_key
         ORDER BY label`,
      )
      .all(params);

    const out = rows.map((r) => ({
      key: r.grp_key,
      label: r.label ?? '(frånvaro)',
      hours: hours(r.minutes),
      billable_hours: hours(r.billable_minutes),
      ...(admin ? { revenue: round2(r.revenue), cost: round2(r.cost), margin: round2(r.revenue - r.cost) } : {}),
    }));
    const total = out.reduce(
      (t, r) => ({
        hours: round2(t.hours + r.hours),
        billable_hours: round2(t.billable_hours + r.billable_hours),
        ...(admin
          ? { revenue: round2(t.revenue + r.revenue), cost: round2(t.cost + r.cost), margin: round2(t.margin + r.margin) }
          : {}),
      }),
      admin ? { hours: 0, billable_hours: 0, revenue: 0, cost: 0, margin: 0 } : { hours: 0, billable_hours: 0 },
    );

    if (query.format === 'csv') {
      const columns = [
        { key: 'label', label: g.title },
        { key: 'hours', label: 'Timmar' },
        { key: 'billable_hours', label: 'Debiterbara timmar' },
        ...(admin
          ? [
              { key: 'revenue', label: 'Intäkt' },
              { key: 'cost', label: 'Kostnad' },
              { key: 'margin', label: 'TB' },
            ]
          : []),
      ];
      return sendCsv(res, `tidrapport-${from}-${to}.csv`, columns, [...out, { label: 'Summa', ...total }]);
    }
    return { group_by: groupBy, group_title: g.title, rows: out, total };
  });

  /**
   * TB per konsult (bara administratörer).
   * TB = intäkt (debiterbara timmar × pris) − kostnad (timmar × intern timkostnad).
   * Frånvaro räknas inte. Inställningen tb_cost_basis avgör om ej debiterbar projekttid belastar TB.
   */
  router.add('GET', '/api/reports/margin', {}, ({ user, query }) => {
    const { from, to } = period(query);
    const settings = getSettings(db);
    if (!isAdmin(user)) return { cost_basis: settings.tb_cost_basis, consultants: [] };
    const consultants = db
      .prepare(
        `SELECT u.id AS user_id, u.name, c.name AS category,
                SUM(te.minutes) AS minutes,
                SUM(CASE WHEN te.billable = 1 THEN te.minutes ELSE 0 END) AS billable_minutes,
                SUM(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
                SUM(CASE WHEN :worked = 1 OR te.billable = 1 THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost
         FROM time_entries te JOIN users u ON u.id = te.user_id LEFT JOIN categories c ON c.id = u.category_id
         WHERE te.activity_id IS NOT NULL AND te.work_date BETWEEN :from AND :to
           AND (:all = 1 AND te.status <> 'rejected' OR te.status = 'approved')
         GROUP BY u.id ORDER BY u.name`,
      )
      .all({ from, to, all: query.status === 'all' ? 1 : 0, worked: settings.tb_cost_basis === 'billable' ? 0 : 1 })
      .map((r) => ({
        user_id: r.user_id,
        name: r.name,
        category: r.category,
        hours: hours(r.minutes),
        billable_hours: hours(r.billable_minutes),
        revenue: round2(r.revenue),
        cost: round2(r.cost),
        margin: round2(r.revenue - r.cost),
      }));
    return { cost_basis: settings.tb_cost_basis, consultants };
  });

  /**
   * Provision enligt reglerna under Admin → Provision. Administratörer ser alla, övriga bara sina egna.
   * Perioder räknas hela (månad eller kvartal) och markeras som pågående tills de är slut.
   */
  router.add('GET', '/api/reports/commission', {}, ({ user, query, res }) => {
    const { from, to } = period(query);
    if (to > addDays(from, 366 * 3)) throw bad('Välj högst tre år åt gången.');
    const rows = computeCommissions(db, {
      from,
      to,
      approvedOnly: query.status !== 'all',
      earnerId: isAdmin(user) ? (optId(query.earner_id, 'Mottagare') ?? null) : user.id,
    });
    if (query.format === 'csv') {
      const KIND = { tb_percent: 'Procent av TB', per_consultant: 'Belopp per konsult', tb_tiered: 'Trappa på antal konsulter' };
      const csvRows = rows.map((r) => ({
        earner: r.earner_name,
        category: r.earner_category,
        rule: r.rule_name,
        kind: KIND[r.kind],
        period: r.period_label,
        status: r.complete ? 'Avslutad' : 'Pågår',
        tb: r.tb,
        percent: r.percent,
        consultants: r.consultants,
        amount: r.amount_per_consultant,
        commission: r.commission,
      }));
      const columns = [
        { key: 'earner', label: 'Mottagare' },
        { key: 'category', label: 'Kategori' },
        { key: 'rule', label: 'Regel' },
        { key: 'kind', label: 'Typ' },
        { key: 'period', label: 'Period' },
        { key: 'status', label: 'Status' },
        { key: 'tb', label: 'TB' },
        { key: 'percent', label: 'Procent' },
        { key: 'consultants', label: 'Antal konsulter' },
        { key: 'amount', label: 'Belopp per konsult' },
        { key: 'commission', label: 'Provision' },
      ];
      return sendCsv(res, `provision-${from}-${to}.csv`, columns, csvRows);
    }
    return { rows, earners: summarizeEarners(rows), cost_basis: getSettings(db).tb_cost_basis };
  });

  /**
   * Upplupet: utfört men ännu inte fakturerat, för tid, utlägg och körning som avser datum från–till.
   * "Fakturerat" bedöms per fakturadatum: as_of (standard idag) anger vilket datum man tittar från,
   * så en rapport för förra månadens slut visar det som var ofakturerat då, även om det fakturerats senare.
   * Fastprisprojektens timmar redovisas för sig eftersom de inte faktureras per timme.
   */
  router.add('GET', '/api/reports/accrued', { auth: 'admin' }, ({ query, res }) => {
    const from = optDate(query.from, 'Från') ?? '0000-01-01';
    const to = optDate(query.to, 'Till') ?? '9999-12-31';
    if (to < from) throw bad('Tilldatum kan inte ligga före fråndatum.');
    const asOf = optDate(query.as_of, 'Fakturerat till och med') ?? today();
    const groupBy = Object.hasOwn(ACCRUED_GROUPS, query.group_by) ? query.group_by : 'customer';
    const g = ACCRUED_GROUPS[groupBy];

    const raw = db
      .prepare(
        `${ITEMS_CTE}
         SELECT ${g.key} AS grp_key, ${g.label} AS label, ${g.extra}
                COUNT(*) AS row_count, MIN(i.date) AS oldest,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type = 'hourly' AND i.status = 'approved' THEN i.minutes ELSE 0 END) AS min_a,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type = 'hourly' AND i.status <> 'approved' THEN i.minutes ELSE 0 END) AS min_u,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type = 'hourly' AND i.status = 'approved' THEN i.amount ELSE 0 END) AS time_a,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type = 'hourly' AND i.status <> 'approved' THEN i.amount ELSE 0 END) AS time_u,
                SUM(CASE WHEN i.kind <> 'time' AND i.status = 'approved' THEN i.amount ELSE 0 END) AS other_a,
                SUM(CASE WHEN i.kind <> 'time' AND i.status <> 'approved' THEN i.amount ELSE 0 END) AS other_u,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type <> 'hourly' THEN i.minutes ELSE 0 END) AS fixed_min,
                SUM(CASE WHEN i.kind = 'time' AND i.billing_type <> 'hourly' THEN i.amount ELSE 0 END) AS fixed_value
         FROM items i
         JOIN projects p ON p.id = i.project_id
         JOIN customers c ON c.id = i.customer_id
         JOIN users u ON u.id = i.user_id
         LEFT JOIN invoices inv ON inv.id = i.invoice_id
         WHERE i.billable = 1 AND i.status <> 'rejected' AND i.date BETWEEN :from AND :to
           AND (i.invoice_id IS NULL OR inv.invoice_date > :asOf)
           AND (i.waived_at IS NULL OR substr(i.waived_at, 1, 10) > :asOf)
         GROUP BY grp_key ORDER BY label`,
      )
      .all({ from, to, asOf });

    const rows = raw.map((r) => ({
      key: r.grp_key,
      label: r.label,
      ...(r.customer_name !== undefined ? { customer_name: r.customer_name, customer_id: r.customer_id, billing_type: r.billing_type } : {}),
      oldest: r.oldest,
      rows: r.row_count,
      hours_approved: hours(r.min_a),
      hours_unapproved: hours(r.min_u),
      time_approved: round2(r.time_a),
      time_unapproved: round2(r.time_u),
      other_approved: round2(r.other_a),
      other_unapproved: round2(r.other_u),
      total_approved: round2(r.time_a + r.other_a),
      total: round2(r.time_a + r.other_a + r.time_u + r.other_u),
      fixed_hours: hours(r.fixed_min),
      fixed_value: round2(r.fixed_value),
    }));
    // Rader som bara består av fast pris har inget att fakturera per timme men visas så att inget glöms bort.
    const sum = (k) => round2(rows.reduce((t, r) => t + r[k], 0));
    const total = Object.fromEntries(
      ['hours_approved', 'hours_unapproved', 'time_approved', 'time_unapproved', 'other_approved', 'other_unapproved', 'total_approved', 'total', 'fixed_hours', 'fixed_value'].map((k) => [k, sum(k)]),
    );

    if (query.format === 'csv') {
      const columns = [
        { key: 'label', label: g.title },
        { key: 'oldest', label: 'Äldsta datum' },
        { key: 'hours_approved', label: 'Timmar godkända' },
        { key: 'time_approved', label: 'Tid godkänd' },
        { key: 'hours_unapproved', label: 'Timmar ej godkända' },
        { key: 'time_unapproved', label: 'Tid ej godkänd' },
        { key: 'other_approved', label: 'Utlägg och körning godkänt' },
        { key: 'other_unapproved', label: 'Utlägg och körning ej godkänt' },
        { key: 'total_approved', label: 'Summa godkänt' },
        { key: 'total', label: 'Summa inkl. ej godkänt' },
        { key: 'fixed_hours', label: 'Fastpris, timmar' },
      ];
      return sendCsv(res, `upplupet-${to === '9999-12-31' ? 'alla' : to}.csv`, columns, [...rows, { label: 'Summa', ...total }]);
    }
    return { from, to, as_of: asOf, group_by: groupBy, group_title: g.title, rows, total };
  });

  // Saldo: rapporterad tid mot normtid per vecka, för inloggad användare.
  router.add('GET', '/api/reports/balance', {}, ({ user, query }) => {
    const { from, to } = period(query);
    const rows = db
      .prepare(
        `SELECT te.work_date AS date, SUM(te.minutes) AS minutes,
                SUM(CASE WHEN te.absence_type_id IS NOT NULL THEN te.minutes ELSE 0 END) AS absence_minutes
         FROM time_entries te WHERE te.user_id = ? AND te.work_date BETWEEN ? AND ?
         GROUP BY te.work_date ORDER BY te.work_date`,
      )
      .all(user.id, from, to);
    return { weekly_hours: user.weekly_hours, days: rows };
  });
}
