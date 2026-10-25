import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config } from './config.js';
import {
  HttpError,
  createRouter,
  readJson,
  sendJson,
  parseCookies,
  queryObject,
  notFound,
  HANDLED,
} from './http.js';
import { userForSession } from './auth.js';
import { registerAuth } from './routes/auth.js';
import { registerUsers } from './routes/users.js';
import { registerCustomers } from './routes/customers.js';
import { registerProjects } from './routes/projects.js';
import { registerTime } from './routes/time.js';
import { registerExpenses } from './routes/expenses.js';
import { registerApprovals } from './routes/approvals.js';
import { registerReports } from './routes/reports.js';
import { registerBilling } from './routes/billing.js';
import { registerCommission } from './routes/commission.js';
import { registerContracts } from './routes/contracts.js';
import { registerStats } from './routes/stats.js';
import { registerSettings } from './routes/settings.js';

const DEFAULT_BODY_LIMIT = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders() {
  const h = {
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  if (config.cookieSecure) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

export function createApp({ db, dataDir = config.dataDir }) {
  const router = createRouter();
  const deps = { db, router, dataDir };
  registerAuth(deps);
  registerUsers(deps);
  registerCustomers(deps);
  registerProjects(deps);
  registerTime(deps);
  registerExpenses(deps);
  registerApprovals(deps);
  registerReports(deps);
  registerBilling(deps);
  registerCommission(deps);
  registerContracts(deps);
  registerStats(deps);
  registerSettings(deps);

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    const mutating = !['GET', 'HEAD'].includes(method);

    // CSRF: SameSite=Lax på kakan, plus att Origin måste matcha om webbläsaren skickar den.
    if (mutating && req.headers.origin) {
      let originHost = '';
      try {
        originHost = new URL(req.headers.origin).host;
      } catch {
        /* ogiltig origin avvisas nedan */
      }
      if (originHost !== req.headers.host) throw new HttpError(403, 'Ogiltigt ursprung på förfrågan.');
    }

    const { route, params, pathMatched } = router.match(method === 'HEAD' ? 'GET' : method, url.pathname);
    if (!route) throw pathMatched ? new HttpError(405, 'Metoden stöds inte.') : notFound('Okänd adress.');

    const auth = route.opts.auth || 'user';
    const token = parseCookies(req.headers.cookie).xtime_session;
    const user = auth === 'public' && !token ? null : userForSession(db, token);

    if (auth !== 'public') {
      if (!user) throw new HttpError(401, 'Du är inte inloggad.', 'UNAUTHENTICATED');
      if (auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Kräver administratör.');
      if (user.must_change_password && !route.opts.allowPasswordChange) {
        throw new HttpError(403, 'Du måste byta lösenord först.', 'PASSWORD_CHANGE_REQUIRED');
      }
    }

    const body = mutating ? await readJson(req, route.opts.bodyLimit || DEFAULT_BODY_LIMIT) : {};
    const ctx = {
      req,
      res,
      db,
      user,
      token,
      params,
      body,
      query: queryObject(url.searchParams),
      ip: clientIp(req),
    };

    const result = await route.handler(ctx);
    if (result === HANDLED) return;
    if (result && result.__respond) return sendJson(res, result.status, result.body, result.headers);
    if (result === undefined) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    sendJson(res, 200, result);
  }

  const etags = new Map();

  function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Metoden stöds inte.');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw notFound();
    }
    if (rel === '/') rel = '/index.html';
    if (rel.includes('\0')) throw notFound();
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir + path.sep)) throw notFound();
    const type = MIME[path.extname(file)];
    if (!type) throw notFound();
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw notFound();
    }
    if (!stat.isFile()) throw notFound();

    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    etags.set(file, etag);
    // Typsnitt ändras aldrig utan nytt filnamn, så de får cachas. Allt annat valideras med ETag.
    const cache = type === 'font/woff2' ? 'public, max-age=604800' : 'no-cache';
    const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, ...securityHeaders() };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message, code: err.code });
        return;
      }
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Något gick fel på servern.' });
      else res.end();
    }
  });

  return server;
}
