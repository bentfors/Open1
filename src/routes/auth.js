import { HttpError, bad, respond } from '../http.js';
import {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  checkPasswordPolicy,
  createSession,
  destroySession,
  destroyUserSessions,
  sessionCookie,
  loginAllowed,
  recordLoginFailure,
  clearLoginFailures,
} from '../auth.js';
import { getSettings, financeLevel } from '../domain.js';

const publicUser = (db, u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  finance_level: financeLevel(u),
  category_id: u.category_id,
  manager_id: u.manager_id,
  weekly_hours: u.weekly_hours,
  must_change_password: !!u.must_change_password,
  // Styr om fliken Provision visas för vanliga användare.
  is_earner: !!db.prepare('SELECT 1 FROM commission_rules WHERE earner_id = ? LIMIT 1').get(u.id),
  // Styr om menyvalet Statistik visas: provisionsregler eller konsulter att vara BM för.
  has_stats:
    !!db.prepare('SELECT 1 FROM commission_rules WHERE earner_id = ? LIMIT 1').get(u.id) ||
    !!db.prepare('SELECT 1 FROM users WHERE bm_id = ? AND active = 1 LIMIT 1').get(u.id),
});

export function registerAuth({ db, router }) {
  router.add('POST', '/api/auth/login', { auth: 'public' }, async ({ body, ip }) => {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) throw bad('Ange e-post och lösenord.');
    if (!loginAllowed(ip, email)) {
      throw new HttpError(429, 'För många misslyckade försök. Vänta en stund och försök igen.');
    }

    const row = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    const ok = row ? await verifyPassword(password, row.password_hash) : (await burnPasswordCheck(password), false);
    if (!ok) {
      recordLoginFailure(ip, email);
      throw new HttpError(401, 'Fel e-post eller lösenord.');
    }
    clearLoginFailures(email);
    const token = createSession(db, row.id);
    return respond(
      { user: publicUser(db, row), settings: getSettings(db) },
      { headers: { 'Set-Cookie': sessionCookie(token) } },
    );
  });

  router.add('POST', '/api/auth/logout', { auth: 'public' }, ({ token }) => {
    destroySession(db, token);
    return respond({ ok: true }, { headers: { 'Set-Cookie': sessionCookie('', { clear: true }) } });
  });

  router.add('GET', '/api/auth/me', { auth: 'user', allowPasswordChange: true }, ({ user }) => ({
    user: publicUser(db, user),
    settings: getSettings(db),
  }));

  router.add('POST', '/api/auth/password', { auth: 'user', allowPasswordChange: true }, async ({ user, body, token }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) {
      throw bad('Nuvarande lösenord stämmer inte.');
    }
    const problem = checkPasswordPolicy(body.next);
    if (problem) throw bad(problem);
    if (body.next === body.current) throw bad('Det nya lösenordet måste skilja sig från det gamla.');

    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      await hashPassword(body.next),
      user.id,
    );
    // Logga ut alla andra enheter och behåll bara den här sessionen.
    destroyUserSessions(db, user.id);
    const fresh = createSession(db, user.id);
    return respond({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(fresh) } });
  });
}
