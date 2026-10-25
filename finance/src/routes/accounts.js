import { bad, notFound, conflict, forbidden } from '../http.js';
import { insertRow, updateRow } from '../db.js';
import { ACCOUNT_KINDS, LIABILITY_KINDS, accountBalances, today } from '../domain.js';
import { valueAll } from '../prices.js';
import { scopeOf } from '../scope.js';
import { str, oneOf, ore, num, id } from '../validate.js';

export function registerAccounts({ db, router, prices }) {
  // Rad som användaren får se och ändra: hushållets delade rader och egna privata.
  const visible = (table, rowId, user) => {
    const row = db.prepare(`SELECT * FROM ${table} t WHERE t.id = ? AND ${scopeOf(user).acct('t')}`).get(rowId);
    if (!row) throw notFound();
    return row;
  };
  const sharedFlag = (v, fallback = 1) => (v === undefined ? fallback : v ? 1 : 0);

  // ── Konton ──────────────────────────────────────────────────────────
  router.add('GET', '/api/accounts', {}, ({ user, query }) => ({
    kinds: ACCOUNT_KINDS,
    items: accountBalances(db, scopeOf(user, query.scope), '9999-12-31'),
  }));

  // Ränta och amortering behövs för prognoser och gäller bara skulder.
  function loanTerms(body, kind) {
    if (!LIABILITY_KINDS.has(kind)) return { interest_rate: null, monthly_amortization: 0 };
    return {
      interest_rate: num(body.interest_rate, 'Ränta', { min: 0, max: 50, required: false }),
      monthly_amortization: ore(body.monthly_amortization ?? 0, 'Amortering per månad'),
    };
  }

  // balance är det saldo kontot har idag (signerat: skuld är negativt). Ingångsvärdet räknas fram från det.
  router.add('POST', '/api/accounts', {}, ({ user, body }) => {
    const name = str(body.name, 'Namn', { max: 80 });
    const kind = oneOf(body.kind, 'Kontotyp', Object.keys(ACCOUNT_KINDS));
    const balance = ore(body.balance ?? 0, 'Saldo');
    if (db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND name = ?').get(user.id, name)) throw conflict('Du har redan ett konto med det namnet.');
    return {
      id: insertRow(db, 'accounts', {
        user_id: user.id,
        household_id: user.household_id,
        name,
        kind,
        opening_balance: balance,
        shared: sharedFlag(body.shared),
        ...loanTerms(body, kind),
      }),
    };
  });

  // Hushållets medlemmar får ändra delade konton. Typ, delning och ränta ändras bara av ägaren.
  router.add('PATCH', '/api/accounts/:id', {}, ({ user, params, body }) => {
    const acct = visible('accounts', Number(params.id), user);
    const owner = acct.user_id === user.id;
    const data = {};
    if (body.name !== undefined) {
      data.name = str(body.name, 'Namn', { max: 80 });
      const clash = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND name = ? AND id <> ?').get(acct.user_id, data.name, acct.id);
      if (clash) throw conflict('Ägaren har redan ett konto med det namnet.');
    }
    if (body.balance !== undefined) {
      const wanted = ore(body.balance, 'Saldo');
      const sum = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ?').get(acct.id).s;
      data.opening_balance = wanted - sum;
    }
    if (body.kind !== undefined || body.shared !== undefined || body.interest_rate !== undefined || body.monthly_amortization !== undefined) {
      if (!owner) throw forbidden('Bara kontots ägare kan ändra typ, delning och lånevillkor.');
      const kind = body.kind === undefined ? acct.kind : oneOf(body.kind, 'Kontotyp', Object.keys(ACCOUNT_KINDS));
      data.kind = kind;
      if (body.shared !== undefined) data.shared = sharedFlag(body.shared);
      Object.assign(data, loanTerms({ interest_rate: acct.interest_rate, monthly_amortization: acct.monthly_amortization, ...body }, kind));
    }
    updateRow(db, 'accounts', acct.id, data);
  });

  router.add('DELETE', '/api/accounts/:id', {}, ({ user, params }) => {
    const acct = visible('accounts', Number(params.id), user);
    if (acct.user_id !== user.id) throw forbidden('Bara kontots ägare kan ta bort det.');
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
    if (has('shared')) d.shared = sharedFlag(body.shared);
    return d;
  }

  function checkHolding(d, user) {
    if (d.price_mode === 'auto' && !d.symbol) throw bad('Ange en symbol för automatisk kurs, eller välj manuell kurs.');
    if (d.price_mode === 'manual' && (d.manual_price === undefined || d.manual_price === null)) throw bad('Ange kursen för manuell prissättning.');
    if (d.account_id && !db.prepare(`SELECT 1 FROM accounts a WHERE a.id = ? AND ${scopeOf(user).acct('a')}`).get(d.account_id)) throw bad('Okänt konto.');
  }

  router.add('GET', '/api/holdings', {}, async ({ user, query }) => {
    const rows = db
      .prepare(`SELECT a.*, (SELECT u.name FROM users u WHERE u.id = a.user_id) AS owner FROM holdings a WHERE ${scopeOf(user, query.scope).holdings('a')} ORDER BY a.name`)
      .all();
    const valued = await valueAll(prices, rows, { force: query.refresh === '1' });
    const total = valued.reduce((n, h) => n + (h.value ?? 0), 0);
    return { provider: prices.provider, total, items: valued };
  });

  router.add('POST', '/api/holdings', {}, ({ user, body }) => {
    const d = holdingFields(body);
    checkHolding(d, user);
    return { id: insertRow(db, 'holdings', { user_id: user.id, household_id: user.household_id, ...d }) };
  });

  router.add('PATCH', '/api/holdings/:id', {}, ({ user, params, body }) => {
    const row = visible('holdings', Number(params.id), user);
    const d = holdingFields(body, true);
    if (d.shared !== undefined && row.user_id !== user.id) throw forbidden('Bara ägaren kan ändra delning.');
    checkHolding({ ...row, ...d }, user);
    updateRow(db, 'holdings', row.id, d);
  });

  router.add('DELETE', '/api/holdings/:id', {}, ({ user, params }) => {
    const row = visible('holdings', Number(params.id), user);
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
