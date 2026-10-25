// Gemensam beräkningslogik för prognoser, mål och rapporter. Tar ett scope (vilka konton som syns) och ett
// hushålls-id, så samma kod kan köras för användaren själv och för en rådgivare med giltigt samtycke.
import { accountBalances, today, LIABILITY_KINDS } from './domain.js';
import { valueAll } from './prices.js';
import { lastCompleteMonths, monthRangeOf, monthlyByCategory, firstTransactionMonth } from './budget.js';
import { evaluateGoal } from './goals.js';
import { project, purchaseMonthlyCost } from './scenario.js';
import { monthKey } from './budget.js';

export const INTEREST_CATEGORY = 'Räntekostnader';

export function assumptionsOf(db, householdId) {
  const h = db.prepare('SELECT return_rate, cash_rate, fixed_growth, inflation FROM households WHERE id = ?').get(householdId);
  return { return_rate: h.return_rate, cash_rate: h.cash_rate, fixed_growth: h.fixed_growth, inflation: h.inflation };
}

/** Dagens ekonomi som utgångsläge: kontanter, placeringar, övriga tillgångar och skulder. */
export async function startingPoint(db, prices, sc) {
  const accounts = accountBalances(db, sc, '9999-12-31');
  const holdings = await valueAll(prices, db.prepare(`SELECT h.* FROM holdings h WHERE ${sc.holdings('h')}`).all());
  const start = { cash: 0, invested: 0, fixed: 0, debts: [] };
  const warnings = [];
  for (const a of accounts) {
    if (LIABILITY_KINDS.has(a.kind) || a.balance < 0) {
      if (a.balance < 0) start.debts.push({ name: a.name, balance: -a.balance, rate: LIABILITY_KINDS.has(a.kind) ? a.interest_rate : null, amort: LIABILITY_KINDS.has(a.kind) ? a.monthly_amortization : 0 });
    } else if (['isk', 'depot', 'pension'].includes(a.kind)) start.invested += a.balance;
    else if (a.kind === 'other_asset') start.fixed += a.balance;
    else start.cash += a.balance;
  }
  for (const h of holdings) {
    if (h.value === null) warnings.push(`Innehavet ${h.name} saknar kurs och är inte med.`);
    else start.invested += h.value;
  }
  for (const d of start.debts) if (d.rate === null) warnings.push(`Skulden ${d.name} saknar ränta. Ange den under Konton, annars räknas ingen ränta på den.`);
  return { start, warnings, accounts, holdings };
}

/** Månadsinkomst och månadsutgifter i dagens pengar: budgeten om den finns, annars snittet av senaste månaderna. */
export function baselineFor(db, sc, householdId, debts) {
  // Räntan på lån räknas ut av motorn när alla lån har ränta. Då får den inte också ligga kvar i utgifterna.
  const excludeInterest = debts.length > 0 && debts.every((d) => d.rate !== null && d.rate !== undefined);
  const budget = db.prepare('SELECT c.name, c.kind, b.amount FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.household_id = ?').all(householdId);
  const sumBudget = (kind) => budget.filter((b) => b.kind === kind && !(excludeInterest && b.name === INTEREST_CATEGORY)).reduce((n, b) => n + b.amount, 0);

  const months = lastCompleteMonths(3);
  const first = firstTransactionMonth(db, sc);
  const usable = months.filter((m) => first && m >= first);
  let histIncome = 0;
  let histExpenses = 0;
  if (usable.length) {
    for (const r of monthlyByCategory(db, sc, monthRangeOf(usable[0]).from, monthRangeOf(usable.at(-1)).to)) {
      if (r.kind === 'income') histIncome += r.amount;
      else if (r.kind === 'expense' && !(excludeInterest && r.category === INTEREST_CATEGORY)) histExpenses += -r.amount;
    }
    histIncome = Math.round(histIncome / usable.length);
    histExpenses = Math.round(histExpenses / usable.length);
  }
  const bi = sumBudget('income');
  const be = sumBudget('expense');
  const warnings = [];
  if (!bi && !histIncome) warnings.push('Inkomsten är okänd: importera kontoutdrag med lön eller lägg in en budget. Prognosen räknar med noll inkomst.');
  if (!be && !histExpenses) warnings.push('Utgifterna är okända: importera kontoutdrag eller lägg in en budget.');
  return {
    income: bi || histIncome,
    expenses: be || histExpenses,
    income_source: bi ? 'budget' : usable.length ? 'history' : 'none',
    expenses_source: be ? 'budget' : usable.length ? 'history' : 'none',
    history_months: usable.length,
    excluded_interest: excludeInterest,
    warnings,
  };
}

