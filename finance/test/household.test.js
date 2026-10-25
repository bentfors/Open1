import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers.js';
import { MIGRATIONS, migrate } from '../src/db.js';

const STMT = (rows) => ['Datum;Text;Belopp', ...rows].join('\n');

describe('hushåll', () => {
  let app, anna, bo, annaAcct, annaPrivate, boAcct;
  const cats = async (c) => Object.fromEntries((await c.get('/api/categories')).json.items.map((k) => [k.name, k.id]));

  before(async () => {
    app = await startApp();
    anna = app.client();
    await anna.register('anna@h.se', 'Anna');
    bo = app.client();
    await bo.register('bo@h.se', 'Bo');
    annaAcct = (await anna.post('/api/accounts', { name: 'Gemensamt', kind: 'checking', balance: 1000000 })).json.id;
    annaPrivate = (await anna.post('/api/accounts', { name: 'Annas spar', kind: 'savings', balance: 5000000, shared: false })).json.id;
    boAcct = (await bo.post('/api/accounts', { name: 'Bos konto', kind: 'checking', balance: 200000 })).json.id;
    // Bo har en egen kategori och en transaktion i den, och en egen "Lön"-kategorisering.
    await bo.post('/api/categories', { name: 'Hund', kind: 'expense' });
    await bo.post('/api/import/commit', { account_id: boAcct, text: STMT(['2025-03-01;LÖN FIRMAN;20000,00', '2025-03-02;Hundmat;-300,00']) });
    const boCats = await cats(bo);
    const dog = (await bo.get('/api/transactions?q=Hundmat')).json.items[0];
    await bo.patch(`/api/transactions/${dog.id}`, { category_id: boCats.Hund });
  });
  after(() => app.close());

  test('en ny användare är ensam i sitt hushåll och ser bara sitt', async () => {
    assert.equal((await anna.get('/api/household')).json.members.length, 1);
    assert.equal((await bo.get('/api/accounts')).json.items.length, 1);
  });

  test('inbjudan: ogiltig kod avvisas, giltig kod slår ihop hushållen', async () => {
    assert.equal((await bo.post('/api/household/join', { code: 'finns-inte' })).status, 400);
    const { code } = (await anna.post('/api/household/invite')).json;
    const r = await bo.post('/api/household/join', { code });
    assert.equal(r.status, 200);
    assert.equal(r.json.members.length, 2);
    assert.equal((await bo.post('/api/household/join', { code })).status, 400, 'koden är engångs');
  });

  test('kategorier slogs ihop: Bos egna följde med och dubbletter blev en', async () => {
    const a = await cats(anna);
    const b = await cats(bo);
    assert.deepEqual(a, b);
    assert.ok(a.Hund, 'Bos kategori finns hos Anna');
    const dog = (await anna.get('/api/transactions?q=Hundmat')).json;
    assert.equal(dog.items.length, 1, 'Bos konto är delat, så Anna ser transaktionen');
    assert.equal(dog.items[0].category, 'Hund');
  });

  test('delade konton syns för båda, privata bara för ägaren', async () => {
    // Bos konto är delat (standard), Annas sparkonto privat.
    const forBo = (await bo.get('/api/accounts')).json.items.map((x) => x.name).sort();
    const forAnna = (await anna.get('/api/accounts')).json.items.map((x) => x.name).sort();
    assert.deepEqual(forBo, ['Bos konto', 'Gemensamt']);
    assert.deepEqual(forAnna, ['Annas spar', 'Bos konto', 'Gemensamt']);
    assert.equal((await bo.patch(`/api/accounts/${annaPrivate}`, { name: 'x' })).status, 404);
    assert.equal((await bo.post('/api/import/preview', { account_id: annaPrivate, text: STMT(['2025-03-01;X;-1,00']) })).status, 404);
  });

  test('rapporter: hushållsvyn summerar delat, "me" bara egna', async () => {
    const house = (await anna.get('/api/reports/balance')).json;
    const me = (await anna.get('/api/reports/balance?scope=me')).json;
    const boView = (await bo.get('/api/reports/balance')).json;
    assert.equal(house.total_assets, 1000000 + 5000000 + 20000 * 100 - 30000 + 200000); // Gemensamt + Annas spar + Bos konto med transaktioner
    assert.equal(me.total_assets, 1000000 + 5000000);
    assert.equal(boView.total_assets, house.total_assets - 5000000, 'Bo ser inte Annas privata konto');
    const inc = (await anna.get('/api/reports/income?from=2025-03-01&to=2025-03-31')).json;
    assert.equal(inc.income, 2000000);
    const incMe = (await anna.get('/api/reports/income?from=2025-03-01&to=2025-03-31&scope=me')).json;
    assert.equal(incMe.income, 0);
  });

  test('medlem kan importera till delat konto men bara ägaren ändrar typ och tar bort', async () => {
    const r = await bo.post('/api/import/commit', { account_id: annaAcct, text: STMT(['2025-03-05;Hemköp;-400,00']) });
    assert.equal(r.json.added, 1);
    assert.equal((await bo.patch(`/api/accounts/${annaAcct}`, { kind: 'savings' })).status, 403);
    assert.equal((await bo.patch(`/api/accounts/${annaAcct}`, { name: 'Gemensamma kontot' })).status, 204);
    assert.equal((await bo.del(`/api/accounts/${annaAcct}`)).status, 403);
  });

  test('transaktioner på privata konton syns inte i listan för andra', async () => {
    await anna.post('/api/import/commit', { account_id: annaPrivate, text: STMT(['2025-03-06;HEMLIG;-99,00']) });
    assert.equal((await bo.get('/api/transactions?q=HEMLIG')).json.total, 0);
    assert.equal((await anna.get('/api/transactions?q=HEMLIG')).json.total, 1);
    const t = (await anna.get('/api/transactions?q=HEMLIG')).json.items[0];
    assert.equal((await bo.patch(`/api/transactions/${t.id}`, { category_id: (await cats(bo)).Lön })).status, 404);
    assert.equal((await bo.del(`/api/transactions/${t.id}`)).status, 404);
  });

  test('innehav på privat konto är dolt även om innehavet är markerat delat', async () => {
    await anna.post('/api/holdings', { name: 'Hemlig fond', quantity: 1, price_mode: 'manual', manual_price: 100, account_id: annaPrivate });
    assert.equal((await bo.get('/api/holdings')).json.items.some((h) => h.name === 'Hemlig fond'), false);
    assert.equal((await anna.get('/api/holdings')).json.items.some((h) => h.name === 'Hemlig fond'), true);
  });

  test('antaganden delas av hushållet och valideras', async () => {
    assert.equal((await anna.patch('/api/household', { return_rate: 6.5 })).json.assumptions.return_rate, 6.5);
    assert.equal((await bo.get('/api/household')).json.assumptions.return_rate, 6.5);
    assert.equal((await bo.patch('/api/household', { return_rate: 500 })).status, 400);
  });

  test('lämna hushållet: egen kopia av kategorier, kategoriseringen behålls, ensam får inte lämna', async () => {
    const r = await bo.post('/api/household/leave');
    assert.equal(r.status, 200);
    assert.equal(r.json.members.length, 1);
    const b = await cats(bo);
    assert.ok(b.Hund && b.Lön);
    const dog = (await bo.get('/api/transactions?q=Hundmat')).json.items[0];
    assert.equal(dog.category, 'Hund');
    assert.equal((await anna.get('/api/transactions?q=Hundmat')).json.total, 0, 'Bos konto följde med Bo');
    assert.equal((await bo.post('/api/household/leave')).status, 400);
    // Bo ser inte längre Annas konton
    assert.deepEqual((await bo.get('/api/accounts')).json.items.map((x) => x.name), ['Bos konto']);
  });

  test('radera konto: kvarvarande medlems kategorier och transaktioner finns kvar', async () => {
    const carl = app.client();
    await carl.register('carl@h.se', 'Carl');
    const { code } = (await anna.post('/api/household/invite')).json;
    await carl.post('/api/household/join', { code });
    const carlAcct = (await carl.post('/api/accounts', { name: 'Carls', kind: 'checking' })).json.id;
    await carl.post('/api/categories', { name: 'Carls kategori', kind: 'expense' });
    await carl.post('/api/import/commit', { account_id: annaAcct, text: STMT(['2025-04-01;Carl köpte;-50,00']) });
    assert.equal((await carl.post('/api/auth/delete-account', { password: 'losenord-for-test-1' })).status, 200);
    assert.ok((await cats(anna))['Carls kategori'], 'delad kategori finns kvar');
    assert.equal((await anna.get('/api/transactions?q=Carl köpte')).json.total, 1, 'transaktion på Annas konto finns kvar');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = ?').get(carlAcct).n, 0);
  });
});

