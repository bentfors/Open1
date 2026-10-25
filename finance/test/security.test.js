import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD } from './helpers.js';

describe('webbskydd', () => {
  let app;
  before(async () => (app = await startApp()));
  after(() => app.close());

  test('skrivande anrop med annat ursprung avvisas (CSRF)', async () => {
    const res = await fetch(`${app.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'a@b.se', password: PASSWORD }),
    });
    assert.equal(res.status, 403);
  });

  test('kakan är HttpOnly och SameSite', async () => {
    const res = await fetch(`${app.base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'c@d.se', name: 'C', password: PASSWORD }),
    });
    const cookie = res.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('säkerhetsheaders på sidor och API', async () => {
    for (const path of ['/', '/api/auth/config']) {
      const res = await fetch(app.base + path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  test('statiska filer kan inte nå utanför public', async () => {
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fsrc/config.js', '/js/../../src/db.js']) {
      const res = await fetch(app.base + path);
      assert.ok([404, 400].includes(res.status), `${path} gav ${res.status}`);
    }
  });

  test('för stor förfrågan avvisas', async () => {
    const c = app.client();
    await c.register('e@f.se');
    const r = await c.post('/api/accounts', { name: 'x'.repeat(70000), kind: 'checking' });
    assert.equal(r.status, 413);
  });

  test('inloggning spärras efter upprepade misslyckanden', async () => {
    const c = app.client();
    await c.register('g@h.se');
    let last;
    for (let i = 0; i < 10; i++) last = await app.client().post('/api/auth/login', { email: 'g@h.se', password: 'fel-lösenord' });
    assert.equal(last.status, 429);
  });
});
