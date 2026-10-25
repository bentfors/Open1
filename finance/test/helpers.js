import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createPriceService } from '../src/prices.js';
import { resetLoginLimiter } from '../src/auth.js';

export const PASSWORD = 'losenord-for-test-1';

/** quotes: { SYMBOL: { price, currency } }. Okända symboler ger fel, som hos en riktig kurskälla. */
export function fakeProvider(quotes) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    quotes,
    async fetchQuote(symbol) {
      calls.push(symbol);
      if (!quotes[symbol]) throw new Error('Okänd symbol');
      return quotes[symbol];
    },
  };
}

export async function startApp({ quotes = {} } = {}) {
  resetLoginLimiter();
  const db = openDb(':memory:');
  const provider = fakeProvider(quotes);
  const prices = createPriceService({ db, provider, ttlMinutes: 15 });
  const server = createApp({ db, prices });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    const c = {
      async call(method, url, body) {
        const res = await fetch(base + url, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'manual',
        });
        for (const sc of res.headers.getSetCookie()) {
          const m = /^fin_session=([^;]*)/.exec(sc);
          if (m) cookie = m[1] ? `fin_session=${m[1]}` : '';
        }
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* inte JSON */
        }
        return { status: res.status, json, text };
      },
      get: (url) => c.call('GET', url),
      post: (url, body = {}) => c.call('POST', url, body),
      patch: (url, body = {}) => c.call('PATCH', url, body),
      del: (url) => c.call('DELETE', url),
      async register(email, name = 'Test') {
        const r = await c.post('/api/auth/register', { email, name, password: PASSWORD });
        if (r.status !== 201) throw new Error(`Registrering misslyckades: ${r.status} ${r.text}`);
        return r;
      },
    };
    return c;
  }

  return {
    db,
    base,
    provider,
    client,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      db.close();
    },
  };
}
