import { HANDLED, bad, sendText } from '../http.js';
import { toCsv } from '../csv.js';
import { monthEnd, previousMonthEnd, today } from '../dates.js';
import { payrollBasis, payrollLines, subcontractorBasis } from '../payroll.js';

const PAY_TYPE = { monthly: 'Månadslön', hourly: 'Timlön', subcontractor: 'Underkonsult' };

// Lön och inköp gäller hela kalendermånader. Förvalt är förra månaden.
function monthPeriod(query) {
  const month = query.month || previousMonthEnd(today()).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Ange månad som ÅÅÅÅ-MM.');
  return { month, from: `${month}-01`, to: monthEnd(`${month}-01`) };
}

function sendCsv(res, filename, columns, rows) {
  sendText(res, 200, toCsv(columns, rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"` });
  return HANDLED;
}

export function registerPayroll({ db, router }) {
  // Löneunderlaget innehåller frånvaro som sjukdom, så det är ekonomi-superuserns och administratörens.
  router.add('GET', '/api/payroll', { auth: 'finance_super' }, ({ query, res }) => {
    const { month, from, to } = monthPeriod(query);
    const basis = payrollBasis(db, { from, to });

    if (query.format === 'lines') {
      const columns = [
        { key: 'name', label: 'Namn' },
        { key: 'email', label: 'E-post' },
        { key: 'pay_type', label: 'Ersättningsform' },
        { key: 'code', label: 'Löneart' },
        { key: 'text', label: 'Benämning' },
        { key: 'quantity', label: 'Antal' },
        { key: 'unit', label: 'Enhet' },
        { key: 'amount', label: 'Belopp' },
      ];
      const lines = payrollLines(basis).map((l) => ({ ...l, pay_type: PAY_TYPE[l.pay_type] }));
      return sendCsv(res, `loneunderlag-rader-${month}.csv`, columns, lines);
    }

    if (query.format === 'csv') {
      const types = [...new Map(basis.rows.flatMap((r) => r.absence).map((a) => [a.type_id, a.name])).entries()];
      const columns = [
        { key: 'name', label: 'Namn' },
        { key: 'email', label: 'E-post' },
        { key: 'pay_type', label: 'Ersättningsform' },
        { key: 'worked', label: 'Arbetade timmar' },
        ...types.flatMap(([id, name]) => [
          { key: `abs_h_${id}`, label: `${name} (tim)` },
          { key: `abs_d_${id}`, label: `${name} (dagar)` },
        ]),
        { key: 'expenses', label: 'Utlägg' },
        { key: 'vat', label: 'Varav moms' },
        { key: 'km', label: 'Körda km' },
        { key: 'free', label: 'Milersättning skattefri' },
        { key: 'taxable', label: 'Milersättning skattepliktig' },
        { key: 'pending', label: 'Ej attesterat (tim)' },
      ];
      const rows = basis.rows.map((r) => ({
        name: r.name,
        email: r.email,
        pay_type: PAY_TYPE[r.pay_type],
        worked: r.worked_hours,
        ...Object.fromEntries(r.absence.flatMap((a) => [[`abs_h_${a.type_id}`, a.hours], [`abs_d_${a.type_id}`, a.days]])),
        expenses: r.expenses.amount,
        vat: r.expenses.vat,
        km: r.mileage.km,
        free: r.mileage.taxfree,
        taxable: r.mileage.taxable,
        pending: r.pending.time_hours,
      }));
      return sendCsv(res, `loneunderlag-${month}.csv`, columns, rows);
    }
    return { month, ...basis };
  });

  // Inköpsunderlag för underkonsulter: att stämma av mot deras fakturor.
  router.add('GET', '/api/subcontractors', { auth: 'finance' }, ({ query, res }) => {
    const { month, from, to } = monthPeriod(query);
    const basis = subcontractorBasis(db, { from, to });
    if (query.format === 'csv') {
      const columns = [
        { key: 'name', label: 'Underkonsult' },
        { key: 'project', label: 'Projekt' },
        { key: 'customer', label: 'Kund' },
        { key: 'hours', label: 'Attesterade timmar' },
        { key: 'cost', label: 'Inköp' },
        { key: 'revenue', label: 'Debiterat' },
        { key: 'pending_hours', label: 'Ej attesterat (tim)' },
      ];
      const rows = basis.rows.flatMap((p) => p.projects.map((x) => ({ name: p.name, ...x })));
      return sendCsv(res, `underkonsulter-${month}.csv`, columns, [...rows, { name: 'Summa', hours: basis.totals.hours, cost: basis.totals.cost, revenue: basis.totals.revenue, pending_hours: basis.totals.pending_hours }]);
    }
    return { month, ...basis };
  });
}
