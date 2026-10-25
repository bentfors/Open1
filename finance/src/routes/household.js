import { createHash, randomBytes } from 'node:crypto';
import { bad } from '../http.js';
import { insertRow, updateRow } from '../db.js';
import { joinHousehold, leaveHousehold, members } from '../household.js';
import { str, num } from '../validate.js';

const hash = (token) => createHash('sha256').update(token).digest('hex');
const INVITE_DAYS = 7;

export function registerHousehold({ db, router }) {
  const info = (user) => {
    const h = db.prepare('SELECT id, name, return_rate, cash_rate, fixed_growth, inflation FROM households WHERE id = ?').get(user.household_id);
    return { id: h.id, name: h.name, members: members(db, h.id), assumptions: { return_rate: h.return_rate, cash_rate: h.cash_rate, fixed_growth: h.fixed_growth, inflation: h.inflation } };
  };

  router.add('GET', '/api/household', {}, ({ user }) => info(user));

  // Antagandena styr alla prognoser. Åriga procent, nominella.
  router.add('PATCH', '/api/household', {}, ({ user, body }) => {
    const d = {};
    if (body.name !== undefined) d.name = str(body.name, 'Namn', { max: 80 });
    for (const [key, label] of [['return_rate', 'Avkastning'], ['cash_rate', 'Ränta på kontanter'], ['fixed_growth', 'Värdeutveckling övriga tillgångar'], ['inflation', 'Inflation']]) {
      if (body[key] !== undefined) d[key] = num(body[key], label, { min: -20, max: 30 });
    }
    updateRow(db, 'households', user.household_id, d);
    return info(user);
  });

  // Koden visas en gång och gäller en person, en gång, i sju dagar.
  router.add('POST', '/api/household/invite', {}, ({ user }) => {
    const token = randomBytes(18).toString('base64url');
    db.prepare(`INSERT INTO household_invites (token_hash, household_id, created_by, expires_at) VALUES (?, ?, ?, datetime('now', ?))`).run(hash(token), user.household_id, user.id, `+${INVITE_DAYS} days`);
    return { code: token, days: INVITE_DAYS };
  });

  router.add('POST', '/api/household/join', {}, ({ user, body }) => {
    const code = str(body.code, 'Inbjudningskod', { max: 100 });
    const invite = db.prepare(`SELECT household_id FROM household_invites WHERE token_hash = ? AND expires_at > datetime('now')`).get(hash(code));
    if (!invite) throw bad('Koden är ogiltig eller har gått ut.');
    joinHousehold(db, user, invite.household_id);
    db.prepare('DELETE FROM household_invites WHERE token_hash = ?').run(hash(code));
    return info({ ...user, household_id: invite.household_id });
  });

  router.add('POST', '/api/household/leave', {}, ({ user }) => {
    const newId = leaveHousehold(db, user);
    return info({ ...user, household_id: newId });
  });
}
