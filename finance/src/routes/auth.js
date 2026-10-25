import { HttpError, bad, respond } from '../http.js';
import {
  hashPassword, verifyPassword, burnPasswordCheck, checkPasswordPolicy, createSession, destroySession,
  destroyUserSessions, sessionCookie, loginAllowed, recordLoginFailure, clearLoginFailures,
} from '../auth.js';
import { config } from '../config.js';
import { insertRow, tx } from '../db.js';
import { newUserHousehold, deleteUser, members } from '../household.js';
import { str } from '../validate.js';

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });

export function registerAuth({ db, router }) {
  router.add('POST', '/api/auth/register', { auth: 'public' }, async ({ body, ip }) => {
    if (!config.allowSignup) throw new HttpError(403, 'Registrering är avstängd.');
    const email = str(body.email, 'E-post', { max: 200 }).toLowerCase();
    const name = str(body.name, 'Namn', { max: 100 });
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Ange en giltig e-postadress.');
    const problem = checkPasswordPolicy(password);
    if (problem) throw bad(problem);
    // Samma begränsning som inloggning, så att registrering inte kan användas för att massproducera konton.
    if (!loginAllowed(ip, email)) throw new HttpError(429, 'För många försök. Vänta en stund.');
    recordLoginFailure(ip, email);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Det finns redan ett konto med den e-postadressen.');
    const hash = await hashPassword(password);
    const user = tx(db, () => {
      const userId = insertRow(db, 'users', { email, name, password_hash: hash });
      newUserHousehold(db, userId, name);
      return { id: userId, email, name };
    });
    const token = createSession(db, user.id);
    return respond({ user: publicUser(user) }, { status: 201, headers: { 'Set-Cookie': sessionCookie(token) } });
  });

  router.add('POST', '/api/auth/login', { auth: 'public' }, async ({ body, ip }) => {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) throw bad('Ange e-post och lösenord.');
    if (!loginAllowed(ip, email)) throw new HttpError(429, 'För många misslyckade försök. Vänta en stund och försök igen.');
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user) {
      await burnPasswordCheck(password);
      recordLoginFailure(ip, email);
      throw new HttpError(401, 'Fel e-post eller lösenord.');
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      recordLoginFailure(ip, email);
      throw new HttpError(401, 'Fel e-post eller lösenord.');
    }
    clearLoginFailures(email);
    const token = createSession(db, user.id);
    return respond({ user: publicUser(user) }, { headers: { 'Set-Cookie': sessionCookie(token) } });
  });

  router.add('POST', '/api/auth/logout', { auth: 'public' }, ({ token }) => {
    destroySession(db, token);
    return respond({ ok: true }, { headers: { 'Set-Cookie': sessionCookie('', { clear: true }) } });
  });

  router.add('GET', '/api/auth/me', {}, ({ user }) => ({ user: publicUser(user), signup: config.allowSignup, household_size: members(db, user.household_id).length,
    advisor_enabled: config.advisorEnabled,
    advisor_clients: db.prepare('SELECT COUNT(*) AS n FROM advisor_grants WHERE advisor_id = ? AND revoked_at IS NULL').get(user.id).n }));

  router.add('GET', '/api/auth/config', { auth: 'public' }, () => ({ signup: config.allowSignup }));

  router.add('POST', '/api/auth/password', {}, async ({ user, body, token }) => {
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(current, row.password_hash))) throw bad('Nuvarande lösenord stämmer inte.');
    const problem = checkPasswordPolicy(next);
    if (problem) throw bad(problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
    destroyUserSessions(db, user.id);
    const fresh = createSession(db, user.id);
    return respond({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(fresh) } });
  });

  // Raderar kontot och all data. Kräver lösenordet.
  router.add('POST', '/api/auth/delete-account', {}, async ({ user, body }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(typeof body.password === 'string' ? body.password : '', row.password_hash))) throw bad('Lösenordet stämmer inte.');
    deleteUser(db, user);
    return respond({ ok: true }, { headers: { 'Set-Cookie': sessionCookie('', { clear: true }) } });
  });

  // Allt användaren själv äger som JSON (rätten till dataportabilitet, och en säkerhetskopia). Delade kategorier
  // och regler ingår eftersom transaktionerna pekar på dem. Andra medlemmars konton ingår inte.
  router.add('GET', '/api/export', {}, ({ user }) => {
    const mine = (sql, ...a) => db.prepare(sql).all(...a);
    return {
      exported_at: new Date().toISOString(),
      accounts: mine('SELECT * FROM accounts WHERE user_id = ?', user.id),
      transactions: mine('SELECT * FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)', user.id),
      holdings: mine('SELECT * FROM holdings WHERE user_id = ?', user.id),
      categories: mine('SELECT * FROM categories WHERE household_id = ?', user.household_id),
      rules: mine('SELECT * FROM rules WHERE household_id = ?', user.household_id),
      budgets: mine('SELECT * FROM budgets WHERE household_id = ?', user.household_id),
      goals: mine('SELECT * FROM goals WHERE household_id = ?', user.household_id),
      scenarios: mine('SELECT * FROM scenarios WHERE household_id = ?', user.household_id),
      advisor_consents: mine('SELECT id, level, accepted_at, expires_at, revoked_at, created_at FROM advisor_grants WHERE household_id = ?', user.household_id),
      advisor_access_log: mine('SELECT grant_id, action, at FROM advisor_access_log WHERE household_id = ? ORDER BY id', user.household_id),
    };
  });
}
