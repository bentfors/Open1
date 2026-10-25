import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { lastCompleteMonths } from '../src/budget.js';
import { suggestBudget } from '../src/budget.js';

const kr = (n) => Math.round(n * 100);
const months = lastCompleteMonths(3); // äldst först

function statement(rows) {
  return ['Datum;Text;Belopp', ...rows.map(([m, day, text, amt]) => `${m}-${day};${text};${String(amt).replace('.', ',')}`)].join('\n');
}

describe('budgetförslag (ren logik)', () => {
  const row = (month, category_id, category, kind, amount) => ({ month, category_id, category, kind, amount });
  test('median med tre månader: engångskostnaden slår inte igenom, och utgifter avrundas uppåt', () => {
    const rows = [
      row('2025-01', 1, 'Mat', 'expense', -280000), row('2025-02', 1, 'Mat', 'expense', -310050), row('2025-03', 1, 'Mat', 'expense', -300000),
      row('2025-02', 2, 'Resor', 'expense', -1200000),
      row('2025-01', 3, 'Lön', 'income', 3000000), row('2025-02', 3, 'Lön', 'income', 3000000), row('2025-03', 3, 'Lön', 'income', 3000000),
      row('2025-01', 4, 'Överföring', 'transfer', -500000),
    ];
    const r = suggestBudget(rows, ['2025-01', '2025-02', '2025-03'], '2025-01');
    assert.equal(r.method, 'median');
    assert.deepEqual(r.lines.map((l) => [l.category, l.amount]), [['Lön', 3000000], ['Mat', 300000]]);
  });

  test('med två månader används medelvärdet', () => {
    const rows = [row('2025-02', 1, 'Mat', 'expense', -300000), row('2025-03', 1, 'Mat', 'expense', -350000)];
    const r = suggestBudget(rows, ['2025-01', '2025-02', '2025-03'], '2025-02');
    assert.equal(r.method, 'average');
    assert.deepEqual(r.months, ['2025-02', '2025-03']);
    assert.equal(r.lines[0].amount, 330000, 'medel 3 250 kr avrundas uppåt till 3 300 kr');
  });

  test('månader före första transaktionen räknas inte som noll', () => {
    const rows = [row('2025-03', 1, 'Mat', 'expense', -300000)];
    const r = suggestBudget(rows, ['2025-01', '2025-02', '2025-03'], '2025-03');
    assert.deepEqual(r.months, ['2025-03']);
    assert.equal(r.lines[0].amount, 300000);
  });

  test('ingen historik ger tomt förslag', () => {
    assert.deepEqual(suggestBudget([], ['2025-01'], null).lines, []);
  });
});

