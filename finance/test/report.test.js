import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { lastCompleteMonths } from '../src/budget.js';
import { buildInsights } from '../src/insights.js';
import { merchantKey } from '../src/report.js';

const kr = (n) => Math.round(n * 100);
const [m3, m2, m1, m0] = lastCompleteMonths(4); // m0 = senaste avslutade månaden, rapportens månad

const stmt = (rows) => ['Datum;Text;Belopp', ...rows.map(([m, d, t, a]) => `${m}-${d};${t};${String(a).replace('.', ',')}`)].join('\n');

describe('handelsnyckel', () => {
  test('siffror och ort spelar ingen roll', () => {
    assert.equal(merchantKey('ICA MAXI 1234 STOCKHOLM'), merchantKey('Ica Maxi 5678 Stockholm'));
    assert.equal(merchantKey('12345'), '');
    assert.equal(merchantKey('SPOTIFY AB 2024-03-01'), 'SPOTIFY AB');
  });
});

describe('observationer (ren logik)', () => {
  const facts = (o = {}) => ({
    month: '2025-03', income: kr(30000), expense: kr(20000), net: kr(10000), expense_avg3: kr(20000), top_changes: [],
    budget: { has: false, lines: [], total_budget: 0, total_actual: 0 }, missing_recurring: [], new_large: [],
    uncategorized: { count: 0, amount: 0 }, transaction_count: 20, accounts: [], unpriced: [], debts: [], debts_total: 0,
    cash: kr(150000), invested: 0, fixed: 0, holdings: [], monthly_expense_basis: kr(20000), annual_income: kr(360000),
    has_income: true, has_insurance_expense: true, goals: [], ...o,
  });
  const ids = (f) => buildInsights(f).map((i) => i.id);

  test('underskott och sparande', () => {
    assert.ok(ids(facts({ net: -kr(500) })).includes('deficit'));
    assert.ok(ids(facts()).includes('saved'));
    assert.ok(!ids(facts()).includes('deficit'));
  });

  test('buffert: under tre månader varnar, över sex är ok', () => {
    const low = buildInsights(facts({ cash: kr(30000) })).find((i) => i.id === 'buffer');
    assert.equal(low.level, 'warn');
    const high = buildInsights(facts({ cash: kr(200000) })).find((i) => i.id === 'buffer');
    assert.equal(high.level, 'ok');
  });

  test('koncentration: ett innehav över en fjärdedel av värdepapperen', () => {
    const f = facts({ holdings: [{ name: 'A', value: kr(80000) }, { name: 'B', value: kr(20000) }] });
    assert.ok(ids(f).includes('concentration'));
    const even = facts({ holdings: [{ name: 'A', value: kr(25000) }, { name: 'B', value: kr(25000) }, { name: 'C', value: kr(25000) }, { name: 'D', value: kr(25000) }] });
    assert.ok(!ids(even).includes('concentration'));
  });

  test('diskussionspunkterna för rådgivaren markeras som sådana', () => {
    const adv = buildInsights(facts({ accounts: [], goals: [], has_insurance_expense: false })).filter((i) => i.audience === 'advisor').map((i) => i.id);
    assert.ok(adv.includes('no_pension') && adv.includes('no_insurance') && adv.includes('no_goals'));
  });

  test('skuldkvot och dyr skuld', () => {
    const f = facts({ debts_total: kr(2000000), debts: [{ name: 'Kort', balance: kr(20000), rate: 18 }] });
    const d = buildInsights(f).find((i) => i.id === 'debt_ratio');
    assert.equal(d.level, 'warn');
    assert.ok(ids(f).includes('expensive_debt:Kort'));
  });

  test('texterna ger inga rekommendationer att köpa eller sälja', () => {
    const f = facts({ net: -kr(1), holdings: [{ name: 'A', value: 100 }], cash: kr(500000), debts_total: kr(3000000), goals: [{ id: 1, name: 'X', status: 'behind', shortfall: 100, needed_monthly: 100, monthly_contribution: 0, current: 0, target_amount: 1 }] });
    const text = buildInsights(f).map((i) => `${i.title} ${i.text}`).join(' ').toLowerCase();
    for (const word of ['köp ', 'sälj ', 'bör du', 'rekommend', 'investera i']) assert.ok(!text.includes(word), `innehåller "${word}"`);
  });
});

