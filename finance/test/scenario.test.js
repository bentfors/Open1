import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { project, validateEvents, purchaseMonthlyCost, ymAdd, ymDiff } from '../src/scenario.js';

const kr = (n) => Math.round(n * 100);
const flat = { return_rate: 0, cash_rate: 0, fixed_growth: 0, inflation: 0 };
const run = (o) => project({ start: { cash: 0, invested: 0, fixed: 0, debts: [] }, baseline: { income: 0, expenses: 0 }, assumptions: flat, startMonth: '2025-01', years: 1, ...o });
const near = (actual, expectedKr, tolKr = 1) => assert.ok(Math.abs(actual - kr(expectedKr)) <= kr(tolKr), `${actual / 100} kr är inte nära ${expectedKr} kr`);

describe('månadshjälpare', () => {
  test('ymAdd och ymDiff', () => {
    assert.equal(ymAdd('2025-11', 3), '2026-02');
    assert.equal(ymAdd('2025-01', 0), '2025-01');
    assert.equal(ymDiff('2025-01', '2026-03'), 14);
  });
});

describe('prognos utan händelser', () => {
  test('sparande utan ränta: 5 000 kr i månaden i ett år', () => {
    const r = run({ start: { cash: kr(100000), invested: 0, fixed: 0, debts: [] }, baseline: { income: kr(30000), expenses: kr(25000) } });
    assert.equal(r.end.net_worth, kr(160000));
    assert.equal(r.points.length, 12);
    assert.equal(r.points[0].month, '2025-02', 'första projicerade månaden är nästa');
  });

  test('placeringar växer med avkastningen: 6 % i tio år', () => {
    const r = run({ start: { cash: 0, invested: kr(1000000), fixed: 0, debts: [] }, assumptions: { ...flat, return_rate: 6 }, years: 10 });
    near(r.end.net_worth, 1000000 * 1.06 ** 10, 2);
  });

  test('inflation höjer både inkomst och utgifter, så överskottet följer med', () => {
    const r = run({ baseline: { income: kr(30000), expenses: kr(25000) }, assumptions: { ...flat, inflation: 2 }, years: 2 });
    // Överskott 5 000 kr i dagens pengar. Månad k tjänar 5 000 × 1,02^(k/12).
    let expected = 0;
    for (let k = 1; k <= 24; k++) expected += 5000 * 1.02 ** (k / 12);
    near(r.end.net_worth, expected, 1);
  });

  test('negativt överskott tas från placeringar när kontanterna är slut', () => {
    const r = run({ start: { cash: 0, invested: kr(500000), fixed: 0, debts: [] }, baseline: { income: kr(20000), expenses: kr(30000) }, years: 1 });
    assert.equal(r.points[0].invested, kr(490000));
    assert.equal(r.points[0].cash, 0);
    assert.equal(r.first_shortfall, null);
  });

  test('underskott redovisas när både kontanter och placeringar är slut', () => {
    const r = run({ start: { cash: kr(10000), invested: kr(10000), fixed: 0, debts: [] }, baseline: { income: 0, expenses: kr(10000) }, years: 1 });
    assert.equal(r.first_shortfall, '2025-04');
    assert.ok(r.end.cash < 0);
    assert.ok(r.min_liquid < 0);
  });

  test('befintligt lån: ränta och amortering', () => {
    const r = run({ start: { cash: kr(100000), invested: 0, fixed: 0, debts: [{ name: 'Bolån', balance: kr(1000000), rate: 4, amort: kr(2000) }] } });
    // Månad 1: ränta 1 000 000 × 4 % / 12 = 3 333,33 kr, amortering 2 000 kr
    assert.equal(r.points[0].interest, 333333);
    assert.equal(r.points[0].amortization, kr(2000));
    assert.equal(r.points[0].debts, kr(998000));
    near(r.points[0].cash, 100000 - 3333.33 - 2000, 0.02);
    // Amortering är inte en förlust: nettoförmögenheten minskar bara med räntan
    near(r.points[0].net_worth, 100000 - 1000000 - 3333.33, 0.02);
  });
});