describe('uppgradering från version 1', () => {
  test('befintlig data får hushåll och behåller kategorisering', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(MIGRATIONS[0]);
    db.exec('PRAGMA user_version = 1');
    db.exec(`
      INSERT INTO users (id, email, name, password_hash) VALUES (1, 'a@b.se', 'Anna', 'x');
      INSERT INTO categories (id, user_id, name, kind) VALUES (1, 1, 'Lön', 'income');
      INSERT INTO accounts (id, user_id, name, kind, opening_balance) VALUES (1, 1, 'Konto', 'checking', 100);
      INSERT INTO transactions (user_id, account_id, date, description, search, amount, category_id, fingerprint) VALUES (1, 1, '2025-01-01', 'LÖN', 'LÖN', 100, 1, 'f');
      INSERT INTO net_worth_snapshots (user_id, date, assets, liabilities) VALUES (1, '2025-01-01', 100, 0);
    `);
    migrate(db);
    const u = db.prepare('SELECT household_id FROM users WHERE id = 1').get();
    assert.ok(u.household_id);
    assert.equal(db.prepare('SELECT household_id FROM accounts WHERE id = 1').get().household_id, u.household_id);
    assert.equal(db.prepare('SELECT household_id FROM categories WHERE id = 1').get().household_id, u.household_id);
    assert.equal(db.prepare('SELECT shared FROM accounts WHERE id = 1').get().shared, 1);
    assert.equal(db.prepare('SELECT category_id FROM transactions').get().category_id, 1);
    assert.deepEqual({ ...db.prepare('SELECT scope, assets FROM net_worth_snapshots').get() }, { scope: 'household', assets: 100 });
  });
});