/** Mål med beräknad status. Sparat = manuellt belopp + saldo och innehav på länkade konton som scopet ser. */
export async function goalItems(db, prices, sc, householdId) {
  const balances = new Map(accountBalances(db, sc, '9999-12-31').map((a) => [a.id, a]));
  const holdings = await valueAll(prices, db.prepare(`SELECT h.* FROM holdings h WHERE ${sc.holdings('h')} AND h.account_id IS NOT NULL`).all());
  const hs = assumptionsOf(db, householdId);
  const now = today();
  const goals = db.prepare('SELECT * FROM goals WHERE household_id = ? ORDER BY target_date, name').all(householdId);
  return goals.map((g) => {
    const linked = db.prepare('SELECT account_id FROM goal_accounts WHERE goal_id = ?').all(g.id).map((r) => r.account_id);
    const visibleLinked = linked.filter((aid) => balances.has(aid));
    const fromAccounts = visibleLinked.reduce((n, aid) => n + Math.max(0, balances.get(aid).balance), 0);
    const fromHoldings = holdings.filter((h) => visibleLinked.includes(h.account_id) && h.value !== null).reduce((n, h) => n + h.value, 0);
    const current = g.manual_amount + fromAccounts + fromHoldings;
    const annualReturn = g.annual_return ?? hs.cash_rate;
    const ev = evaluateGoal({ target: g.target_amount, current, monthly: g.monthly_contribution, date: g.target_date, annualReturn }, now);
    return {
      id: g.id,
      name: g.name,
      target_amount: g.target_amount,
      target_date: g.target_date,
      manual_amount: g.manual_amount,
      monthly_contribution: g.monthly_contribution,
      annual_return: g.annual_return,
      effective_return: annualReturn,
      account_ids: linked,
      hidden_accounts: linked.length - visibleLinked.length,
      current,
      ...ev,
    };
  });
}

export async function goalSummary(db, prices, sc, householdId) {
  const items = await goalItems(db, prices, sc, householdId);
  const open = items.filter((i) => i.status !== 'reached');
  const { start } = await startingPoint(db, prices, sc);
  const baseline = baselineFor(db, sc, householdId, start.debts);
  return {
    items,
    summary: {
      required_monthly: open.reduce((n, i) => n + i.needed_monthly, 0),
      planned_monthly: open.reduce((n, i) => n + i.monthly_contribution, 0),
      surplus: baseline.income - baseline.expenses,
      income_source: baseline.income_source,
      expenses_source: baseline.expenses_source,
    },
  };
}

/** Kör basfallet (inga händelser), scenariot och ett stresstest med två procentenheter högre ränta. */
export async function runPlan(db, prices, sc, householdId, { years, events, overrides = {}, assumptions }) {
  const { start, warnings } = await startingPoint(db, prices, sc);
  const found = baselineFor(db, sc, householdId, start.debts);
  const baseline = { income: overrides.income ?? found.income, expenses: overrides.expenses ?? found.expenses };
  const startMonth = monthKey(new Date());
  const common = { start, baseline, assumptions, startMonth, years };
  const base = project({ ...common, events: [] });
  const scenario = project({ ...common, events });
  const stress = project({ ...common, events, rateShock: 2 });
  const purchases = events.filter((e) => e.type === 'purchase').map((e) => ({ name: e.name, date: e.date, now: purchaseMonthlyCost(e), stressed: purchaseMonthlyCost(e, 2) }));
  return {
    start_month: startMonth,
    years,
    inputs: { start, baseline: { ...found, ...baseline }, assumptions },
    base: { points: base.points.map((p) => ({ month: p.month, net_worth: p.net_worth })), end: base.end },
    scenario,
    stress: { end: stress.end, first_shortfall: stress.first_shortfall, total_interest: stress.total_interest, points: stress.points.map((p) => ({ month: p.month, net_worth: p.net_worth })) },
    purchases,
    delta_end: scenario.end.net_worth - base.end.net_worth,
    warnings: [...warnings, ...found.warnings, ...scenario.warnings],
  };
}
