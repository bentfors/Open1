import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN, createUser, PASSWORD } from './helpers.js';
import { resetLoginLimiter } from '../src/auth.js';

describe('inloggning och åtkomst', () => {
  let app, admin;
  before(async () => {
    app = await startApp();
    admin = app.client();
    await admin.login(ADMIN.email, ADMIN.password);
  });
  after(() => app.close());

  test('oinloggad får 401 på API:t men inloggningssidan är nåbar', async () => {
    const anon = app.client();
    assert.equal((await anon.get('/api/auth/me')).status, 401);
    assert.equal((await anon.get('/api/time/week')).status, 401);
    assert.equal((await anon.get('/')).status, 200);
  });

  test('fel lösenord och okänd användare ger samma svar', async () => {
    const anon = app.client();
    const wrong = await anon.post('/api/auth/login', { email: ADMIN.email, password: 'fel-losenord-123' });
    const unknown = await anon.post('/api/auth/login', { email: 'ingen@t.se', password: 'fel-losenord-123' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.json.error, unknown.json.error);
  });

  test('inloggning spärras efter upprepade misslyckanden', async () => {
    resetLoginLimiter();
    const anon = app.client();
    for (let i = 0; i < 8; i++) {
      assert.equal((await anon.post('/api/auth/login', { email: ADMIN.email, password: 'fel-losenord-123' })).status, 401);
    }
    assert.equal((await anon.post('/api/auth/login', { email: ADMIN.email, password: ADMIN.password })).status, 429);
    resetLoginLimiter();
  });

  test('sessionskakan är HttpOnly och SameSite', async () => {
    const r = await app.client().post('/api/auth/login', ADMIN);
    const cookie = r.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('vanlig användare når inga admin-endpoints', async () => {
    const u = await createUser(app, admin, { email: 'u@t.se', name: 'U' });
    for (const url of [
      '/api/users',
      '/api/customers',
      '/api/projects',
      '/api/commission-rules',
      '/api/invoices',
      '/api/billing/items?project_id=1',
      '/api/reports/accrued',
      '/api/approvals/approved',
    ]) {
      assert.equal((await u.client.get(url)).status, 403, url);
    }
    assert.equal((await u.client.post('/api/customers', { name: 'X' })).status, 403);
    assert.equal((await u.client.patch('/api/settings', { company_name: 'X' })).status, 403);
  });

  test('förfrågan från annan origin avvisas (CSRF)', async () => {
    const r = await admin.call('POST', '/api/customers', { name: 'Evil' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const same = await admin.call('POST', '/api/customers', { name: 'Fine' }, { Origin: app.base });
    assert.equal(same.status, 200);
  });

  test('bara JSON accepteras i POST-kroppar', async () => {
    const res = await fetch(`${app.base}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cookie: admin.cookie() },
      body: 'name=x',
    });
    assert.equal(res.status, 415);
    const ok = await fetch(`${app.base}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie() },
      body: JSON.stringify({ name: 'JSON-kund' }),
    });
    assert.equal(ok.status, 200);
  });

  test('prototypnycklar som indata ger inga serverfel', async () => {
    const q = (await admin.get('/api/reports/time?from=2025-01-01&to=2025-12-31&group_by=constructor')).json;
    assert.equal(q.group_by, 'project');
    assert.equal((await admin.post('/api/approvals/decide', { kind: 'constructor', ids: [1], decision: 'approve' })).status, 400);
    assert.equal((await admin.post('/api/approvals/reopen', { kind: '__proto__', ids: [1] })).status, 400);
  });

  test('nytt konto måste byta lösenord innan något annat fungerar', async () => {
    const r = await admin.post('/api/users', { email: 'ny@t.se', name: 'Ny', role: 'user', password: PASSWORD });
    assert.equal(r.status, 200);
    const c = app.client();
    await c.login('ny@t.se', PASSWORD);
    const blocked = await c.get('/api/time/week');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await c.get('/api/auth/me')).status, 200);

    assert.equal((await c.post('/api/auth/password', { current: PASSWORD, next: 'kort' })).status, 400);
    assert.equal((await c.post('/api/auth/password', { current: PASSWORD, next: 'ett-helt-nytt-losen-9' })).status, 200);
    assert.equal((await c.get('/api/time/week')).status, 200);
  });

  test('lösenordsregler gäller vid skapande av användare', async () => {
    const r = await admin.post('/api/users', { email: 'svag@t.se', name: 'Svag', role: 'user', password: 'kort' });
    assert.equal(r.status, 400);
  });

  test('dubbel e-post ger 409 och inaktiv användare loggas ut direkt', async () => {
    const dup = await admin.post('/api/users', { email: 'U@T.se', name: 'Dubbel', role: 'user', password: PASSWORD });
    assert.equal(dup.status, 409);

    const v = await createUser(app, admin, { email: 'v@t.se', name: 'V' });
    assert.equal((await v.client.get('/api/auth/me')).status, 200);
    await admin.patch(`/api/users/${v.id}`, { active: false });
    assert.equal((await v.client.get('/api/auth/me')).status, 401);
    const again = await app.client().post('/api/auth/login', { email: 'v@t.se', password: PASSWORD });
    assert.equal(again.status, 401);
  });

  test('sista administratören kan inte tas bort eller inaktiveras', async () => {
    const me = (await admin.get('/api/auth/me')).json.user;
    assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'user' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${me.id}`, { active: false })).status, 400);
  });

  test('statiska filer: ingen path traversal och inga källfiler', async () => {
    const anon = app.client();
    assert.equal((await anon.get('/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await anon.get('/%2e%2e/package.json')).status, 404);
    assert.equal((await anon.get('/src/server.js')).status, 404);
    assert.equal((await anon.get('/index.html%00.js')).status, 404);
    const idx = await anon.get('/');
    assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
  });
});
