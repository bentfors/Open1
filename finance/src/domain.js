import { createHash } from 'node:crypto';
import { insertRow, tx } from './db.js';

export const ACCOUNT_KINDS = {
  checking: 'Lönekonto',
  savings: 'Sparkonto',
  isk: 'ISK',
  depot: 'Depå / KF',
  pension: 'Pension',
  other_asset: 'Annan tillgång',
  loan: 'Lån',
  credit: 'Kreditkort',
};
export const LIABILITY_KINDS = new Set(['loan', 'credit']);

const DEFAULT_CATEGORIES = [
  ['Lön', 'income'],
  ['Bidrag och pension', 'income'],
  ['Ränta och utdelning', 'income'],
  ['Övriga inkomster', 'income'],
  ['Boende', 'expense'],
  ['Mat och dryck', 'expense'],
  ['Transport', 'expense'],
  ['Försäkring', 'expense'],
  ['Abonnemang och nöje', 'expense'],
  ['Hälsa', 'expense'],
  ['Kläder och shopping', 'expense'],
  ['Resor', 'expense'],
  ['Räntekostnader', 'expense'],
  ['Skatt', 'expense'],
  ['Övriga utgifter', 'expense'],
  ['Överföring', 'transfer'],
  ['Sparande och investeringar', 'transfer'],
  ['Amortering', 'transfer'],
];

// Startregler. Medvetet försiktiga: hellre okategoriserat än fel. Användaren bygger vidare själv.
const DEFAULT_RULES = [
  ['ICA', 'Mat och dryck'], ['COOP', 'Mat och dryck'], ['WILLYS', 'Mat och dryck'], ['HEMKÖP', 'Mat och dryck'],
  ['LIDL', 'Mat och dryck'], ['MAXI', 'Mat och dryck'], ['SYSTEMBOLAGET', 'Mat och dryck'],
  ['SL ', 'Transport'], ['SJ AB', 'Transport'], ['UBER', 'Transport'], ['CIRCLE K', 'Transport'], ['OKQ8', 'Transport'],
  ['PREEM', 'Transport'], ['PARKERING', 'Transport'],
  ['SPOTIFY', 'Abonnemang och nöje'], ['NETFLIX', 'Abonnemang och nöje'], ['HBO', 'Abonnemang och nöje'],
  ['VIAPLAY', 'Abonnemang och nöje'], ['DISNEY', 'Abonnemang och nöje'],
  ['APOTEK', 'Hälsa'], ['FÖRSÄKRING', 'Försäkring'], ['FOLKSAM', 'Försäkring'], ['IF SKADE', 'Försäkring'],
  ['HYRA', 'Boende'], ['BOSTAD', 'Boende'], ['VATTENFALL', 'Boende'], ['TELIA', 'Boende'],
  ['LÖN', 'Lön'], ['SALARY', 'Lön'], ['PENSIONSMYNDIGHETEN', 'Bidrag och pension'], ['FÖRSÄKRINGSKASSAN', 'Bidrag och pension'],
  ['UTDELNING', 'Ränta och utdelning'], ['AMORTERING', 'Amortering'],
  ['AVANZA', 'Sparande och investeringar'], ['NORDNET', 'Sparande och investeringar'],
  ['SKATTEVERKET', 'Skatt'],
];

// Kategorier och regler tillhör hushållet. user_id är den som skapade dem.
export function seedHousehold(db, userId, householdId) {
  const ids = new Map();
  for (const [name, kind] of DEFAULT_CATEGORIES) ids.set(name, insertRow(db, 'categories', { user_id: userId, household_id: householdId, name, kind }));
  for (const [pattern, cat] of DEFAULT_RULES) insertRow(db, 'rules', { user_id: userId, household_id: householdId, pattern, category_id: ids.get(cat) });
}

export const normalizeText = (s) => String(s).toUpperCase().replace(/\s+/g, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Mönstret måste stå som helt ord i texten: "ICA" matchar "ICA MAXI" men inte "MEDICAL", "LÖN" inte "LÖNEKONTO".
export function ruleMatches(pattern, description) {
  const p = normalizeText(pattern);
  if (!p) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'u').test(normalizeText(description));
}

