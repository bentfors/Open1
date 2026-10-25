import { bad } from '../http.js';
import { tx } from '../db.js';
import { scopeOf } from '../scope.js';
import { suggestBudget, lastCompleteMonths, monthRangeOf, monthKey, monthlyByCategory as monthly, firstTransactionMonth } from '../budget.js';
import { ore } from '../validate.js';

export function registerBudget({ db, router }) {
  const lines = (householdId) =>
    db
      .prepare('SELECT b.category_id, c.name AS category, c.kind, b.amount FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.household_id = ? ORDER BY c.kind DESC, b.amount DESC')
      .all(householdId);

  const totals = (items) => ({
    income: items.filter((l) => l.kind === 'income').reduce((n, l) => n + l.amount, 0),
    expense: items.filter((l) => l.kind === 'expense').reduce((n, l) => n + l.amount, 0),
  });

  router.add('GET', '/api/budget', {}, ({ user }) => {
    const items = lines(user.household_id);
    const t = totals(items);
    return { items, ...t, surplus: t.income - t.expense };
  });

  // Förslag från de senaste avslutade månaderna. Sparas inte förrän användaren bekräftar med PUT.
  router.add('GET', '/api/budget/suggest', {}, ({ user, query }) => {
    const n = Math.min(Math.max(Number(query.months) || 3, 1), 12);
    const months = lastCompleteMonths(n);
    const sc = scopeOf(user, query.scope);
    const first = firstTransactionMonth(db, sc);
    const result = suggestBudget(monthly(db, sc, monthRangeOf(months[0]).from, monthRangeOf(months.at(-1)).to), months, first);
    const t = totals(result.lines);
    return { ...result, ...t, surplus: t.income - t.expense, requested_months: n };
  });

  router.add('PUT', '/api/budget', {}, ({ user, body }) => {
    if (!Array.isArray(body.lines) || body.lines.length > 200) throw bad('Budgeten har fel format.');
    const cats = new Map(db.prepare('SELECT id, kind FROM categories WHERE household_id = ?').all(user.household_id).map((c) => [c.id, c.kind]));
    const seen = new Set();
    for (const l of body.lines) {
      if (!cats.has(l?.category_id)) throw bad('Okänd kategori i budgeten.');
      if (cats.get(l.category_id) === 'transfer') throw bad('Överföringar kan inte budgeteras.');
      if (seen.has(l.category_id)) throw bad('Samma kategori förekommer två gånger.');
      seen.add(l.category_id);
      ore(l.amount, 'Belopp');
      if (l.amount < 0) throw bad('Belopp får inte vara negativa.');
    }
    tx(db, () => {
      db.prepare('DELETE FROM budgets WHERE household_id = ?').run(user.household_id);
      const ins = db.prepare('INSERT INTO budgets (household_id, category_id, amount) VALUES (?, ?, ?)');
      for (const l of body.lines) if (l.amount > 0) ins.run(user.household_id, l.category_id, l.amount);
    });
    const items = lines(user.household_id);
    const t = totals(items);
    return { items, ...t, surplus: t.income - t.expense };
  });

  // Budget mot utfall för en månad. Kategorier med utfall men utan budget visas också, så inget göms.
  router.add('GET', '/api/budget/status', {}, ({ user, query }) => {
    const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : monthKey(new Date());
    const { from, to } = monthRangeOf(month);
    const sc = scopeOf(user, query.scope);
    const actual = new Map();
    for (const r of monthly(db, sc, from, to)) if (r.kind !== 'transfer') actual.set(r.category_id, { ...r, amount: r.kind === 'expense' ? -r.amount : r.amount });
    const rows = new Map();
    for (const l of lines(user.household_id)) rows.set(l.category_id, { category_id: l.category_id, category: l.category, kind: l.kind, budget: l.amount, actual: actual.get(l.category_id)?.amount ?? 0 });
    for (const a of actual.values()) if (!rows.has(a.category_id)) rows.set(a.category_id, { category_id: a.category_id, category: a.category, kind: a.kind, budget: 0, actual: a.amount });
    const items = [...rows.values()].map((r) => ({ ...r, diff: r.kind === 'expense' ? r.budget - r.actual : r.actual - r.budget })).sort((a, b) => (a.kind === b.kind ? b.budget + b.actual - (a.budget + a.actual) : a.kind === 'income' ? -1 : 1));
    const sum = (kind, key) => items.filter((r) => r.kind === kind).reduce((n, r) => n + r[key], 0);
    const now = new Date();
    const current = monthKey(now) === month;
    const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
    return {
      month,
      elapsed: current ? now.getDate() / days : month < monthKey(now) ? 1 : 0,
      items,
      budget: { income: sum('income', 'budget'), expense: sum('expense', 'budget') },
      actual: { income: sum('income', 'actual'), expense: sum('expense', 'actual') },
      has_budget: items.some((r) => r.budget > 0),
    };
  });
}