describe('köp', () => {
  const boat = { type: 'purchase', name: 'Båt', kind: 'other', date: '2025-02', sell_date: null, price: kr(500000), down_payment: kr(100000), loan_rate: 5, amortization_years: 10, monthly_costs: kr(2000), one_off_costs: 0, asset_growth: -10 };

  test('båt på lån: handräknat facit efter ett år', () => {
    const r = run({ start: { cash: kr(1000000), invested: 0, fixed: 0, debts: [] }, events: [boat] });
    // Se kommentaren i testfilen: ränta 19 083,33, amortering 40 000, löpande 24 000, kontantinsats 100 000
    near(r.end.cash, 1000000 - 100000 - 24000 - 40000 - 19083.33, 1);
    near(r.end.debts, 360000, 1);
    near(r.end.assets, 450000, 1);
    near(r.end.net_worth, 906916.67, 2);
    near(r.total_interest, 19083.33, 1);
  });

  test('köpet kostar nettoförmögenhet när tillgången tappar i värde', () => {
    const without = run({ start: { cash: kr(1000000), invested: 0, fixed: 0, debts: [] } });
    const withBoat = run({ start: { cash: kr(1000000), invested: 0, fixed: 0, debts: [] }, events: [boat] });
    assert.ok(withBoat.end.net_worth < without.end.net_worth - kr(80000));
  });

  test('utan pengar för kontantinsatsen blir det underskott direkt', () => {
    const r = run({ events: [boat] });
    assert.equal(r.first_shortfall, '2025-02');
  });

  test('kontantinsatsen tas från placeringar om kontanterna inte räcker', () => {
    const r = run({ start: { cash: 0, invested: kr(300000), fixed: 0, debts: [] }, events: [boat] });
    assert.equal(r.first_shortfall, null);
    assert.ok(r.points[0].invested < kr(300000) - kr(100000) + 1);
  });

  test('försäljning betalar lånet och ger kontanter', () => {
    const flatBoat = { ...boat, asset_growth: 0, monthly_costs: 0, amortization_years: 0, loan_rate: 0, sell_date: '2025-07' };
    const r = run({ start: { cash: kr(200000), invested: 0, fixed: 0, debts: [] }, events: [flatBoat] });
    assert.equal(r.end.assets, 0);
    assert.equal(r.end.debts, 0);
    assert.equal(r.end.net_worth, kr(200000), 'pris in, pris ut, ingen ränta: förmögenheten är oförändrad');
    assert.deepEqual(r.sold.map((s) => [s.name, s.loan_repaid]), [['Båt', kr(400000)]]);
  });

  test('bostad med för hög belåning varnar', () => {
    const r = run({ start: { cash: kr(1000000), invested: 0, fixed: 0, debts: [] }, events: [{ ...boat, kind: 'home', price: kr(3000000), down_payment: kr(300000) }] });
    assert.match(r.warnings[0], /85 %/);
  });

  test('månadskostnad och räntechock', () => {
    const c = purchaseMonthlyCost(boat);
    assert.equal(c.loan, kr(400000));
    assert.equal(c.interest, 166667);
    assert.equal(c.amortization, Math.round(kr(400000) / 120));
    assert.equal(c.total, c.interest + c.amortization + kr(2000));
    const stressed = purchaseMonthlyCost(boat, 2);
    assert.equal(stressed.interest, Math.round(kr(400000) * 7 / 1200));
    assert.ok(stressed.total > c.total);
  });

  test('räntechock påverkar prognosen', () => {
    const base = { start: { cash: kr(1000000), invested: 0, fixed: 0, debts: [] }, events: [boat] };
    assert.ok(run({ ...base, rateShock: 3 }).end.net_worth < run(base).end.net_worth);
  });
});

describe('engångsbelopp och månadsposter', () => {
  test('arv i månad 3 och föräldraledighet månad 2–4', () => {
    const r = run({
      start: { cash: kr(10000), invested: 0, fixed: 0, debts: [] },
      events: [
        { type: 'one_off', name: 'Arv', date: '2025-03', amount: kr(50000) },
        { type: 'monthly', name: 'Föräldraledig', from: '2025-02', to: '2025-04', amount: -kr(8000) },
      ],
    });
    assert.equal(r.points[0].cash, kr(2000)); // feb: −8 000
    assert.equal(r.points[1].cash, kr(44000)); // mar: −8 000 + 50 000
    assert.equal(r.points[2].cash, kr(36000)); // apr: −8 000
    assert.equal(r.points[3].cash, kr(36000)); // maj: posten har slutat
  });

  test('händelser daterade före prognosens start räknas i första månaden', () => {
    const r = run({ events: [{ type: 'one_off', name: 'Bonus', date: '2024-06', amount: kr(1000) }] });
    assert.equal(r.points[0].cash, kr(1000));
    assert.equal(r.end.cash, kr(1000), 'räknas bara en gång');
  });
});

