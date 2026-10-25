import { bad, notFound } from '../http.js';
import { insertRow, updateRow, tx } from '../db.js';
import { accountBalances, today, LIABILITY_KINDS } from '../domain.js';
import { valueAll } from '../prices.js';
import { scopeOf } from '../scope.js';
import { lastCompleteMonths, monthRangeOf, monthKey, monthlyByCategory, firstTransactionMonth } from '../budget.js';
import { project, validateEvents, purchaseMonthlyCost } from '../scenario.js';
import { evaluateGoal } from '../goals.js';
import { str, ore, num, isoDate, id } from '../validate.js';

const INTEREST_CATEGORY = 'Räntekostnader';

export function registerPlan({ db, router, prices }) {
  const assumptionsOf = (householdId) => {
    const h = db.prepare('SELECT return_rate, cash_rate, fixed_growth, inflation FROM households WHERE id = ?').get(householdId);
    return { return_rate: h.return_rate, cash_rate: h.cash_rate, fixed_growth: h.fixed_growth, inflation: h.inflation };
  };

  /** Dagens ekonomi som utgångsläge: kontanter, placeringar, övriga tillgångar och skulder. */
  async function startingPoint(sc) {
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
    return { start, warnings };
  }

  /** Månadsinkomst och månadsutgifter i dagens pengar: budgeten om den finns, annars snittet av senaste månaderna. */
  function baselineFor(sc, householdId, debts) {
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

  router.add('GET', '/api/plan/start', {}, async ({ user, query }) => {
    const sc = scopeOf(user, query.scope);
    const { start, warnings } = await startingPoint(sc);
    const baseline = baselineFor(sc, user.household_id, start.debts);
    return { start, baseline, assumptions: assumptionsOf(user.household_id), warnings: [...warnings, ...baseline.warnings] };
  });

  function parseRun(body, user) {
    const years = body.years === undefined ? 20 : body.years;
    if (!Number.isInteger(years) || years < 1 || years > 40) throw bad('Tidshorisonten måste vara 1–40 år.');
    const { events, error } = validateEvents(body.events ?? []);
    if (error) throw bad(error);
    const o = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const overrides = {};
    if (o.income !== undefined && o.income !== null) overrides.income = ore(o.income, 'Inkomst');
    if (o.expenses !== undefined && o.expenses !== null) overrides.expenses = ore(o.expenses, 'Utgifter');
    const assumptions = assumptionsOf(user.household_id);
    for (const key of Object.keys(assumptions)) if (o[key] !== undefined && o[key] !== null) assumptions[key] = num(o[key], key, { min: -20, max: 30 });
    return { years, events, overrides, assumptions };
  }

  // Kör basfallet (inga händelser) och scenariot, plus ett stresstest med två procentenheter högre ränta.
  router.add('POST', '/api/plan/run', {}, async ({ user, body, query }) => {
    const sc = scopeOf(user, query.scope);
    const { years, events, overrides, assumptions } = parseRun(body, user);
    const { start, warnings } = await startingPoint(sc);
    const found = baselineFor(sc, user.household_id, start.debts);
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
  });

  // ── Sparade scenarier ───────────────────────────────────────────────
  const scenarioRow = (r) => ({ id: r.id, name: r.name, horizon_years: r.horizon_years, events: JSON.parse(r.events) });
  const ownScenario = (rowId, user) => {
    const r = db.prepare('SELECT * FROM scenarios WHERE id = ? AND household_id = ?').get(rowId, user.household_id);
    if (!r) throw notFound();
    return r;
  };

  router.add('GET', '/api/scenarios', {}, ({ user }) => ({ items: db.prepare('SELECT * FROM scenarios WHERE household_id = ? ORDER BY name').all(user.household_id).map(scenarioRow) }));

  function scenarioFields(body) {
    const { events, error } = validateEvents(body.events ?? []);
    if (error) throw bad(error);
    const years = body.horizon_years ?? 20;
    if (!Number.isInteger(years) || years < 1 || years > 40) throw bad('Tidshorisonten måste vara 1–40 år.');
    return { name: str(body.name, 'Namn', { max: 80 }), horizon_years: years, events: JSON.stringify(events) };
  }

  router.add('POST', '/api/scenarios', {}, ({ user, body }) => ({ id: insertRow(db, 'scenarios', { household_id: user.household_id, ...scenarioFields(body) }) }));
  router.add('PUT', '/api/scenarios/:id', {}, ({ user, params, body }) => {
    const r = ownScenario(Number(params.id), user);
    updateRow(db, 'scenarios', r.id, scenarioFields(body));
  });
  router.add('DELETE', '/api/scenarios/:id', {}, ({ user, params }) => {
    const r = ownScenario(Number(params.id), user);
    db.prepare('DELETE FROM scenarios WHERE id = ?').run(r.id);
  });

  // ── Mål ─────────────────────────────────────────────────────────────
  function goalFields(body, user) {
    const d = {
      name: str(body.name, 'Namn', { max: 80 }),
      target_amount: ore(body.target_amount, 'Målbelopp'),
      target_date: isoDate(body.target_date, 'Måldatum'),
      manual_amount: ore(body.manual_amount ?? 0, 'Redan sparat'),
      monthly_contribution: ore(body.monthly_contribution ?? 0, 'Sparande per månad'),
      annual_return: num(body.annual_return, 'Avkastning', { min: -20, max: 30, required: false }),
    };
    if (d.target_amount <= 0) throw bad('Målbeloppet måste vara större än noll.');
    if (d.monthly_contribution < 0) throw bad('Sparandet kan inte vara negativt.');
    const accountIds = body.account_ids ?? [];
    if (!Array.isArray(accountIds) || accountIds.length > 50) throw bad('Kontolistan har fel format.');
    const sc = scopeOf(user);
    for (const aid of accountIds) {
      id(aid, 'Konto');
      if (!db.prepare(`SELECT 1 FROM accounts a WHERE a.id = ? AND ${sc.acct('a')}`).get(aid)) throw bad('Okänt konto bland de länkade.');
    }
    return { d, accountIds };
  }

  const ownGoal = (rowId, user) => {
    const r = db.prepare('SELECT * FROM goals WHERE id = ? AND household_id = ?').get(rowId, user.household_id);
    if (!r) throw notFound();
    return r;
  };

  function saveLinks(goalId, accountIds) {
    db.prepare('DELETE FROM goal_accounts WHERE goal_id = ?').run(goalId);
    for (const aid of new Set(accountIds)) db.prepare('INSERT INTO goal_accounts (goal_id, account_id) VALUES (?, ?)').run(goalId, aid);
  }

  router.add('POST', '/api/goals', {}, ({ user, body }) => {
    const { d, accountIds } = goalFields(body, user);
    return tx(db, () => {
      const goalId = insertRow(db, 'goals', { household_id: user.household_id, ...d });
      saveLinks(goalId, accountIds);
      return { id: goalId };
    });
  });

  router.add('PUT', '/api/goals/:id', {}, ({ user, params, body }) => {
    const g = ownGoal(Number(params.id), user);
    const { d, accountIds } = goalFields(body, user);
    tx(db, () => {
      updateRow(db, 'goals', g.id, d);
      saveLinks(g.id, accountIds);
    });
  });

  router.add('DELETE', '/api/goals/:id', {}, ({ user, params }) => {
    const g = ownGoal(Number(params.id), user);
    db.prepare('DELETE FROM goals WHERE id = ?').run(g.id);
  });

  // Mål med beräknad status. Sparat = manuellt belopp + saldo och innehav på länkade konton som du ser.
  router.add('GET', '/api/goals', {}, async ({ user, query }) => {
    const sc = scopeOf(user, query.scope);
    const balances = new Map(accountBalances(db, sc, '9999-12-31').map((a) => [a.id, a]));
    const holdings = await valueAll(prices, db.prepare(`SELECT h.* FROM holdings h WHERE ${sc.holdings('h')} AND h.account_id IS NOT NULL`).all());
    const hs = assumptionsOf(user.household_id);
    const now = today();

    const goals = db.prepare('SELECT * FROM goals WHERE household_id = ? ORDER BY target_date, name').all(user.household_id);
    const items = goals.map((g) => {
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

    const open = items.filter((i) => i.status !== 'reached');
    const requiredTotal = open.reduce((n, i) => n + i.needed_monthly, 0);
    const plannedTotal = open.reduce((n, i) => n + i.monthly_contribution, 0);
    const { start } = await startingPoint(sc);
    const baseline = baselineFor(sc, user.household_id, start.debts);
    const surplus = baseline.income - baseline.expenses;
    return { items, summary: { required_monthly: requiredTotal, planned_monthly: plannedTotal, surplus, income_source: baseline.income_source, expenses_source: baseline.expenses_source } };
  });
}
