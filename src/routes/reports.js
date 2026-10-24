import { HANDLED, bad, sendText } from '../http.js';
import { optDate, optId } from '../validate.js';
import { getSettings, isAdmin, round2 } from '../domain.js';
import { toCsv } from '../csv.js';

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
   * TB per konsult och provision per mottagare.
   * TB = intäkt (debiterbara timmar × pris) − kostnad (timmar × intern timkostnad).
   * Frånvaro räknas inte. Inställningen tb_cost_basis avgör om ej debiterbar projekttid belastar TB.
   * Provision = TB × procent, per post så att kopplingens giltighetsperiod respekteras.
   */
  router.add('GET', '/api/reports/margin', {}, ({ user, query, res }) => {
    const { from, to } = period(query);
    const admin = isAdmin(user);
    const settings = getSettings(db);
    const params = {
      from,
      to,
      all: query.status === 'all' ? 1 : 0,
      worked: settings.tb_cost_basis === 'billable' ? 0 : 1,
    };

    const marginExpr = `(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END)
        - (CASE WHEN :worked = 1 OR te.billable = 1 THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END)`;
    const base = `te.activity_id IS NOT NULL AND te.work_date BETWEEN :from AND :to
                  AND (:all = 1 OR te.status = 'approved')`;

    const consultants = admin
      ? db
          .prepare(
            `SELECT u.id AS user_id, u.name, c.name AS category,
                    SUM(te.minutes) AS minutes,
                    SUM(CASE WHEN te.billable = 1 THEN te.minutes ELSE 0 END) AS billable_minutes,
                    SUM(CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
                    SUM(CASE WHEN :worked = 1 OR te.billable = 1 THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost
             FROM time_entries te JOIN users u ON u.id = te.user_id LEFT JOIN categories c ON c.id = u.category_id
             WHERE ${base}
             GROUP BY u.id ORDER BY u.name`,
          )
          .all(params)
          .map((r) => ({
            user_id: r.user_id,
            name: r.name,
            category: r.category,
            hours: hours(r.minutes),
            billable_hours: hours(r.billable_minutes),
            revenue: round2(r.revenue),
            cost: round2(r.cost),
            margin: round2(r.revenue - r.cost),
          }))
      : [];

    // Admin ser alla mottagare. Övriga ser bara sina egna provisioner.
    const commissions = db
      .prepare(
        `SELECT cl.earner_id, e.name AS earner_name, ec.name AS earner_category,
                cl.source_id, s.name AS source_name, sc.name AS source_category,
                cl.percent, cl.valid_from, cl.valid_to,
                SUM(te.minutes) AS minutes,
                SUM(${marginExpr}) AS margin
         FROM commission_links cl
         JOIN users e ON e.id = cl.earner_id LEFT JOIN categories ec ON ec.id = e.category_id
         JOIN users s ON s.id = cl.source_id LEFT JOIN categories sc ON sc.id = s.category_id
         JOIN time_entries te ON te.user_id = cl.source_id
          AND (cl.valid_from IS NULL OR te.work_date >= cl.valid_from)
          AND (cl.valid_to IS NULL OR te.work_date <= cl.valid_to)
         WHERE ${base} AND (:isAdmin = 1 OR cl.earner_id = :actor)
         GROUP BY cl.id
         ORDER BY e.name, s.name, cl.valid_from`,
      )
      .all({ ...params, isAdmin: admin ? 1 : 0, actor: user.id })
      .map((r) => ({
        earner_id: r.earner_id,
        earner_name: r.earner_name,
        earner_category: r.earner_category,
        source_id: r.source_id,
        source_name: r.source_name,
        source_category: r.source_category,
        percent: r.percent,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        hours: hours(r.minutes),
        margin: round2(r.margin),
        commission: round2((r.margin * r.percent) / 100),
      }));

    const earners = new Map();
    for (const c of commissions) {
      const e = earners.get(c.earner_id) ?? { earner_id: c.earner_id, name: c.earner_name, category: c.earner_category, commission: 0 };
      e.commission = round2(e.commission + c.commission);
      earners.set(c.earner_id, e);
    }

    if (query.format === 'csv') {
      const columns = [
        { key: 'earner_name', label: 'Mottagare' },
        { key: 'earner_category', label: 'Mottagarens kategori' },
        { key: 'source_name', label: 'Konsult' },
        { key: 'source_category', label: 'Konsultens kategori' },
        { key: 'hours', label: 'Timmar' },
        { key: 'margin', label: 'TB' },
        { key: 'percent', label: 'Procent' },
        { key: 'commission', label: 'Provision' },
      ];
      return sendCsv(res, `provision-${from}-${to}.csv`, columns, commissions);
    }
    return {
      cost_basis: settings.tb_cost_basis,
      consultants,
      commissions,
      earners: [...earners.values()],
    };
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
