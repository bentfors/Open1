import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { config } from '../src/config.js';
import { lastCompleteMonths } from '../src/budget.js';

const kr = (n) => Math.round(n * 100);
const [, , m1, m0] = lastCompleteMonths(4);
const stmt = (rows) => ['Datum;Text;Belopp', ...rows.map(([m, d, t, a]) => `${m}-${d};${t};${String(a).replace('.', ',')}`)].join('\n');

describe('rådgivare och samtycke', () => {
  let app, anna, bo, rolf, eva, shared, secret, grantId, code, cats;
  const advisorGet = (c, path) => c.get(`/api/advisor/clients/${grantId}${path}`);

  before(async () => {
    app = await startApp();
    anna = app.client();
    await anna.register('anna@a.se', 'Anna');
    rolf = app.client();
    await rolf.register('rolf@a.se', 'Rolf Rådgivare');
    eva = app.client();
    await eva.register('eva@a.se', 'Eva Utomstående');
    cats = Object.fromEntries((await anna.get('/api/categories')).json.items.map((c) => [c.name, c.id]));

    shared = (await anna.post('/api/accounts', { name: 'Gemensamt konto', kind: 'checking', balance: kr(50000) })).json.id;
    secret = (await anna.post('/api/accounts', { name: 'Annas hemliga', kind: 'savings', balance: kr(777000), shared: false })).json.id;
    await anna.post('/api/holdings', { name: 'Hemlig fond', quantity: 1, price_mode: 'manual', manual_price: 123456, account_id: secret });
    const rows = [[m1, '25', 'LÖN ACME', 30000], [m1, '01', 'HYRA', -9000], [m0, '25', 'LÖN ACME', 30000], [m0, '01', 'HYRA', -9000]];
    await anna.post('/api/import/commit', { account_id: shared, text: stmt(rows) });
    await anna.post('/api/import/commit', { account_id: secret, text: stmt([[m0, '05', 'HEMLIG HANDLARE', -1234]]) });
    await anna.post('/api/scenarios', { name: 'Båt', horizon_years: 5, events: [{ type: 'one_off', name: 'Båt', date: '2030-01', amount: -kr(100000) }] });
  });
  after(() => app.close());

  test('en rådgivare utan samtycke ser ingenting', async () => {
    assert.equal((await rolf.get('/api/advisor/clients/1/overview')).status, 404);
    assert.equal((await app.client().get('/api/advisor/clients')).status, 401);
    assert.deepEqual((await rolf.get('/api/advisor/clients')).json.items, []);
  });

  test('kunden ger samtycke och koden löses in en gång', async () => {
    const g = await anna.post('/api/advisors', { level: 'summary', months: 6 });
    assert.equal(g.status, 200);
    grantId = g.json.id;
    code = g.json.code;
    assert.equal((await anna.get('/api/advisors')).json.items[0].state, 'invitation');
    assert.equal((await rolf.get(`/api/advisor/clients/${grantId}/overview`)).status, 404, 'inte inlöst än');

    assert.equal((await rolf.post('/api/advisor/redeem', { code: 'fel-kod' })).status, 400);
    assert.equal((await anna.post('/api/advisor/redeem', { code })).status, 400, 'kan inte vara rådgivare åt sitt eget hushåll');
    const r = await rolf.post('/api/advisor/redeem', { code });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'active');
    assert.equal((await eva.post('/api/advisor/redeem', { code })).status, 400, 'koden är förbrukad');
    assert.equal((await anna.get('/api/advisors')).json.items[0].advisor, 'Rolf Rådgivare');
  });

  test('övriga användare kommer inte åt samtycket', async () => {
    assert.equal((await eva.get(`/api/advisor/clients/${grantId}/overview`)).status, 404);
    assert.equal((await eva.get(`/api/advisor/clients/${grantId}/report`)).status, 404);
    assert.equal((await eva.post(`/api/advisors/${grantId}/revoke`)).status, 404);
    assert.equal((await eva.post(`/api/advisors/${grantId}/approve`)).status, 404);
    assert.equal((await rolf.post(`/api/advisors/${grantId}/revoke`)).status, 404, 'rådgivaren kan inte återkalla åt kunden');
  });

  test('översikten visar delade konton och aldrig privata', async () => {
    const r = await advisorGet(rolf, `/overview?month=${m0}`);
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.json);
    assert.ok(!text.includes('hemliga'), 'privat kontonamn läcker');
    assert.ok(!text.includes('Hemlig fond'), 'privat innehav läcker');
    assert.ok(!text.includes('HEMLIG HANDLARE'));
    const names = r.json.balance.assets.map((a) => a.name);
    assert.deepEqual(names, ['Gemensamt konto']);
    assert.equal(r.json.balance.total_assets, kr(50000 + 60000 - 18000));
    assert.equal(r.json.client.level, 'summary');
    assert.deepEqual(r.json.client.members, ['Anna']);
    assert.equal(r.json.report.result.income, kr(30000));
    assert.ok(r.json.report.insights.some((i) => i.audience === 'advisor'));
    assert.equal(r.json.scenarios.length, 1);
    assert.equal(r.json.income_12m.income, kr(60000));
  });

  test('månadsrapporten via rådgivare har samma siffror men utan privata transaktioner', async () => {
    const r = (await advisorGet(rolf, `/report?month=${m0}`)).json;
    assert.equal(r.result.expense, kr(9000), 'den privata utgiften på 1 234 kr ingår inte');
    const own = (await anna.get(`/api/report/monthly?month=${m0}`)).json;
    assert.equal(own.result.expense, kr(9000 + 1234), 'kunden själv ser sin privata utgift');
  });

  test('scenario kan köras av rådgivaren, men bara hushållets egna', async () => {
    const list = (await advisorGet(rolf, '/overview')).json.scenarios;
    const run = await advisorGet(rolf, `/scenarios/${list[0].id}/run`);
    assert.equal(run.status, 200);
    assert.equal(run.json.name, 'Båt');
    assert.equal(run.json.years, 5);
    assert.equal((await advisorGet(rolf, '/scenarios/9999/run')).status, 404);
  });

  test('enskilda transaktioner kräver nivån detaljer', async () => {
    assert.equal((await advisorGet(rolf, '/transactions')).status, 403);
  });

  test('åtkomstloggen visar rådgivarens anrop för kunden', async () => {
    const log = (await anna.get('/api/advisors')).json.log;
    const actions = log.map((l) => l.action);
    assert.ok(actions.some((a) => a.startsWith('Översikt')));
    assert.ok(actions.some((a) => a.startsWith('Månadsrapport')));
    assert.ok(actions.includes('Scenario'));
    assert.ok(log.every((l) => l.advisor === 'Rolf Rådgivare'));
    assert.equal((await eva.get('/api/advisors')).json.log.length, 0, 'loggen är hushållets egen');
  });

  test('en ny hushållsmedlem gör samtycket vilande tills hen godkänt', async () => {
    bo = app.client();
    await bo.register('bo@a.se', 'Bo');
    const { code: invite } = (await anna.post('/api/household/invite')).json;
    await bo.post('/api/household/join', { code: invite });
    assert.equal((await advisorGet(rolf, '/overview')).status, 404, 'Bo har inte godkänt');
    const g = (await bo.get('/api/advisors')).json.items[0];
    assert.equal(g.state, 'awaiting_approval');
    assert.equal(g.i_approved, false);
    assert.deepEqual(g.approvals.missing.map((m) => m.name), ['Bo']);
    assert.equal((await rolf.get('/api/advisor/clients')).json.items[0].state, 'awaiting_approval');
    assert.deepEqual((await rolf.get('/api/advisor/clients')).json.items[0].members, [], 'inga uppgifter om medlemmarna förrän samtycket är aktivt');

    assert.equal((await bo.post(`/api/advisors/${grantId}/approve`)).status, 200);
    assert.equal((await advisorGet(rolf, '/overview')).status, 200);
  });

  test('vem som helst i hushållet kan återkalla, och det går inte att ångra', async () => {
    assert.equal((await bo.post(`/api/advisors/${grantId}/revoke`)).status, 200);
    assert.equal((await advisorGet(rolf, '/overview')).status, 404);
    assert.equal((await anna.post(`/api/advisors/${grantId}/approve`)).status, 400, 'återkallat samtycke kan inte godkännas igen');
    assert.deepEqual((await rolf.get('/api/advisor/clients')).json.items, []);
  });

  test('rådgivarens anteckningar är hens egna: kunden ser dem inte och de stannar efter återkallelse', async () => {
    const g2 = await anna.post('/api/advisors', { level: 'summary' });
    await rolf.post('/api/advisor/redeem', { code: g2.json.code });
    // Bo är nu med i hushållet och har inte godkänt det nya samtycket
    assert.equal((await rolf.post(`/api/advisor/clients/${g2.json.id}/notes`, { body: 'x' })).status, 403, 'inte aktivt');
    await bo.post(`/api/advisors/${g2.json.id}/approve`);
    const n = await rolf.post(`/api/advisor/clients/${g2.json.id}/notes`, { body: 'Prata om buffert och pension.' });
    assert.equal(n.status, 200);
    assert.equal((await rolf.post(`/api/advisor/clients/${g2.json.id}/notes`, { body: '' })).status, 400);
    assert.equal((await eva.get(`/api/advisor/clients/${g2.json.id}/notes`)).status, 404);
    assert.ok(!JSON.stringify((await anna.get('/api/advisors')).json).includes('buffert och pension'));
    await anna.post(`/api/advisors/${g2.json.id}/revoke`);
    const after = await rolf.get(`/api/advisor/clients/${g2.json.id}/notes`);
    assert.equal(after.json.items.length, 1);
    assert.equal((await rolf.post(`/api/advisor/clients/${g2.json.id}/notes`, { body: 'mer' })).status, 403);
    assert.equal((await rolf.get(`/api/advisor/clients/${g2.json.id}/overview`)).status, 404);
  });

  test('detaljnivå ger transaktioner, men fortfarande aldrig från privata konton', async () => {
    const g3 = await anna.post('/api/advisors', { level: 'detail' });
    await rolf.post('/api/advisor/redeem', { code: g3.json.code });
    await bo.post(`/api/advisors/${g3.json.id}/approve`);
    const r = await rolf.get(`/api/advisor/clients/${g3.json.id}/transactions`);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 4);
    assert.ok(!JSON.stringify(r.json).includes('HEMLIG HANDLARE'));
    const q = await rolf.get(`/api/advisor/clients/${g3.json.id}/transactions?q=hyra`);
    assert.equal(q.json.total, 2);
  });

  test('utgångna samtycken och koder fungerar inte', async () => {
    const g = await anna.post('/api/advisors', { level: 'summary' });
    app.db.prepare(`UPDATE advisor_grants SET code_expires_at = datetime('now', '-1 day') WHERE id = ?`).run(g.json.id);
    assert.equal((await rolf.post('/api/advisor/redeem', { code: g.json.code })).status, 400, 'koden har gått ut');
    const h = await anna.post('/api/advisors', { level: 'summary' });
    await rolf.post('/api/advisor/redeem', { code: h.json.code });
    await bo.post(`/api/advisors/${h.json.id}/approve`);
    assert.equal((await rolf.get(`/api/advisor/clients/${h.json.id}/overview`)).status, 200);
    app.db.prepare(`UPDATE advisor_grants SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(h.json.id);
    assert.equal((await rolf.get(`/api/advisor/clients/${h.json.id}/overview`)).status, 404, 'samtycket har gått ut');
  });

  test('indata valideras', async () => {
    assert.equal((await anna.post('/api/advisors', { level: 'allt' })).status, 400);
    assert.equal((await anna.post('/api/advisors', { level: 'summary', months: 0 })).status, 400);
    assert.equal((await anna.post('/api/advisors', { level: 'summary', months: 25 })).status, 400);
  });

  test('funktionen kan stängas av', async () => {
    config.advisorEnabled = false;
    try {
      assert.equal((await anna.post('/api/advisors', { level: 'summary' })).status, 404);
      assert.equal((await rolf.get('/api/advisor/clients')).status, 404);
      assert.equal((await rolf.post('/api/advisor/redeem', { code: 'x' })).status, 404);
    } finally {
      config.advisorEnabled = true;
    }
  });

  test('om rådgivaren raderar sitt konto försvinner samtycket men kundens data finns kvar', async () => {
    assert.equal((await rolf.post('/api/auth/delete-account', { password: 'losenord-for-test-1' })).status, 200);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM advisor_grants WHERE advisor_id IS NOT NULL').get().n, 0);
    assert.equal((await anna.get('/api/accounts')).json.items.length, 2);
  });
});

describe('rådgivarvyn avslöjar inte att privata konton finns', () => {
  test('mål som länkar ett privat konto visar inga kontolänkar för rådgivaren', async () => {
    const app = await startApp();
    try {
      const anna = app.client();
      await anna.register('a@x.se', 'Anna');
      const rolf = app.client();
      await rolf.register('r@x.se', 'Rolf');
      const secret = (await anna.post('/api/accounts', { name: 'Hemligt sparkonto', kind: 'savings', balance: kr(1000), shared: false })).json.id;
      const date = `${new Date().getFullYear() + 2}-01-01`;
      await anna.post('/api/goals', { name: 'Resa', target_amount: kr(10000), target_date: date, account_ids: [secret] });
      const g = await anna.post('/api/advisors', { level: 'summary' });
      await rolf.post('/api/advisor/redeem', { code: g.json.code });
      const r = await rolf.get(`/api/advisor/clients/${g.json.id}/overview`);
      assert.equal(r.status, 200);
      assert.equal(r.json.goals.items.length, 1);
      assert.ok(!('account_ids' in r.json.goals.items[0]) && !('hidden_accounts' in r.json.goals.items[0]));
      assert.ok(!JSON.stringify(r.json).includes('Hemligt sparkonto'));
    } finally {
      await app.close();
    }
  });
});
