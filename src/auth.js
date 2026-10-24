import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// Används när e-postadressen inte finns, så att svarstiden inte avslöjar vilka konton som finns.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('x-time-dummy');
  await verifyPassword(password, dummyHash);
}

export function checkPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < config.minPasswordLength) {
    return `Lösenordet måste vara minst ${config.minPasswordLength} tecken.`;
  }
  if (password.length > 200) return 'Lösenordet är för långt.';
  return null;
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`,
  ).run(hashToken(token), userId, `+${config.sessionDays} days`);
  return token;
}

export function userForSession(db, token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.category_id, u.manager_id, u.weekly_hours,
                u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`,
      )
      .get(hashToken(token)) || null
  );
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions(db) {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

export function sessionCookie(token, { clear = false } = {}) {
  const parts = [
    `xtime_session=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : config.sessionDays * 86400}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

// Enkel begränsning av misslyckade inloggningar. Minnesbaserad, nollställs vid omstart.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 8;
const MAX_PER_IP = 40;
const failures = new Map();

function bucket(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

export function loginAllowed(ip, email) {
  return bucket(`ip:${ip}`).length < MAX_PER_IP && bucket(`acct:${email.toLowerCase()}`).length < MAX_PER_ACCOUNT;
}

export function recordLoginFailure(ip, email) {
  // Slumpade e-postadresser får inte fylla minnet. Vid för många nycklar nollställs spärren.
  if (failures.size > 10000) failures.clear();
  for (const key of [`ip:${ip}`, `acct:${email.toLowerCase()}`]) {
    const list = bucket(key);
    list.push(Date.now());
    failures.set(key, list);
  }
}

export function clearLoginFailures(email) {
  failures.delete(`acct:${email.toLowerCase()}`);
}

export function resetLoginLimiter() {
  failures.clear();
}
