import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const STATEMENT = [
  'Bokföringsdag;Text;Belopp;Saldo',
  '2025-03-25;LÖN ACME AB;30000,00;50000,00',
  '2025-03-20;ICA MAXI;-800,00;20000,00',
  '2025-03-15;HYRA MARS;-9000,00;20800,00',
  '2025-03-10;FRISÖR;-500,00;29800,00',
  '2025-03-05;Överföring till spar;-5000,00;30300,00',
  '2025-02-20;ICA MAXI;-700,00;35300,00',
  '2025-02-20;ICA MAXI;-700,00;36000,00',
].join('\n');

describe('import, rapporter och isolering', () => {
  let app, anna, bo, checking, savings, cats;
  before(async () => {
    app = await startApp({ quotes: { 'VOLV-B.ST': { price: 250, currency: 'SEK' }, AAPL: { price: 200, currency: 'USD' }, 'USDSEK=X': { price: 10, currency: 'SEK' } } });
    anna = app.client();
    await anna.register('anna@test.se', 'Anna');
    bo = app.client();
    await bo.register('bo@test.se', 'Bo');
    checking = (await anna.post('/api/accounts', { name: 'Lönekonto', kind: 'checking', balance: 0 })).json.id;
    savings = (await anna.post('/api/accounts', { name: 'Sparkonto', kind: 'savings', balance: 10000000 })).json.id;
    cats = Object.fromEntries((await anna.get('/api/categories')).json.items.map((c) => [c.name, c.id]));
  });
  after(() => app.close());

  test('kräver inloggning', async () => {
    assert.equal((await app.client().get('/api/accounts')).status, 401);
  });

  test('förhandsvisning markerar kategori och inget sparas', async () => {
    const r = await anna.post('/api/import/preview', { account_id: checking, text: STATEMENT });
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 7);
    assert.equal(r.json.new_count, 7);
    assert.equal(r.json.rows.find((x) => x.description === 'ICA MAXI').category, 'Mat och dryck');
    assert.equal(r.json.rows.find((x) => x.description === 'FRISÖR').category, null);
    assert.equal((await anna.get('/api/transactions')).json.total, 0);
  });

  test('import sparar, och en ny import av samma utdrag skapar inga dubbletter', async () => {
    const first = await anna.post('/api/import/commit', { account_id: checking, text: STATEMENT });
    assert.deepEqual([first.json.added, first.json.duplicates], [7, 0]);
    const again = await anna.post('/api/import/commit', { account_id: checking, text: STATEMENT });
    assert.deepEqual([again.json.added, again.json.duplicates], [0, 7]);
    assert.equal((await anna.get('/api/transactions')).json.total, 7);
  });

  test('två identiska rader samma dag behålls båda, och överlappande utdrag tar bara det nya', async () => {
    const overlap = ['Bokföringsdag;Text;Belopp;Saldo', '2025-03-26;KAFÉ;-45,00;49955,00', '2025-02-20;ICA MAXI;-700,00;36000,00', '2025-02-20;ICA MAXI;-700,00;35300,00'].join('\n');
    const r = await anna.post('/api/import/commit', { account_id: checking, text: overlap });
    assert.deepEqual([r.json.added, r.json.duplicates], [1, 2]);
    const ica = (await anna.get('/api/transactions?q=ica maxi&from=2025-02-01&to=2025-02-28')).json;
    assert.equal(ica.total, 2);
  });

  test('resultatrapport: överföringar ingår inte, okategoriserat varnas för', async () => {
    const r = (await anna.get('/api/reports/income?from=2025-03-01&to=2025-03-31')).json;
    assert.equal(r.income, 3000000);
    // Hyra 9 000 + ICA 800 + frisör 500 + kafé 45; "Överföring till spar" saknar regel och räknas som okategoriserad utgift.
    assert.equal(r.expense, 900000 + 80000 + 50000 + 4500 + 500000);
    assert.equal(r.uncategorized.count, 3); // frisör, kafé, överföring
    assert.ok(r.income_lines.some((l) => l.category === 'Lön' && l.amount === 3000000));
    assert.ok(r.expense_lines.some((l) => l.category === 'Okategoriserade utgifter' && l.uncategorized));
  });

  test('att kategorisera som Överföring tar bort beloppet ur resultatet, och en regel slår till på övriga', async () => {
    const tx = (await anna.get('/api/transactions?q=Överföring till spar')).json.items[0];
    const r = await anna.patch(`/api/transactions/${tx.id}`, { category_id: cats['Överföring'], rule_pattern: 'Överföring till spar' });
    assert.equal(r.status, 200);
    const rep = (await anna.get('/api/reports/income?from=2025-03-01&to=2025-03-31')).json;
    assert.equal(rep.expense, 900000 + 80000 + 50000 + 4500);
    assert.equal(rep.transfers.out, 500000);
    assert.equal(rep.net, 3000000 - rep.expense);
    assert.equal(rep.savings_rate, rep.net / 3000000);
  });

  test('månadsserie täcker hela perioden, även månader utan rörelser', async () => {
    const r = (await anna.get('/api/reports/income?from=2025-01-01&to=2025-03-31')).json;
    assert.deepEqual(r.months.map((m) => m.month), ['2025-01', '2025-02', '2025-03']);
    assert.equal(r.months[0].expense, 0);
    assert.equal(r.months[1].expense, 140000);
  });

  test('par av motsatta belopp mellan egna konton kategoriseras som överföring', async () => {
    const a = ['Datum;Text;Belopp', '2025-04-02;Till sparkonto;-1000,00'].join('\n');
    const b = ['Datum;Text;Belopp', '2025-04-03;Från lönekonto;1000,00'].join('\n');
    await anna.post('/api/import/commit', { account_id: checking, text: a });
    const r = await anna.post('/api/import/commit', { account_id: savings, text: b });
    assert.equal(r.json.transfers, 1);
    const rep = (await anna.get('/api/reports/income?from=2025-04-01&to=2025-04-30')).json;
    assert.equal(rep.income + rep.expense, 0);
    assert.equal(rep.transfers.count, 2);
  });

  test('saldo: att sätta saldo räknar fram ingångsvärdet', async () => {
    const before = (await anna.get('/api/accounts')).json.items.find((a) => a.id === checking);
    await anna.patch(`/api/accounts/${checking}`, { balance: 5000000 });
    const after = (await anna.get('/api/accounts')).json.items.find((a) => a.id === checking);
    assert.equal(after.balance, 5000000);
    assert.notEqual(before.balance, after.balance);
  });

  test('balansrapport: tillgångar, skulder och innehav till aktuell kurs', async () => {
    await anna.post('/api/accounts', { name: 'Bolån', kind: 'loan', balance: -150000000 });
    await anna.post('/api/holdings', { name: 'Volvo B', symbol: 'volv-b.st', quantity: 100, price_mode: 'auto' });
    await anna.post('/api/holdings', { name: 'Apple', symbol: 'AAPL', quantity: 10, currency: 'USD', price_mode: 'auto' });
    await anna.post('/api/holdings', { name: 'Fond X', quantity: 50, price_mode: 'manual', manual_price: 120.5 });
    const b = (await anna.get('/api/reports/balance')).json;
    const holding = (n) => b.assets.find((a) => a.type === 'holding' && a.name === n).amount;
    assert.equal(holding('Volvo B'), 2500000);
    assert.equal(holding('Apple'), 2000000); // 10 × 200 USD × 10 kr
    assert.equal(holding('Fond X'), 602500);
    assert.equal(b.liabilities.find((l) => l.name === 'Bolån').amount, 150000000);
    assert.equal(b.equity, b.total_assets - b.total_liabilities);
    assert.deepEqual(b.unpriced, []);
    assert.equal(b.history.length, 1);
  });

  test('innehav utan kurs värderas inte till noll: det varnas för och snapshot hoppas över', async () => {
    const r = await anna.post('/api/holdings', { name: 'Okänt', symbol: 'NOPE', quantity: 5, price_mode: 'auto' });
    assert.equal(r.status, 200);
    const b = (await anna.get('/api/reports/balance')).json;
    assert.equal(b.unpriced.length, 1);
    assert.equal(b.unpriced[0].name, 'Okänt');
    assert.equal(b.assets.some((a) => a.name === 'Okänt'), false);
  });

  test('kurser cachas och en felande kurskälla ger senast kända kurs, markerad som gammal', async () => {
    const calls = () => app.provider.calls.filter((s) => s === 'VOLV-B.ST').length;
    const n = calls();
    await anna.get('/api/holdings');
    assert.equal(calls(), n, 'färsk cache ska inte hämtas igen');
    delete app.provider.quotes['VOLV-B.ST'];
    const forced = (await anna.get('/api/holdings?refresh=1')).json.items.find((h) => h.name === 'Volvo B');
    assert.equal(forced.value, 2500000);
    assert.equal(forced.stale, true);
  });

  test('användare ser aldrig varandras data', async () => {
    assert.deepEqual((await bo.get('/api/accounts')).json.items, []);
    assert.equal((await bo.get('/api/transactions')).json.total, 0);
    assert.equal((await bo.patch(`/api/accounts/${checking}`, { name: 'Hackad' })).status, 404);
    assert.equal((await bo.del(`/api/accounts/${checking}`)).status, 404);
    const tx = (await anna.get('/api/transactions')).json.items[0];
    assert.equal((await bo.patch(`/api/transactions/${tx.id}`, { category_id: cats['Lön'] })).status, 404);
    assert.equal((await bo.post('/api/import/preview', { account_id: checking, text: STATEMENT })).status, 404);
    // Annas kategori kan inte användas av Bo
    const boAcct = (await bo.post('/api/accounts', { name: 'X', kind: 'checking' })).json.id;
    assert.equal((await bo.post('/api/import/commit', { account_id: boAcct, text: STATEMENT })).status, 200);
    const boTx = (await bo.get('/api/transactions?limit=1')).json.items[0];
    assert.equal((await bo.patch(`/api/transactions/${boTx.id}`, { category_id: cats['Lön'] })).status, 404);
    assert.equal((await bo.post('/api/holdings', { name: 'H', symbol: 'AAPL', quantity: 1, account_id: checking })).status, 400);
  });

  test('ogiltig indata avvisas', async () => {
    assert.equal((await anna.post('/api/accounts', { name: 'Ny', kind: 'bitcoin' })).status, 400);
    assert.equal((await anna.post('/api/accounts', { name: 'Ny2', kind: 'checking', balance: 12.5 })).status, 400, 'belopp ska vara heltal i öre');
    assert.equal((await anna.post('/api/accounts', { name: 'Lönekonto', kind: 'checking' })).status, 409);
    assert.equal((await anna.post('/api/holdings', { name: 'H', quantity: -1, symbol: 'X' })).status, 400);
    assert.equal((await anna.post('/api/holdings', { name: 'H', quantity: 1 })).status, 400, 'automatisk kurs kräver symbol');
    assert.equal((await anna.post('/api/rules', { pattern: 'ab', category_id: cats['Lön'] })).status, 400);
    assert.equal((await anna.get('/api/reports/income?from=2025-05-01&to=2025-04-01')).status, 400);
    assert.equal((await anna.post('/api/import/preview', { account_id: checking, text: 'x', mapping: { date: -1 } })).status, 400);
  });

  test('export innehåller bara den egna datan, och radering av konto tar all data', async () => {
    const exp = (await bo.get('/api/export')).json;
    assert.ok(exp.accounts.every((a) => a.name === 'X'));
    assert.equal((await bo.post('/api/auth/delete-account', { password: 'fel' })).status, 400);
    assert.equal((await bo.post('/api/auth/delete-account', { password: 'losenord-for-test-1' })).status, 200);
    assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = (SELECT id FROM users WHERE email = 'bo@test.se')`).get().n, 0);
    assert.equal((await bo.get('/api/accounts')).status, 401);
  });
});

describe('inloggning', () => {
  let app;
  before(async () => (app = await startApp()));
  after(() => app.close());

  test('registrering, utloggning och inloggning', async () => {
    const c = app.client();
    await c.register('x@test.se');
    assert.equal((await c.get('/api/auth/me')).json.user.email, 'x@test.se');
    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await c.post('/api/auth/login', { email: 'x@test.se', password: 'fel' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { email: 'x@test.se', password: 'losenord-for-test-1' })).status, 200);
  });

  test('korta lösenord och dubbla konton avvisas', async () => {
    const c = app.client();
    assert.equal((await c.post('/api/auth/register', { email: 'y@test.se', name: 'Y', password: 'kort' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { email: 'x@test.se', name: 'Y', password: 'losenord-for-test-1' })).status, 409);
  });

  test('ny användare får standardkategorier', async () => {
    const c = app.client();
    await c.register('z@test.se');
    const cats = (await c.get('/api/categories')).json.items;
    assert.ok(cats.some((k) => k.name === 'Lön' && k.kind === 'income'));
    assert.ok(cats.some((k) => k.name === 'Överföring' && k.kind === 'transfer'));
  });
});
