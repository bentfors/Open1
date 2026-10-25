// Rådgivarsamtycke. Ett samtycke (grant) gäller ett hushåll och en rådgivare och är aktivt först när
//   1. rådgivaren löst in koden,
//   2. ALLA nuvarande hushållsmedlemmar godkänt det, och
//   3. det varken återkallats eller gått ut.
// En ny medlem har inte godkänt något, så samtyckena vilar tills hen gjort det.
import { createHash, randomBytes } from 'node:crypto';
import { members } from './household.js';

export const hashCode = (code) => createHash('sha256').update(code).digest('hex');
export const newCode = () => randomBytes(18).toString('base64url');
const nowStr = (db) => db.prepare(`SELECT datetime('now') AS n`).get().n;

export function approvalsFor(db, grant) {
  const ms = members(db, grant.household_id);
  const given = new Set(db.prepare('SELECT user_id FROM advisor_approvals WHERE grant_id = ?').all(grant.id).map((r) => r.user_id));
  const pick = ({ id, name }) => ({ id, name });
  return { approved: ms.filter((m) => given.has(m.id)).map(pick), missing: ms.filter((m) => !given.has(m.id)).map(pick) };
}

export function grantState(db, grant) {
  const now = nowStr(db);
  if (grant.revoked_at) return 'revoked';
  if (grant.expires_at <= now) return 'expired';
  if (!grant.accepted_at) return grant.code_expires_at <= now ? 'code_expired' : 'invitation';
  return approvalsFor(db, grant).missing.length ? 'awaiting_approval' : 'active';
}

/** Samtycket om det är aktivt och tillhör rådgivaren, annars null. Används av alla rådgivarens dataanrop. */
export function activeGrant(db, advisorId, grantId) {
  const g = db.prepare('SELECT * FROM advisor_grants WHERE id = ? AND advisor_id = ?').get(grantId, advisorId);
  return g && grantState(db, g) === 'active' ? g : null;
}

export function logAccess(db, grant, action) {
  db.prepare('INSERT INTO advisor_access_log (grant_id, household_id, advisor_id, action) VALUES (?, ?, ?, ?)').run(grant.id, grant.household_id, grant.advisor_id, action);
}
