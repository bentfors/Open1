import { getSetting } from './db.js';

export const SETTING_DEFAULTS = {
  company_name: 'x-time',
  locked_until: '',
  mileage_rate: '2.5',
  tb_cost_basis: 'worked',
};

export function getSettings(db) {
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFAULTS)) out[key] = getSetting(db, key, def);
  out.mileage_rate = Number(out.mileage_rate);
  return out;
}

export const isAdmin = (user) => user.role === 'admin';

/**
 * Prioritet för timpris (debitering): projektmedlem > aktivitet > projekt > användarens standardpris.
 * Kostnaden är alltid användarens interna timkostnad.
 * Returnerar null om aktiviteten inte finns.
 */
export function resolveRates(db, userId, activityId) {
  const row = db
    .prepare(
      `SELECT a.billable AS a_billable, a.hourly_rate AS a_rate,
              p.billing_type, p.hourly_rate AS p_rate,
              pm.hourly_rate AS m_rate,
              u.cost_rate, u.default_bill_rate
       FROM activities a
       JOIN projects p ON p.id = a.project_id
       JOIN users u ON u.id = ?
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
       WHERE a.id = ?`,
    )
    .get(userId, activityId);
  if (!row) return null;
  const billable = row.a_billable && row.billing_type !== 'internal' ? 1 : 0;
  const rate = row.m_rate ?? row.a_rate ?? (row.p_rate > 0 ? row.p_rate : null) ?? row.default_bill_rate;
  return { billable, bill_rate: billable ? rate : 0, cost_rate: row.cost_rate };
}

/**
 * SQL-villkor för "den här användaren får attestera raden".
 * Kräver namngivna parametrar :isAdmin och :actor, se approverParams.
 * - Admin får attestera allt.
 * - Projektledaren attesterar tid/utlägg/körning på sina projekt.
 * - Allt utan projekt, eller på projekt utan projektledare, attesteras av den anställdes chef.
 * - Ingen attesterar sin egen rad, förutom admin.
 */
export function approverClause({ entry, project = 'p', owner = 'u' }) {
  return `(:isAdmin = 1 OR (${entry}.user_id <> :actor AND (
      ${project}.manager_id = :actor
      OR ((${project}.id IS NULL OR ${project}.manager_id IS NULL) AND ${owner}.manager_id = :actor)
  )))`;
}

export const approverParams = (actor) => ({ isAdmin: isAdmin(actor) ? 1 : 0, actor: actor.id });

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