describe('validering av händelser', () => {
  const ok = { type: 'purchase', name: 'Hus', date: '2026-06', price: 100000000, down_payment: 15000000 };
  test('giltig händelse rensas på okända fält', () => {
    const r = validateEvents([{ ...ok, evil: '<script>', kind: 'home' }]);
    assert.equal(r.error, undefined);
    assert.equal(r.events[0].evil, undefined);
    assert.equal(r.events[0].kind, 'home');
    assert.equal(r.events[0].loan_rate, 0);
  });
  for (const [label, ev] of [
    ['okänd typ', { ...ok, type: 'hack' }],
    ['namn saknas', { ...ok, name: '' }],
    ['dåligt datum', { ...ok, date: '2026-13' }],
    ['kontantinsats över priset', { ...ok, down_payment: ok.price + 1 }],
    ['decimal i öre', { ...ok, price: 1000.5 }],
    ['ränta över 50', { ...ok, loan_rate: 80 }],
    ['sälj före köp', { ...ok, sell_date: '2026-01' }],
    ['engångs med noll', { type: 'one_off', name: 'x', date: '2026-01', amount: 0 }],
    ['månadspost till före från', { type: 'monthly', name: 'x', from: '2026-05', to: '2026-01', amount: 100 }],
  ]) test(`avvisar: ${label}`, () => assert.ok(validateEvents([ev]).error));
  test('för många händelser och fel typ av lista', () => {
    assert.ok(validateEvents(Array.from({ length: 31 }, () => ok)).error);
    assert.ok(validateEvents('nej').error);
  });
});

import { evaluateGoal } from '../src/goals.js';

describe('mål', () => {
  const today = '2025-01-15';
  test('utan ränta: linjärt sparande', () => {
    const g = evaluateGoal({ target: kr(120000), current: kr(0), monthly: kr(5000), date: '2026-01-01', annualReturn: 0 }, today);
    assert.equal(g.months_left, 12);
    assert.equal(g.projected, kr(60000));
    assert.equal(g.needed_monthly, kr(10000));
    assert.equal(g.status, 'behind');
    assert.equal(g.shortfall, kr(60000));
    assert.equal(g.reached_in_months, 24);
  });

  test('med ränta: handräknat belopp som krävs', () => {
    // 10 000 kr/mån i 12 månader med 12,6825 % (=1 % per månad) och inget startkapital.
    const annual = (1.01 ** 12 - 1) * 100;
    const fv = 10000 * ((1.01 ** 12 - 1) / 0.01);
    const g = evaluateGoal({ target: kr(fv), current: 0, monthly: kr(10000), date: '2026-01-01', annualReturn: annual }, today);
    assert.ok(Math.abs(g.needed_monthly - kr(10000)) <= 2);
    assert.equal(g.status, 'on_track');
  });

  test('redan nått målet', () => {
    const g = evaluateGoal({ target: kr(1000), current: kr(1500), monthly: 0, date: '2026-01-01', annualReturn: 0 }, today);
    assert.equal(g.status, 'reached');
    assert.equal(g.needed_monthly, 0);
    assert.equal(g.progress, 1);
  });

  test('datumet har passerat utan att målet nåtts', () => {
    const g = evaluateGoal({ target: kr(1000), current: kr(100), monthly: kr(10), date: '2024-06-01', annualReturn: 0 }, today);
    assert.equal(g.status, 'overdue');
    assert.equal(g.needed_monthly, kr(900));
  });

  test('inget sparande och ingen ränta nås aldrig', () => {
    const g = evaluateGoal({ target: kr(1000), current: kr(100), monthly: 0, date: '2030-01-01', annualReturn: 0 }, today);
    assert.equal(g.reached_in_months, null);
  });
});
