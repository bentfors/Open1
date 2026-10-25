import { bad } from '../http.js';
import { LIABILITY_KINDS, ACCOUNT_KINDS, accountBalances, today } from '../domain.js';
import { valueAll } from '../prices.js';
import { isoDate } from '../validate.js';

const monthOf = (iso) => iso.slice(0, 7);

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) (m = 1), y++;
  }
  return out;
}

/** Resultatet för en period. Överföringar (egna konton, sparande, amortering) ingår inte. */
export function incomeStatement(db, userId, from, to) {
  const rows = db
    .prepare(
      `SELECT t.date, t.amount, t.category_id, c.name AS category, c.kind AS kind
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = ? AND t.date BETWEEN ? AND ?`,
    )
    .all(userId, from, to);

  const lines = new Map();
  const months = new Map(monthsBetween(from, to).map((m) => [m, { month: m, income: 0, expense: 0 }]));
  let income = 0;
  let expense = 0;
  let transfers = { in: 0, out: 0, count: 0 };
  let uncategorized = { count: 0, amount: 0 };

  for (const r of rows) {
    let kind = r.kind;
    let name = r.category;
    if (!kind) {
      // Okategoriserat räknas med så att summan stämmer, men redovisas på egna rader och varnas för.
      kind = r.amount >= 0 ? 'income' : 'expense';
      name = r.amount >= 0 ? 'Okategoriserade inkomster' : 'Okategoriserade utgifter';
      uncategorized.count++;
      uncategorized.amount += r.amount;
    }
    if (kind === 'transfer') {
      if (r.amount >= 0) transfers.in += r.amount;
      else transfers.out += -r.amount;
      transfers.count++;
      continue;
    }
    const key = `${kind}|${name}`;
    const line = lines.get(key) || { kind, category: name, category_id: r.category_id, uncategorized: !r.kind, amount: 0, count: 0 };
    line.amount += r.amount;
    line.count++;
    lines.set(key, line);
    const bucket = months.get(monthOf(r.date));
    if (kind === 'income') {
      income += r.amount;
      bucket.income += r.amount;
    } else {
      expense += -r.amount; // utgifter som positivt belopp; återbetalningar minskar dem
      bucket.expense += -r.amount;
    }
  }

  const all = [...lines.values()];
  const byKind = (k) => all.filter((l) => l.kind === k).map((l) => ({ ...l, amount: k === 'expense' ? -l.amount : l.amount })).sort((a, b) => b.amount - a.amount);
  const net = income - expense;
  return {
    from,
    to,
    income,
    expense,
    net,
    savings_rate: income > 0 ? net / income : null,
    income_lines: byKind('income'),
    expense_lines: byKind('expense'),
    months: [...months.values()].map((m) => ({ ...m, net: m.income - m.expense })),
    transfers,
    uncategorized,
  };
}

export function registerReports({ db, router, prices }) {
  router.add('GET', '/api/reports/income', {}, ({ user, query }) => {
    const from = isoDate(query.from, 'Från');
    const to = isoDate(query.to, 'Till');
    if (from > to) throw bad('Från-datumet ligger efter till-datumet.');
    if (monthsBetween(from, to).length > 60) throw bad('Välj högst fem år åt gången.');
    return incomeStatement(db, user.id, from, to);
  });

  // Balansräkning per idag: kontosaldon (transaktioner till och med idag) och innehav till aktuell kurs.
  router.add('GET', '/api/reports/balance', {}, async ({ user, query }) => {
    const date = today();
    const accounts = accountBalances(db, user.id, date);
    const holdings = await valueAll(prices, db.prepare('SELECT * FROM holdings WHERE user_id = ? ORDER BY name').all(user.id), { force: query.refresh === '1' });

    const assets = [];
    const liabilities = [];
    for (const a of accounts) {
      const line = { type: 'account', id: a.id, name: a.name, kind: a.kind, kind_label: ACCOUNT_KINDS[a.kind] };
      if (LIABILITY_KINDS.has(a.kind) || a.balance < 0) liabilities.push({ ...line, amount: -a.balance });
      else assets.push({ ...line, amount: a.balance });
    }
    const unpriced = [];
    for (const h of holdings) {
      if (h.value === null) {
        unpriced.push({ id: h.id, name: h.name, reason: h.reason });
        continue;
      }
      assets.push({ type: 'holding', id: h.id, name: h.name, kind: 'holding', kind_label: 'Värdepapper', amount: h.value, stale: !!h.stale, as_of: h.as_of });
    }
    const sum = (list) => list.reduce((n, l) => n + l.amount, 0);
    const totalAssets = sum(assets);
    const totalLiabilities = sum(liabilities);

    // En ögonblicksbild per dag ger utvecklingen över tid. Får bara skrivas med fullständig värdering,
    // annars ser ett innehav utan kurs ut som en förlust.
    if (!unpriced.length) {
      db.prepare(
        `INSERT INTO net_worth_snapshots (user_id, date, assets, liabilities) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, date) DO UPDATE SET assets = excluded.assets, liabilities = excluded.liabilities`,
      ).run(user.id, date, totalAssets, totalLiabilities);
    }
    const history = db.prepare('SELECT date, assets, liabilities FROM net_worth_snapshots WHERE user_id = ? ORDER BY date').all(user.id);

    return {
      date,
      assets,
      liabilities,
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      equity: totalAssets - totalLiabilities,
      unpriced,
      history,
    };
  });
}
