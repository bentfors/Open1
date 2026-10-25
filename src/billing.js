import { round2 } from './domain.js';

/**
 * En gemensam vy över allt som kan faktureras: tid, utlägg och körning.
 * Projektvyn, listan "att fakturera" och upplupet-rapporten bygger alla på den,
 * så att siffrorna alltid stämmer överens.
 */
export const ITEMS_CTE = `
WITH items AS (
  SELECT 'time' AS kind, te.id AS id, te.work_date AS date, te.user_id AS user_id,
         p.id AS project_id, p.customer_id AS customer_id, p.billing_type AS billing_type,
         te.billable AS billable, te.status AS status, te.invoice_id AS invoice_id,
         te.waived_at AS waived_at, te.waived_note AS waived_note,
         a.name AS what, te.note AS note, te.minutes AS minutes, 0.0 AS km,
         te.minutes / 60.0 AS quantity, 'tim' AS unit, te.bill_rate AS rate,
         CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END AS amount
  FROM time_entries te
  JOIN activities a ON a.id = te.activity_id
  JOIN projects p ON p.id = a.project_id
  UNION ALL
  SELECT 'expense', e.id, e.expense_date, e.user_id, p.id, p.customer_id, p.billing_type,
         e.billable, e.status, e.invoice_id, e.waived_at, e.waived_note,
         e.description, '', 0, 0.0, 1.0, 'st', e.amount, e.amount
  FROM expenses e JOIN projects p ON p.id = e.project_id
  UNION ALL
  SELECT 'mileage', m.id, m.trip_date, m.user_id, p.id, p.customer_id, p.billing_type,
         m.billable, m.status, m.invoice_id, m.waived_at, m.waived_note,
         m.purpose, '', 0, m.km, m.km, 'km', m.rate_per_km, m.km * m.rate_per_km
  FROM mileage m JOIN projects p ON p.id = m.project_id
)`;

// Faktura­numret räknas fram ur id och år, samma uttryck överallt.
export const INVOICE_NUMBER_SQL = `substr(inv.created_at, 1, 4) || '-' || printf('%04d', inv.id)`;

export const TABLES = {
  time: { table: 'time_entries', date: 'work_date' },
  expense: { table: 'expenses', date: 'expense_date' },
  mileage: { table: 'mileage', date: 'trip_date' },
};

/**
 * Var en rad befinner sig i faktureringsflödet, och om den går att fakturera nu.
 * Rader som inte kan faktureras får en förklaring, så att inget ligger kvar utan att man vet varför.
 */
export function classify(item) {
  const state = item.invoice_id ? 'invoiced' : item.waived_at ? 'waived' : 'open';
  let reason = '';
  if (state === 'invoiced') reason = 'Fakturerad';
  else if (state === 'waived') reason = 'Avskriven';
  else if (item.status === 'rejected') reason = 'Avslagen';
  else if (item.status === 'open') reason = 'Utkast, ej inskickad';
  else if (item.status === 'submitted') reason = 'Väntar på attest';
  else if (!item.billable) reason = 'Ej debiterbar';
  else if (item.kind === 'time' && item.billing_type !== 'hourly') reason = 'Fast pris, faktureras separat';
  return { state, selectable: state === 'open' && reason === '', reason };
}

export const money = round2;
