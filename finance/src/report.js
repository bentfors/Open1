// Månadsrapport: resultat, jämförelse med tidigare månader, budget, balans, mål och observationer.
// Samma funktion används för användaren själv och för en rådgivare (med ett scope som döljer privata konton).
import { incomeStatement } from './routes/reports.js';
import { monthRangeOf, monthlyByCategory, firstTransactionMonth, lastCompleteMonths } from './budget.js';
import { ymAdd } from './scenario.js';
import { startingPoint, goalItems } from './plan.js';
import { normalizeText, today } from './domain.js';
import { buildInsights } from './insights.js';

const STALE_DAYS = 45;

// "ICA MAXI 1234 STOCKHOLM" och "ICA MAXI 5678 STOCKHOLM" ska bli samma nyckel.
export function merchantKey(description) {
  const words = normalizeText(description)
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return words.slice(0, 3).join(' ');
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export const defaultMonth = () => lastCompleteMonths(1)[0];

export async function monthlyReport(db, prices, sc, householdId, month) {
  const { from, to } = monthRangeOf(month);
  const first = firstTransactionMonth(db, sc);
  const cur = incomeStatement(db, sc, from, to);

  const prior = [-3, -2, -1].map((n) => ymAdd(month, n)).filter((m) => first && m >= first);
  const range = monthRangeOf(ymAdd(month, -3));
  const rows = monthlyByCategory(db, sc, range.from, to);

  // ── Jämförelse med föregående månader ───────────────────────────────
  // Samma beräkning som för månaden själv (incomeStatement), så okategoriserat räknas lika på båda sidor.
  const priorTotals = { income: 0, expense: 0 };
  const priorByCat = new Map();
  for (const m of prior) {
    const s = incomeStatement(db, sc, monthRangeOf(m).from, monthRangeOf(m).to);
    priorTotals.income += s.income;
    priorTotals.expense += s.expense;
    for (const l of s.expense_lines) priorByCat.set(l.category, (priorByCat.get(l.category) || 0) + l.amount);
  }
  const n = prior.length;
  const expenseAvg = n ? Math.round(priorTotals.expense / n) : null;
  const incomeAvg = n ? Math.round(priorTotals.income / n) : null;

  const curByCat = new Map(cur.expense_lines.map((l) => [l.category, l.amount]));
  const names = new Set([...curByCat.keys(), ...(n ? priorByCat.keys() : [])]);
  const changes = n
    ? [...names]
        .map((category) => {
          const now = curByCat.get(category) || 0;
          const before = Math.round((priorByCat.get(category) || 0) / n);
          return { category, amount: now, prior_avg: before, delta: now - before, delta_pct: before > 0 ? (now - before) / before : null };
        })
        .filter((c) => c.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 6)
    : [];

  // ── Budget ──────────────────────────────────────────────────────────
  const budgetRows = db.prepare('SELECT c.id AS category_id, c.name AS category, c.kind, b.amount FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.household_id = ?').all(householdId);
  const actualOf = new Map([...cur.income_lines, ...cur.expense_lines].map((l) => [l.category, l.amount]));
  const budgetLines = budgetRows.map((b) => ({ category: b.category, kind: b.kind, budget: b.amount, actual: actualOf.get(b.category) || 0 }));
  const budget = {
    has: budgetRows.length > 0,
    lines: budgetLines,
    total_budget: budgetLines.filter((l) => l.kind === 'expense').reduce((s, l) => s + l.budget, 0),
    total_actual: cur.expense,
  };

  // ── Återkommande poster och nyheter ─────────────────────────────────
  const txs = db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, t.description, t.amount, c.kind AS kind
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.account_id IN (SELECT a.id FROM accounts a WHERE ${sc.acct('a')}) AND t.date BETWEEN ? AND ?`,
    )
    .all(range.from, to);
  const byKey = new Map(); // key → { description, months: Map(month → sum) }
  for (const t of txs) {
    if (t.kind === 'transfer') continue;
    const key = merchantKey(t.description);
    if (!key) continue;
    const e = byKey.get(key) || { description: t.description, months: new Map() };
    e.months.set(t.month, (e.months.get(t.month) || 0) + t.amount);
    byKey.set(key, e);
  }
  const m1 = ymAdd(month, -1);
  const m2 = ymAdd(month, -2);
  const missing = [];
  const newLarge = [];
  for (const [key, e] of byKey) {
    const a1 = e.months.get(m1);
    const a2 = e.months.get(m2);
    if (a1 !== undefined && a2 !== undefined && !e.months.has(month) && prior.includes(m1) && prior.includes(m2)) {
      const same = Math.sign(a1) === Math.sign(a2) && Math.abs(a1 - a2) <= 0.2 * Math.max(Math.abs(a1), Math.abs(a2));
      const avg = Math.round((a1 + a2) / 2);
      if (same && Math.abs(avg) >= 20000) missing.push({ key, description: e.description, amount: avg });
    }
    const now = e.months.get(month);
    if (n && now !== undefined && now <= -50000 && !prior.some((m) => e.months.has(m))) newLarge.push({ key, description: e.description, amount: now });
  }
  missing.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  newLarge.sort((a, b) => a.amount - b.amount);

  // ── Läget idag: balans, konton, mål ────────────────────────────────
  const sp = await startingPoint(db, prices, sc);
  const now = today();
  const accounts = sp.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, last_tx: a.last_tx, stale: !!a.last_tx && daysBetween(a.last_tx, now) > STALE_DAYS }));
  const goals = await goalItems(db, prices, sc, householdId);
  const holdingsPriced = sp.holdings.filter((h) => h.value !== null).map((h) => ({ name: h.name, value: h.value }));
  const debtsTotal = sp.start.debts.reduce((s, d) => s + d.balance, 0);

  const insuranceMonths = [month, m1, m2];
  const hasInsurance = rows.some((r) => r.category === 'Försäkring' && r.kind === 'expense' && r.amount < 0 && insuranceMonths.includes(r.month));
  const txCount = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE t.account_id IN (SELECT a.id FROM accounts a WHERE ${sc.acct('a')}) AND t.date BETWEEN ? AND ?`).get(from, to).n;

  const monthsForBasis = n + 1;
  const expenseBasis = Math.round((priorTotals.expense + cur.expense) / monthsForBasis);
  const incomeBasis = Math.round((priorTotals.income + cur.income) / monthsForBasis);

  const facts = {
    month,
    income: cur.income,
    expense: cur.expense,
    net: cur.net,
    expense_avg3: expenseAvg,
    top_changes: changes,
    budget,
    missing_recurring: missing.slice(0, 5),
    new_large: newLarge.slice(0, 3),
    uncategorized: cur.uncategorized,
    transaction_count: txCount,
    accounts,
    unpriced: sp.holdings.filter((h) => h.value === null).map((h) => ({ name: h.name })),
    debts: sp.start.debts,
    debts_total: debtsTotal,
    cash: sp.start.cash,
    invested: sp.start.invested,
    fixed: sp.start.fixed,
    holdings: holdingsPriced,
    monthly_expense_basis: expenseBasis,
    annual_income: incomeBasis * 12,
    has_income: cur.income > 0 || (incomeAvg ?? 0) > 0,
    has_insurance_expense: hasInsurance,
    goals,
  };

  return {
    month,
    from,
    to,
    months_compared: n,
    result: { income: cur.income, expense: cur.expense, net: cur.net, savings_rate: cur.savings_rate },
    previous: n ? { income_avg: incomeAvg, expense_avg: expenseAvg } : null,
    income_lines: cur.income_lines,
    expense_lines: cur.expense_lines,
    top_changes: changes,
    budget,
    uncategorized: cur.uncategorized,
    balance: {
      cash: sp.start.cash,
      invested: sp.start.invested,
      fixed: sp.start.fixed,
      debts: debtsTotal,
      equity: sp.start.cash + sp.start.invested + sp.start.fixed - debtsTotal,
    },
    goals: goals.map((g) => ({ id: g.id, name: g.name, status: g.status, progress: g.progress, current: g.current, target_amount: g.target_amount, target_date: g.target_date, needed_monthly: g.needed_monthly, monthly_contribution: g.monthly_contribution, shortfall: g.shortfall })),
    insights: buildInsights(facts),
  };
}
