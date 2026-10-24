import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { bootstrap } from '../src/seed.js';
import { resetLoginLimiter } from '../src/auth.js';

export const ADMIN = { email: 'admin@test.local', password: 'admin-password-123' };
export const PASSWORD = 'losenord-for-test-1';

export async function startApp() {
  resetLoginLimiter();
  const db = openDb(':memory:');
  await bootstrap(db, { adminEmail: ADMIN.email, adminPassword: ADMIN.password });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtime-test-'));
  const server = createApp({ db, dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    const c = {
      cookie: () => cookie,
      async call(method, url, body, headers = {}) {
        const res = await fetch(base + url, {
          method,
          headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'manual',
        });
        for (const sc of res.headers.getSetCookie()) {
          const m = /^xtime_session=([^;]*)/.exec(sc);
          if (m) cookie = m[1] ? `xtime_session=${m[1]}` : '';
        }
        // Buffer.toString behåller BOM, till skillnad från res.text().
        const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* inte JSON */
        }
        return { status: res.status, json, text, headers: res.headers };
      },
      get: (url) => c.call('GET', url),
      post: (url, body = {}) => c.call('POST', url, body),
      put: (url, body = {}) => c.call('PUT', url, body),
      patch: (url, body = {}) => c.call('PATCH', url, body),
      del: (url) => c.call('DELETE', url),
      async login(email, password) {
        const r = await c.post('/api/auth/login', { email, password });
        if (r.status !== 200) throw new Error(`Inloggning misslyckades för ${email}: ${r.status} ${r.text}`);
        return r;
      },
    };
    return c;
  }

  return {
    db,
    base,
    client,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Skapar en användare som admin och returnerar { id, client } inloggad.
export async function createUser(app, admin, fields) {
  const r = await admin.post('/api/users', {
    password: PASSWORD,
    role: 'user',
    ...fields,
  });
  if (r.status !== 200) throw new Error(`Kunde inte skapa ${fields.email}: ${r.status} ${r.text}`);
  const c = app.client();
  await c.login(fields.email, PASSWORD);
  // Bortse från tvånget att byta lösenord i testerna genom att nollställa flaggan direkt.
  app.db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(r.json.id);
  return { id: r.json.id, client: c };
}