// Längsta mönstret som matchar vinner, så "ICA MAXI" slår "ICA".
export function matchRule(rules, description) {
  let best = null;
  for (const r of rules) {
    if (ruleMatches(r.pattern, description) && (!best || normalizeText(r.pattern).length > normalizeText(best.pattern).length)) best = r;
  }
  return best;
}

export const householdRules = (db, householdId) => db.prepare('SELECT id, pattern, category_id FROM rules WHERE household_id = ?').all(householdId);

function fingerprints(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const key = `${r.date}|${r.amount}|${normalizeText(r.description)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return createHash('sha1').update(`${key}#${n}`).digest('hex');
  });
}

/** Läser in rader på ett konto. Redan importerade rader hoppas över. Returnerar antal nya och dubbletter. */
export function importRows(db, sc, accountId, rows) {
  const rules = householdRules(db, sc.householdId);
  const fps = fingerprints(rows);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transactions (user_id, account_id, date, description, search, amount, balance, category_id, auto, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const owner = db.prepare('SELECT user_id FROM accounts WHERE id = ?').get(accountId).user_id;
  return tx(db, () => {
    let added = 0;
    const newIds = [];
    rows.forEach((r, i) => {
      const rule = matchRule(rules, r.description);
      const res = insert.run(owner, accountId, r.date, r.description, normalizeText(r.description), r.amount, r.balance, rule?.category_id ?? null, rule ? 'rule' : null, fps[i]);
      if (res.changes) {
        added++;
        newIds.push(Number(res.lastInsertRowid));
      }
    });
    const paired = markTransfers(db, sc, newIds);
    return { added, duplicates: rows.length - added, transfers: paired };
  });
}

/** Förhandsvisning: vilka rader är nya, och vilken kategori skulle de få? */
export function previewRows(db, sc, accountId, rows) {
  const rules = householdRules(db, sc.householdId);
  const fps = fingerprints(rows);
  const exists = db.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND fingerprint = ?');
  const cats = new Map(db.prepare('SELECT id, name FROM categories WHERE household_id = ?').all(sc.householdId).map((c) => [c.id, c.name]));
  return rows.map((r, i) => {
    const rule = matchRule(rules, r.description);
    return { ...r, duplicate: !!exists.get(accountId, fps[i]), category: rule ? cats.get(rule.category_id) : null };
  });
}

/**
 * Egna överföringar syns som +X på ett konto och −X på ett annat inom några dagar. Räknas de som inkomst och
 * utgift blåses resultatet upp, så okategoriserade par kategoriseras som Överföring. Gissning, därför auto='transfer'.
 */
export function markTransfers(db, sc, ids) {
  if (!ids.length) return 0;
  const cat = db.prepare(`SELECT id FROM categories WHERE household_id = ? AND name = 'Överföring' AND kind = 'transfer'`).get(sc.householdId);
  if (!cat) return 0;
  const get = db.prepare('SELECT id, account_id, date, amount, category_id FROM transactions WHERE id = ?');
  const find = db.prepare(
    `SELECT id FROM transactions
     WHERE account_id <> ? AND account_id IN (SELECT a.id FROM accounts a WHERE ${sc.write.acct('a')}) AND amount = ? AND category_id IS NULL
       AND date BETWEEN date(?, '-3 days') AND date(?, '+3 days')
     ORDER BY abs(julianday(date) - julianday(?)), id LIMIT 1`,
  );
  const set = db.prepare(`UPDATE transactions SET category_id = ?, auto = 'transfer' WHERE id = ?`);
  let pairs = 0;
  for (const id of ids) {
    const t = get.get(id);
    if (!t || t.category_id !== null) continue;
    const other = find.get(t.account_id, -t.amount, t.date, t.date, t.date);
    if (!other) continue;
    set.run(cat.id, id);
    set.run(cat.id, other.id);
    pairs++;
  }
  return pairs;
}

export function accountBalances(db, sc, asOf) {
  return db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.opening_balance, a.shared, a.user_id, a.interest_rate, a.monthly_amortization, (SELECT u.name FROM users u WHERE u.id = a.user_id) AS owner,
              a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id AND t.date <= ?), 0) AS balance,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count,
              (SELECT MAX(date) FROM transactions t WHERE t.account_id = a.id) AS last_tx
       FROM accounts a WHERE ${sc.acct('a')} ORDER BY a.kind, a.name`,
    )
    .all(asOf);
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