describe('månadsrapport via API', () => {
  let app, anna, bo, checking, cats;
  before(async () => {
    app = await startApp();
    anna = app.client();
    await anna.register('anna@r.se', 'Anna');
    cats = Object.fromEntries((await anna.get('/api/categories')).json.items.map((c) => [c.name, c.id]));
    checking = (await anna.post('/api/accounts', { name: 'Lönekonto', kind: 'checking', balance: kr(100000) })).json.id;
    const rows = [];
    [[m3, 2800], [m2, 3000], [m1, 3200]].forEach(([m, ica]) => rows.push([m, '25', 'LÖN ACME AB', 30000], [m, '26', 'EXTRAJOBB AB', 5000], [m, '01', 'HYRA', -9000], [m, '10', 'ICA MAXI', -ica], [m, '12', 'GYM FRISKIS', -399]));
    rows.push([m0, '25', 'LÖN ACME AB', 30000], [m0, '01', 'HYRA', -9000], [m0, '10', 'ICA MAXI', -5500], [m0, '14', 'NY SOFFA IKEA', -6000], [m0, '20', 'OKÄND KILLE', -200]);
    assert.equal((await anna.post('/api/import/commit', { account_id: checking, text: stmt(rows) })).status, 200);
  });
  after(() => app.close());

  const report = async (c = anna, q = '') => (await c.get(`/api/report/monthly${q}`)).json;

  test('standardmånad är den senaste avslutade, och ogiltig månad faller tillbaka på den', async () => {
    assert.equal((await report()).month, m0);
    assert.equal((await report(anna, '?month=skräp')).month, m0);
    assert.equal((await report(anna, `?month=${m1}`)).month, m1);
  });

  test('resultat och jämförelse med föregående månader', async () => {
    const r = await report();
    assert.equal(r.result.income, kr(30000));
    assert.equal(r.result.expense, kr(9000 + 5500 + 6000 + 200));
    assert.equal(r.result.net, kr(9300));
    assert.equal(r.months_compared, 3);
    assert.equal(r.previous.expense_avg, kr(9000 + 3000 + 399));
    assert.equal(r.previous.income_avg, kr(35000));
    const mat = r.top_changes.find((c) => c.category === 'Mat och dryck');
    assert.deepEqual([mat.amount, mat.prior_avg, mat.delta], [kr(5500), kr(3000), kr(2500)]);
  });

  test('observationer: högre utgifter, uteblivna poster, nya stora köp, okategoriserat', async () => {
    const ids = (await report()).insights.map((i) => i.id);
    for (const want of ['expenses_up', 'missing_income:EXTRAJOBB AB', 'missing_expense', 'new_large', 'uncategorized', 'no_budget', 'buffer']) assert.ok(ids.includes(want), `saknar ${want}: ${ids}`);
    const r = await report();
    assert.match(r.insights.find((i) => i.id === 'missing_income:EXTRAJOBB AB').text, /5\s000 kr/);
    assert.match(r.insights.find((i) => i.id === 'new_large').text, /NY SOFFA IKEA/);
    assert.equal(r.insights.find((i) => i.id === 'uncategorized').level, 'warn');
  });

  test('budget i rapporten: över budget flaggas och ingen budget-observation visas längre', async () => {
    await anna.call('PUT', '/api/budget', { lines: [{ category_id: cats['Mat och dryck'], amount: kr(4000) }, { category_id: cats.Boende, amount: kr(9000) }] });
    const r = await report();
    assert.equal(r.budget.has, true);
    const over = r.insights.find((i) => i.id === 'budget_over');
    assert.match(over.text, /Mat och dryck \(1\s500 kr över\)/);
    assert.ok(!r.insights.some((i) => i.id === 'no_budget'));
  });

  test('månad före första transaktionen ger ingen jämförelse', async () => {
    const r = await report(anna, `?month=${m3}`);
    assert.equal(r.months_compared, 0);
    assert.equal(r.previous, null);
    assert.ok(!r.insights.some((i) => i.id === 'expenses_up' || i.id === 'new_large'));
  });

  test('en annan användare ser ingenting av Annas data', async () => {
    bo = app.client();
    await bo.register('bo@r.se', 'Bo');
    const r = await report(bo);
    assert.equal(r.result.income, 0);
    assert.equal(r.balance.cash, 0);
    assert.ok(!r.insights.some((i) => i.id.startsWith('missing_income')));
  });

  test('kräver inloggning', async () => {
    assert.equal((await app.client().get('/api/report/monthly')).status, 401);
  });
});
