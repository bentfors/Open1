import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const isProd = env.NODE_ENV === 'production';

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 3100),
  // Kakan får bara Secure-flaggan över https. Lokalt över http måste den vara av.
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : isProd,
  trustProxy: env.TRUST_PROXY === '1',
  sessionDays: 14,
  minPasswordLength: 10,
  // Registrering är på som standard. Slå av med ALLOW_SIGNUP=0 när alla som ska ha konto har det.
  allowSignup: env.ALLOW_SIGNUP !== '0',
  // 'yahoo' hämtar kurser från Yahoo Finances ofullständigt dokumenterade API. 'none' = bara manuella kurser.
  priceProvider: env.PRICE_PROVIDER || 'yahoo',
  priceTtlMinutes: Number(env.PRICE_TTL_MINUTES || 15),
};
