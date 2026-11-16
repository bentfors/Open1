import { getSettings, round2 } from './domain.js';

/**
 * Löneunderlag och inköpsunderlag för en period (normalt en kalendermånad).
 *
 * Bara attesterat räknas. Det som ännu inte är attesterat i perioden redovisas för sig, så att ekonomi ser vad
 * som saknas innan lönen körs. Avslaget räknas inte alls.
 *
 * Löneunderlaget gäller personer med månadslön eller timlön. Underkonsulter (ersättningsform underkonsult) får
 * inte lön utan fakturerar, och redovisas i inköpsunderlaget: attesterade timmar × inköpspris, att stämma av
 * mot leverantörsfakturan.
 */

const hours = (minutes) => round2(minutes / 60);

export function payrollBasis(db, { from, to }) {
  const settings = getSettings(db);
  const taxfree = settings.mileage_taxfree_rate;

  const people = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.pay_type, u.active, c.name AS category
       FROM users u LEFT JOIN categories c ON c.id = u.category_id
       WHERE u.pay_type IN ('monthly','hourly')
         AND (u.active = 1
              OR EXISTS (SELECT 1 FROM time_entries t WHERE t.user_id = u.id AND t.work_date BETWEEN :from AND :to)
              OR EXISTS (SELECT 1 FROM expenses e WHERE e.user_id = u.id AND e.expense_date BETWEEN :from AND :to)
              OR EXISTS (SELECT 1 FROM mileage m WHERE m.user_id = u.id AND m.trip_date BETWEEN :from AND :to))
       ORDER BY u.name`,
    )
    .all({ from, to });

  const absenceTypes = db.prepare('SELECT id, name, pay_code FROM absence_types ORDER BY name').all();
  const time = db
    .prepare(
      `SELECT user_id, absence_type_id, status = 'approved' AS approved, COUNT(DISTINCT work_date) AS days, SUM(minutes) AS minutes
       FROM time_entries WHERE work_date BETWEEN ? AND ? AND status <> 'rejected'
       GROUP BY user_id, absence_type_id, status = 'approved'`,
    )
    .all(from, to);
  const expenses = db
    .prepare(
      `SELECT user_id, status = 'approved' AS approved, COUNT(*) AS n, SUM(amount) AS amount, SUM(vat) AS vat
       FROM expenses WHERE expense_date BETWEEN ? AND ? AND status <> 'rejected' GROUP BY user_id, status = 'approved'`,
    )
    .all(from, to);
  const mileage = db
    .prepare(
      `SELECT user_id, status = 'approved' AS approved, COUNT(*) AS n, SUM(km) AS km, SUM(km * rate_per_km) AS amount,
              SUM(km * MIN(rate_per_km, :taxfree)) AS free
       FROM mileage WHERE trip_date BETWEEN :from AND :to AND status <> 'rejected' GROUP BY user_id, status = 'approved'`,
    )
    .all({ from, to, taxfree });

  const all = people.map((p) => {
    const mine = time.filter((t) => t.user_id === p.id);
    const approved = mine.filter((t) => t.approved);
    const pendingMinutes = mine.filter((t) => !t.approved).reduce((s, t) => s + t.minutes, 0);
    const absence = absenceTypes
      .map((a) => {
        const hit = approved.find((t) => t.absence_type_id === a.id);
        return hit ? { type_id: a.id, name: a.name, pay_code: a.pay_code, hours: hours(hit.minutes), days: hit.days } : null;
      })
      .filter(Boolean);
    const exp = expenses.find((e) => e.user_id === p.id && e.approved) ?? { n: 0, amount: 0, vat: 0 };
    const mil = mileage.find((m) => m.user_id === p.id && m.approved) ?? { n: 0, km: 0, amount: 0, free: 0 };
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      pay_type: p.pay_type,
      category: p.category,
      active: !!p.active,
      worked_hours: hours(approved.filter((t) => t.absence_type_id === null).reduce((s, t) => s + t.minutes, 0)),
      absence,
      expenses: { count: exp.n, amount: round2(exp.amount ?? 0), vat: round2(exp.vat ?? 0) },
      mileage: { count: mil.n, km: round2(mil.km ?? 0), amount: round2(mil.amount ?? 0), taxfree: round2(mil.free ?? 0), taxable: round2((mil.amount ?? 0) - (mil.free ?? 0)) },
      pending: {
        time_hours: hours(pendingMinutes),
        expenses: expenses.find((e) => e.user_id === p.id && !e.approved)?.n ?? 0,
        mileage: mileage.find((m) => m.user_id === p.id && !m.approved)?.n ?? 0,
      },
    };
  });

  // Månadslönade utan avvikelser behöver inget i lönen: bara de med något att rapportera, eller något som väntar på attest, visas.
  const rows = all.filter(
    (r) =>
      (r.pay_type === 'hourly' && r.worked_hours) ||
      r.absence.length ||
      r.expenses.amount ||
      r.mileage.amount ||
      r.pending.time_hours ||
      r.pending.expenses ||
      r.pending.mileage,
  );

  const sum = (fn) => round2(rows.reduce((s, r) => s + fn(r), 0));
  const totals = {
    worked_hours: sum((r) => r.worked_hours),
    absence: absenceTypes
      .map((a) => ({ name: a.name, hours: sum((r) => r.absence.find((x) => x.type_id === a.id)?.hours ?? 0) }))
      .filter((a) => a.hours),
    expenses: sum((r) => r.expenses.amount),
    mileage_taxfree: sum((r) => r.mileage.taxfree),
    mileage_taxable: sum((r) => r.mileage.taxable),
    pending_people: rows.filter((r) => r.pending.time_hours || r.pending.expenses || r.pending.mileage).length,
  };

  return { from, to, taxfree_rate: taxfree, codes: payCodes(settings), rows, totals };
}

const payCodes = (s) => ({
  hours: s.pay_code_hours,
  expenses: s.pay_code_expenses,
  mileage_free: s.pay_code_mileage_free,
  mileage_taxable: s.pay_code_mileage_taxable,
});

/**
 * En rad per person och löneart, för import eller inmatning i lönesystemet.
 * Milersättning redovisas i mil (10 km) som i lönesystem, med skattefri och skattepliktig del var för sig.
 * Arbetade timmar tas med för timlönade. Månadslönade får bara avvikelser (frånvaro) och ersättningar.
 */
export function payrollLines(basis) {
  const lines = [];
  const line = (r, code, text, quantity, unit, amount) =>
    lines.push({ name: r.name, email: r.email, pay_type: r.pay_type, code, text, quantity, unit, amount });
  for (const r of basis.rows) {
    if (r.pay_type === 'hourly' && r.worked_hours) line(r, basis.codes.hours, 'Arbetade timmar', r.worked_hours, 'tim', null);
    for (const a of r.absence) line(r, a.pay_code, a.name, a.hours, 'tim', null);
    if (r.expenses.amount) line(r, basis.codes.expenses, `Utlägg (${r.expenses.count} st, varav moms ${r.expenses.vat})`, 1, 'st', r.expenses.amount);
    if (r.mileage.taxfree) line(r, basis.codes.mileage_free, 'Milersättning, skattefri', round2(r.mileage.km / 10), 'mil', r.mileage.taxfree);
    if (r.mileage.taxable) line(r, basis.codes.mileage_taxable, 'Milersättning, skattepliktig del', round2(r.mileage.km / 10), 'mil', r.mileage.taxable);
  }
  return lines;
}

export function subcontractorBasis(db, { from, to }) {
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.name, u.cost_rate AS current_rate, p.id AS project_id, p.code, p.name AS project_name, c.name AS customer_name,
              SUM(CASE WHEN te.status = 'approved' THEN te.minutes ELSE 0 END) AS minutes,
              SUM(CASE WHEN te.status = 'approved' THEN te.minutes * te.cost_rate / 60.0 ELSE 0 END) AS cost,
              SUM(CASE WHEN te.status = 'approved' AND te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END) AS revenue,
              SUM(CASE WHEN te.status <> 'approved' THEN te.minutes ELSE 0 END) AS pending
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       JOIN activities a ON a.id = te.activity_id
       JOIN projects p ON p.id = a.project_id
       JOIN customers c ON c.id = p.customer_id
       WHERE u.pay_type = 'subcontractor' AND te.work_date BETWEEN ? AND ? AND te.status <> 'rejected'
       GROUP BY u.id, p.id
       ORDER BY u.name, p.code`,
    )
    .all(from, to);

  const people = new Map();
  for (const r of rows) {
    const person = people.get(r.user_id) ?? { id: r.user_id, name: r.name, current_rate: r.current_rate, projects: [], hours: 0, cost: 0, revenue: 0, pending_hours: 0 };
    person.projects.push({
      project_id: r.project_id,
      project: `${r.code} ${r.project_name}`,
      customer: r.customer_name,
      hours: hours(r.minutes),
      cost: round2(r.cost),
      revenue: round2(r.revenue),
      pending_hours: hours(r.pending),
    });
    person.hours = round2(person.hours + r.minutes / 60);
    person.cost = round2(person.cost + r.cost);
    person.revenue = round2(person.revenue + r.revenue);
    person.pending_hours = round2(person.pending_hours + r.pending / 60);
    people.set(r.user_id, person);
  }
  const list = [...people.values()].map((p) => ({ ...p, margin: round2(p.revenue - p.cost) }));
  const sum = (k) => round2(list.reduce((s, p) => s + p[k], 0));
  return { from, to, rows: list, totals: { hours: sum('hours'), cost: sum('cost'), revenue: sum('revenue'), margin: sum('margin'), pending_hours: sum('pending_hours') } };
}
