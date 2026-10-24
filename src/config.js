import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const isProd = env.NODE_ENV === 'production';

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  host: env.HOST || '0.0.0.0',
  port: Number(env.PORT || 3000),
  // Kakan får bara Secure-flaggan över https. Lokalt över http måste den vara av.
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : isProd,
  trustProxy: env.TRUST_PROXY === '1',
  timezone: env.XTIME_TZ || 'Europe/Stockholm',
  sessionDays: 14,
  adminEmail: env.XTIME_ADMIN_EMAIL || '',
  adminPassword: env.XTIME_ADMIN_PASSWORD || '',
  minPasswordLength: 10,
};