describe('budget, scenarier och mål via API', () => {
  let app, anna, bo, checking, isk, loan, cats;
  before(async () => {
    app = await startApp({ quotes: { 'VOLV-B.ST': { price: 250, currency: 'SEK' } } });
    anna = app.client();
    await anna.register('anna@p.se', 'Anna');
    cats = Object.fromEntries((await anna.get('/api/categories')).json.items.map((c) => [c.name, c.id]));
    checking = (await anna.post('/api/accounts', { name: 'Lönekonto', kind: 'checking', balance: kr(200000) })).json.id;
    isk = (await anna.post('/api/accounts', { name: 'ISK', kind: 'isk', balance: kr(100000) })).json.id;
    loan = (await anna.post('/api/accounts', { name: 'Bolån', kind: 'loan', balance: -kr(1000000), interest_rate: 4, monthly_amortization: kr(2000) })).json.id;
    await anna.post('/api/holdings', { name: 'Volvo', symbol: 'VOLV-B.ST', quantity: 1000, account_id: isk });
    const rows = [];
    months.forEach((m, i) => {
      rows.push([m, '25', 'LÖN ACME', 30000], [m, '01', 'HYRA', -9000], [m, '10', 'ICA MAXI', [-2800, -3150, -3000][i]], [m, '15', 'SPOTIFY', -119]);
      if (i === 1) rows.push([m, '20', 'Flygbiljett', -12000]);
    });
    await anna.post('/api/import/commit', { account_id: checking, text: statement(rows) });
    const flyg = (await anna.get('/api/transactions?q=Flygbiljett')).json.items[0];
    await anna.patch(`/api/transactions/${flyg.id}`, { category_id: cats.Resor });
  });
  after(() => app.close());

  test('budgetförslag bygger på utfallet, ignorerar engångsresan och sparas inte av sig själv', async () => {
    const r = (await anna.get('/api/budget/suggest')).json;
    assert.equal(r.method, 'median');
    const by = Object.fromEntries(r.lines.map((l) => [l.category, l.amount]));
    assert.equal(by.Lön, kr(30000));
    assert.equal(by.Boende, kr(9000));
    assert.equal(by['Mat och dryck'], kr(3000));
    assert.equal(by['Abonnemang och nöje'], kr(200), '119 kr avrundas upp till närmaste hundralapp');
    assert.equal(by.Resor, undefined);
    assert.equal(r.expense, kr(9000 + 3000 + 200));
    assert.equal((await anna.get('/api/budget')).json.items.length, 0);
  });

  test('bekräfta, justera och följ upp budgeten mot utfall', async () => {
    const sug = (await anna.get('/api/budget/suggest')).json;
    const lines = sug.lines.map((l) => ({ category_id: l.category_id, amount: l.category === 'Mat och dryck' ? kr(2500) : l.amount }));
    const put = await anna.call('PUT', '/api/budget', { lines });
    assert.equal(put.status, 200);
    assert.equal(put.json.expense, kr(9000 + 2500 + 200));
    assert.equal(put.json.surplus, kr(30000 - 11700));

    const status = (await anna.get(`/api/budget/status?month=${months[1]}`)).json;
    const mat = status.items.find((i) => i.category === 'Mat och dryck');
    assert.deepEqual([mat.budget, mat.actual, mat.diff], [kr(2500), kr(3150), -kr(650)]);
    const resor = status.items.find((i) => i.category === 'Resor');
    assert.deepEqual([resor.budget, resor.actual, resor.diff], [0, kr(12000), -kr(12000)], 'utfall utan budget syns ändå');
    assert.equal(status.elapsed, 1);
    assert.equal(status.has_budget, true);
  });

  test('budgetvalidering', async () => {
    assert.equal((await anna.call('PUT', '/api/budget', { lines: [{ category_id: cats.Överföring, amount: 100 }] })).status, 400);
    assert.equal((await anna.call('PUT', '/api/budget', { lines: [{ category_id: 99999, amount: 100 }] })).status, 400);
    assert.equal((await anna.call('PUT', '/api/budget', { lines: [{ category_id: cats.Boende, amount: -1 }] })).status, 400);
    assert.equal((await anna.call('PUT', '/api/budget', { lines: [{ category_id: cats.Boende, amount: 1.5 }] })).status, 400);
    assert.equal((await anna.call('PUT', '/api/budget', { lines: [{ category_id: cats.Boende, amount: 1 }, { category_id: cats.Boende, amount: 2 }] })).status, 400);
    assert.equal((await anna.get('/api/budget')).json.items.length > 0, true, 'felaktiga anrop ändrade inte budgeten');
  });

  test('utgångsläget klassar konton och värderar innehav', async () => {
    const r = (await anna.get('/api/plan/start')).json;
    const checkingBalance = (await anna.get('/api/accounts')).json.items.find((a) => a.id === checking).balance;
    assert.ok(checkingBalance > kr(200000), 'importerade transaktioner ligger ovanpå ingångssaldot');
    assert.equal(r.start.cash, checkingBalance);
    assert.equal(r.start.invested, kr(100000) + kr(250000));
    assert.deepEqual(r.start.debts, [{ name: 'Bolån', balance: kr(1000000), rate: 4, amort: kr(2000) }]);
    assert.equal(r.baseline.income, kr(30000));
    assert.equal(r.baseline.expenses, kr(11700), 'budgetens utgifter gäller före historiken');
    assert.equal(r.baseline.expenses_source, 'budget');
    assert.equal(r.baseline.excluded_interest, true);
  });

  test('scenariokörning: båtköp sänker förmögenheten, räntechock sänker den mer', async () => {
    const boat = { type: 'purchase', name: 'Båt', date: months[2], price: kr(400000), down_payment: kr(100000), loan_rate: 5, amortization_years: 10, monthly_costs: kr(1500), one_off_costs: kr(5000), asset_growth: -8 };
    const r = await anna.post('/api/plan/run', { years: 10, events: [boat] });
    assert.equal(r.status, 200);
    assert.equal(r.json.scenario.points.length, 120);
    assert.ok(r.json.delta_end < 0);
    assert.ok(r.json.stress.end.net_worth < r.json.scenario.end.net_worth);
    assert.ok(r.json.purchases[0].stressed.total > r.json.purchases[0].now.total);
    assert.equal(r.json.purchases[0].now.loan, kr(300000));
    assert.equal(r.json.scenario.first_shortfall, null);
  });

  test('överstyrning av inkomst ändrar basfallet, antagandeförändring slår igenom men sparas inte', async () => {
    const a = (await anna.post('/api/plan/run', { years: 5 })).json;
    const b = (await anna.post('/api/plan/run', { years: 5, overrides: { income: kr(20000) } })).json;
    assert.ok(b.base.end.net_worth < a.base.end.net_worth);
    const c = (await anna.post('/api/plan/run', { years: 5, overrides: { return_rate: 0 } })).json;
    assert.ok(c.base.end.net_worth < a.base.end.net_worth);
    assert.equal((await anna.get('/api/household')).json.assumptions.return_rate, 5);
  });

  test('ogiltiga körningar avvisas', async () => {
    assert.equal((await anna.post('/api/plan/run', { years: 0 })).status, 400);
    assert.equal((await anna.post('/api/plan/run', { years: 41 })).status, 400);
    assert.equal((await anna.post('/api/plan/run', { events: [{ type: 'purchase' }] })).status, 400);
    assert.equal((await anna.post('/api/plan/run', { overrides: { income: 1.5 } })).status, 400);
  });

  test('spara, läsa, ändra och ta bort scenario, och en annan familj ser det inte', async () => {
    const ev = [{ type: 'one_off', name: 'Arv', date: '2030-01', amount: kr(100000) }];
    const created = await anna.post('/api/scenarios', { name: 'Arv', horizon_years: 15, events: ev });
    assert.equal(created.status, 200);
    const list = (await anna.get('/api/scenarios')).json.items;
    assert.deepEqual(list.map((s) => [s.name, s.horizon_years, s.events[0].amount]), [['Arv', 15, kr(100000)]]);

    bo = app.client();
    await bo.register('bo@p.se', 'Bo');
    assert.deepEqual((await bo.get('/api/scenarios')).json.items, []);
    assert.equal((await bo.call('PUT', `/api/scenarios/${created.json.id}`, { name: 'x', events: [] })).status, 404);
    assert.equal((await bo.del(`/api/scenarios/${created.json.id}`)).status, 404);

    assert.equal((await anna.call('PUT', `/api/scenarios/${created.json.id}`, { name: 'Arv 2', horizon_years: 10, events: [] })).status, 204);
    assert.equal((await anna.get('/api/scenarios')).json.items[0].name, 'Arv 2');
    assert.equal((await anna.post('/api/scenarios', { name: 'Fel', events: [{ type: 'x' }] })).status, 400);
    assert.equal((await anna.del(`/api/scenarios/${created.json.id}`)).status, 204);
  });

  test('mål: sparat räknas från manuellt belopp, länkat konto och innehav', async () => {
    const date = `${new Date().getFullYear() + 3}-06-01`;
    const g = await anna.post('/api/goals', { name: 'Hus', target_amount: kr(1000000), target_date: date, manual_amount: kr(50000), monthly_contribution: kr(10000), account_ids: [isk] });
    assert.equal(g.status, 200);
    const r = (await anna.get('/api/goals')).json;
    const goal = r.items[0];
    assert.equal(goal.current, kr(50000) + kr(100000) + kr(250000), 'manuellt + ISK-saldo + Volvo-aktierna på kontot');
    assert.ok(goal.months_left >= 30);
    assert.ok(['on_track', 'behind'].includes(goal.status));
    assert.ok(goal.needed_monthly > 0);
    assert.equal(r.summary.surplus, kr(30000 - 11700));
    assert.equal(r.summary.required_monthly, goal.needed_monthly);
  });

  test('mål kan inte länka andras privata konton och försvinner inte vid felaktig uppdatering', async () => {
    const secret = (await bo.post('/api/accounts', { name: 'Bos hemliga', kind: 'savings', shared: false })).json.id;
    const date = `${new Date().getFullYear() + 1}-01-01`;
    assert.equal((await anna.post('/api/goals', { name: 'X', target_amount: 100, target_date: date, account_ids: [secret] })).status, 400);
    assert.equal((await anna.post('/api/goals', { name: 'X', target_amount: 0, target_date: date })).status, 400);
    assert.equal((await anna.post('/api/goals', { name: 'X', target_amount: 100, target_date: 'snart' })).status, 400);
    assert.equal((await bo.get('/api/goals')).json.items.length, 0);
  });

  test('mål följer med när ett konto görs privat: den andra medlemmen räknar det inte', async () => {
    const { code } = (await anna.post('/api/household/invite')).json;
    const carl = app.client();
    await carl.register('carl@p.se', 'Carl');
    await carl.post('/api/household/join', { code });
    const before = (await carl.get('/api/goals')).json.items[0];
    assert.equal(before.hidden_accounts, 0);
    assert.equal((await anna.patch(`/api/accounts/${isk}`, { shared: false })).status, 204);
    const after = (await carl.get('/api/goals')).json.items[0];
    assert.equal(after.hidden_accounts, 1);
    assert.equal(after.current, kr(50000), 'bara det manuella beloppet syns för Carl');
    const own = (await anna.get('/api/goals')).json.items[0];
    assert.equal(own.hidden_accounts, 0);
  });

  test('uppgifter om andra hushåll läcker inte via utgångsläget', async () => {
    const dana = app.client();
    await dana.register('dana@p.se', 'Dana');
    const r = (await dana.get('/api/plan/start')).json;
    assert.equal(r.start.cash, 0);
    assert.deepEqual(r.start.debts, []);
    assert.ok(r.warnings.length > 0, 'varnar för okänd inkomst');
  });
});
