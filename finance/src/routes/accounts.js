import { bad, notFound, conflict } from '../http.js';
import { insertRow, updateRow } from '../db.js';
import { ACCOUNT_KINDS, accountBalances, today } from '../domain.js';
import { valueAll } from '../prices.js';
import { str, oneOf, ore, num, id, isoDate } from '../validate.js';

export function registerAccounts({ db, router, prices }) {
  const own = (table, rowId, userId) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(rowId, userId);
    if (!row) throw notFound();
    return row;
  };

  // ── Konton ──────────────────────────────────────────────────────────
  router.add('GET', '/api/accounts', {}, ({ user }) => ({
    kinds: ACCOUNT_KINDS,
    items: accountBalances(db, user.id, '9999-12-31'),
  }));

  // balance är det saldo kontot har idag (signerat: skuld är negativt). Ingångsvärdet räknas fram från det.
  router.add('POST', '/api/accounts', {}, ({ user, body }) => {
    const name = str(body.name, 'Namn', { max: 80 });
    const kind = oneOf(body.kind, 'Kontotyp', Object.keys(ACCOUNT_KINDS));
    const balance = ore(body.balance ?? 0, 'Saldo');
    if (db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND name = ?').get(user.id, name)) throw conflict('Du har redan ett konto med det namnet.');
    const accountId = insertRow(db, 'accounts', { user_id: user.id, name, kind, opening_balance: balance });
    return { id: accountId };
  });

  router.add('PATCH', '/api/accounts/:id', {}, ({ user, params, body }) => {
    const acct = own('accounts', Number(params.id), user.id);
    const data = {};
    if (body.name !== undefined) {
      data.name = str(body.name, 'Namn', { max: 80 });
      const clash = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND name = ? AND id <> ?').get(user.id, data.name, acct.id);
      if (clash) throw conflict('Du har redan ett konto med det namnet.');
    }
    if (body.kind !== undefined) data.kind = oneOf(body.kind, 'Kontotyp', Object.keys(ACCOUNT_KINDS));
    if (body.balance !== undefined) {
      const wanted = ore(body.balance, 'Saldo');
      const sum = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ?').get(acct.id).s;
      data.opening_balance = wanted - sum;
    }
    updateRow(db, 'accounts', acct.id, data);
  });

  router.add('DELETE', '/api/accounts/:id', {}, ({ user, params }) => {
    const acct = own('accounts', Number(params.id), user.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(acct.id);
  });

  // ── Innehav ─────────────────────────────────────────────────────────
  function holdingFields(body, partial = false) {
    const d = {};
    const has = (k) => body[k] !== undefined;
    if (!partial || has('name')) d.name = str(body.name, 'Namn', { max: 120 });
    if (!partial || has('symbol')) d.symbol = str(body.symbol, 'Symbol', { max: 40, required: false }).toUpperCase();
    if (!partial || has('quantity')) d.quantity = num(body.quantity, 'Antal', { min: 0, max: 1e12 });
    if (!partial || has('currency')) {
      d.currency = str(body.currency ?? 'SEK', 'Valuta', { max: 3 }).toUpperCase();
      if (!/^[A-Z]{3}$/.test(d.currency)) throw bad('Valutan ska vara en tre-bokstavskod, till exempel SEK eller USD.');
    }
    if (!partial || has('price_mode')) d.price_mode = oneOf(body.price_mode ?? 'auto', 'Kurskälla', ['auto', 'manual']);
    if (has('manual_price')) {
      d.manual_price = num(body.manual_price, 'Kurs', { min: 0, required: false });
      d.manual_price_date = d.manual_price === null ? null : today();
    }
    if (has('cost_basis')) d.cost_basis = ore(body.cost_basis, 'Anskaffningsvärde', { required: false });
    if (has('account_id')) d.account_id = id(body.account_id, 'Konto', { required: false });
    return d;
  }

  function checkHolding(d, userId) {
    if (d.price_mode === 'auto' && !d.symbol) throw bad('Ange en symbol för automatisk kurs, eller välj manuell kurs.');
    if (d.price_mode === 'manual' && (d.manual_price === undefined || d.manual_price === null)) throw bad('Ange kursen för manuell prissättning.');
    if (d.account_id && !db.prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?').get(d.account_id, userId)) throw bad('Okänt konto.');
  }

  router.add('GET', '/api/holdings', {}, async ({ user, query }) => {
    const rows = db.prepare('SELECT * FROM holdings WHERE user_id = ? ORDER BY name').all(user.id);
    const valued = await valueAll(prices, rows, { force: query.refresh === '1' });
    const total = valued.reduce((n, h) => n + (h.value ?? 0), 0);
    return { provider: prices.provider, total, items: valued };
  });

  router.add('POST', '/api/holdings', {}, ({ user, body }) => {
    const d = holdingFields(body);
    checkHolding(d, user.id);
    return { id: insertRow(db, 'holdings', { user_id: user.id, ...d }) };
  });

  router.add('PATCH', '/api/holdings/:id', {}, ({ user, params, body }) => {
    const row = own('holdings', Number(params.id), user.id);
    const d = holdingFields(body, true);
    checkHolding({ ...row, ...d }, user.id);
    updateRow(db, 'holdings', row.id, d);
  });

  router.add('DELETE', '/api/holdings/:id', {}, ({ user, params }) => {
    const row = own('holdings', Number(params.id), user.id);
    db.prepare('DELETE FROM holdings WHERE id = ?').run(row.id);
  });

  // Hjälp för formuläret: slå upp en symbol innan innehavet sparas.
  router.add('GET', '/api/prices/lookup', {}, async ({ query }) => {
    const symbol = str(query.symbol, 'Symbol', { max: 40 }).toUpperCase();
    const q = (await prices.quotes([symbol], { force: true })).get(symbol);
    if (!q || q.missing) throw bad(`Hittade ingen kurs för ${symbol}. ${q?.error || ''}`.trim());
    return { symbol, price: q.price, currency: q.currency };
  });
}
