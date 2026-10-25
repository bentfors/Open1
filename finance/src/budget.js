// Budgetförslag och uppföljning. Alla belopp i öre. Överföringar ingår aldrig.

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export function monthRangeOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}

// De N senaste avslutade kalendermånaderna, äldst först.
export function lastCompleteMonths(n, now = new Date()) {
  const out = [];
  for (let i = n; i >= 1; i--) out.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const roundUp100kr = (ore) => Math.ceil(ore / 10000) * 10000;

/**
 * Förslag per kategori utifrån faktiskt utfall. Med tre månader eller fler används medianen (en engångskostnad
 * som en resa slår inte igenom), annars medelvärdet. Månader före första transaktionen räknas inte.
 * Utgifter avrundas uppåt till närmaste hundralapp, så förslaget hellre blir något för rymligt än för snävt.
 * @param rows  [{ month, category_id, category, kind, amount }] summerat per månad och kategori, tecken som i kontot
 * @param months månadsfönstret, äldst först
 * @param firstMonth månaden för första transaktionen, eller null
 */
export function suggestBudget(rows, months, firstMonth) {
  const usable = months.filter((m) => firstMonth && m >= firstMonth);
  if (!usable.length) return { months: [], lines: [] };
  const byCat = new Map();
  for (const r of rows) {
    if (!usable.includes(r.month) || r.kind === 'transfer') continue;
    const c = byCat.get(r.category_id) || { category_id: r.category_id, category: r.category, kind: r.kind, perMonth: new Map() };
    c.perMonth.set(r.month, (c.perMonth.get(r.month) || 0) + (r.kind === 'expense' ? -r.amount : r.amount));
    byCat.set(r.category_id, c);
  }
  const lines = [];
  for (const c of byCat.values()) {
    const series = usable.map((m) => Math.max(0, c.perMonth.get(m) || 0));
    const average = Math.round(series.reduce((a, b) => a + b, 0) / series.length);
    const basis = usable.length >= 3 ? median(series) : average;
    if (basis <= 0) continue;
    lines.push({ category_id: c.category_id, category: c.category, kind: c.kind, amount: c.kind === 'expense' ? roundUp100kr(basis) : Math.round(basis / 100) * 100, average, months: usable.length });
  }
  lines.sort((a, b) => (a.kind === b.kind ? b.amount - a.amount : a.kind === 'income' ? -1 : 1));
  return { months: usable, method: usable.length >= 3 ? 'median' : 'average', lines };
}

// Summerat utfall per månad och kategori för de konton scopet ser. Okategoriserat och överföringar ingår inte.
export function monthlyByCategory(db, sc, from, to) {
  return db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS month, c.id AS category_id, c.name AS category, c.kind AS kind, SUM(t.amount) AS amount
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.account_id IN (SELECT a.id FROM accounts a WHERE ${sc.acct('a')}) AND t.date BETWEEN ? AND ?
       GROUP BY month, c.id`,
    )
    .all(from, to);
}

export function firstTransactionMonth(db, sc) {
  return db.prepare(`SELECT substr(MIN(t.date), 1, 7) AS m FROM transactions t WHERE t.account_id IN (SELECT a.id FROM accounts a WHERE ${sc.acct('a')})`).get().m;
}
