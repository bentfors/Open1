import { bad, notFound, conflict } from '../http.js';
import { insertRow, updateRow } from '../db.js';
import { importRows, previewRows, normalizeText, ruleMatches } from '../domain.js';
import { parseStatement } from '../statement.js';
import { str, oneOf, id } from '../validate.js';

const IMPORT_LIMIT = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

export function registerTransactions({ db, router }) {
  const ownRow = (table, rowId, userId) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(rowId, userId);
    if (!row) throw notFound();
    return row;
  };

  // ── Kategorier och regler ───────────────────────────────────────────
  router.add('GET', '/api/categories', {}, ({ user }) => ({
    items: db.prepare('SELECT id, name, kind FROM categories WHERE user_id = ? ORDER BY kind, name').all(user.id),
  }));

  router.add('POST', '/api/categories', {}, ({ user, body }) => {
    const name = str(body.name, 'Namn', { max: 60 });
    const kind = oneOf(body.kind, 'Typ', ['income', 'expense', 'transfer']);
    if (db.prepare('SELECT 1 FROM categories WHERE user_id = ? AND name = ?').get(user.id, name)) throw conflict('Kategorin finns redan.');
    return { id: insertRow(db, 'categories', { user_id: user.id, name, kind }) };
  });

  router.add('PATCH', '/api/categories/:id', {}, ({ user, params, body }) => {
    const cat = ownRow('categories', Number(params.id), user.id);
    const d = {};
    if (body.name !== undefined) {
      d.name = str(body.name, 'Namn', { max: 60 });
      if (db.prepare('SELECT 1 FROM categories WHERE user_id = ? AND name = ? AND id <> ?').get(user.id, d.name, cat.id)) throw conflict('Kategorin finns redan.');
    }
    if (body.kind !== undefined) d.kind = oneOf(body.kind, 'Typ', ['income', 'expense', 'transfer']);
    updateRow(db, 'categories', cat.id, d);
  });

  // Transaktioner i kategorin blir okategoriserade och reglerna försvinner.
  router.add('DELETE', '/api/categories/:id', {}, ({ user, params }) => {
    const cat = ownRow('categories', Number(params.id), user.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  });

  router.add('GET', '/api/rules', {}, ({ user }) => ({
    items: db
      .prepare(
        `SELECT r.id, r.pattern, r.category_id, c.name AS category FROM rules r JOIN categories c ON c.id = r.category_id
         WHERE r.user_id = ? ORDER BY c.name, r.pattern`,
      )
      .all(user.id),
  }));

  router.add('POST', '/api/rules', {}, ({ user, body }) => {
    const pattern = str(body.pattern, 'Textmönster', { max: 60 });
    if (normalizeText(pattern).length < 3) throw bad('Mönstret måste vara minst tre tecken, annars matchar det för mycket.');
    const categoryId = id(body.category_id, 'Kategori');
    ownRow('categories', categoryId, user.id);
    const exists = db.prepare('SELECT id FROM rules WHERE user_id = ? AND pattern = ?').get(user.id, pattern);
    if (exists) db.prepare('UPDATE rules SET category_id = ? WHERE id = ?').run(categoryId, exists.id);
    else insertRow(db, 'rules', { user_id: user.id, pattern, category_id: categoryId });
    return { applied: body.apply === false ? 0 : applyRule(user.id, pattern, categoryId) };
  });

  router.add('DELETE', '/api/rules/:id', {}, ({ user, params }) => {
    ownRow('rules', Number(params.id), user.id);
    db.prepare('DELETE FROM rules WHERE id = ?').run(Number(params.id));
  });

  // Sätter kategori på okategoriserade transaktioner som matchar mönstret. Redan kategoriserade rörs aldrig.
  function applyRule(userId, pattern, categoryId) {
    const open = db.prepare('SELECT id, description FROM transactions WHERE user_id = ? AND category_id IS NULL').all(userId);
    const set = db.prepare(`UPDATE transactions SET category_id = ?, auto = 'rule' WHERE id = ?`);
    let n = 0;
    for (const t of open) {
      if (ruleMatches(pattern, t.description)) {
        set.run(categoryId, t.id);
        n++;
      }
    }
    return n;
  }

  // ── Transaktioner ───────────────────────────────────────────────────
  router.add('GET', '/api/transactions', {}, ({ user, query }) => {
    const where = ['t.user_id = ?'];
    const args = [user.id];
    if (query.account_id) (where.push('t.account_id = ?'), args.push(Number(query.account_id)));
    if (query.category_id) (where.push('t.category_id = ?'), args.push(Number(query.category_id)));
    if (query.uncategorized === '1') where.push('t.category_id IS NULL');
    if (query.from) (where.push('t.date >= ?'), args.push(query.from));
    if (query.to) (where.push('t.date <= ?'), args.push(query.to));
    if (query.q) {
      where.push(`t.search LIKE ? ESCAPE '\\'`);
      args.push(`%${normalizeText(query.q).replace(/[%_\\]/g, '\\$&')}%`);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const from = `FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(t.amount), 0) AS sum ${from}`).get(...args);
    const items = db
      .prepare(
        `SELECT t.id, t.date, t.description, t.amount, t.account_id, a.name AS account, t.category_id, c.name AS category, c.kind AS category_kind, t.auto
         ${from} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return { total: total.n, sum: total.sum, items };
  });

  router.add('PATCH', '/api/transactions/:id', {}, ({ user, params, body }) => {
    const t = ownRow('transactions', Number(params.id), user.id);
    const categoryId = id(body.category_id, 'Kategori', { required: false });
    if (categoryId) ownRow('categories', categoryId, user.id);
    db.prepare('UPDATE transactions SET category_id = ?, auto = NULL WHERE id = ?').run(categoryId, t.id);
    return { applied: categoryId && typeof body.rule_pattern === 'string' && body.rule_pattern.trim() ? saveRule(user.id, body.rule_pattern, categoryId, t.description) : 0 };
  });

  function saveRule(userId, rawPattern, categoryId, description) {
    const pattern = str(rawPattern, 'Textmönster', { max: 60 });
    if (normalizeText(pattern).length < 3) throw bad('Mönstret måste vara minst tre tecken.');
    if (!ruleMatches(pattern, description)) throw bad('Mönstret förekommer inte som helt ord i transaktionens text.');
    const exists = db.prepare('SELECT id FROM rules WHERE user_id = ? AND pattern = ?').get(userId, pattern);
    if (exists) db.prepare('UPDATE rules SET category_id = ? WHERE id = ?').run(categoryId, exists.id);
    else insertRow(db, 'rules', { user_id: userId, pattern, category_id: categoryId });
    return applyRule(userId, pattern, categoryId);
  }

  router.add('DELETE', '/api/transactions/:id', {}, ({ user, params }) => {
    ownRow('transactions', Number(params.id), user.id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(Number(params.id));
  });

  // ── Import av inklistrat kontoutdrag ────────────────────────────────
  function parseRequest(user, body) {
    const accountId = id(body.account_id, 'Konto');
    ownRow('accounts', accountId, user.id);
    const text = str(body.text, 'Kontoutdrag', { max: IMPORT_LIMIT });
    const m = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};
    const mapping = {};
    for (const role of ['date', 'description', 'amount', 'balance']) {
      if (m[role] === undefined) continue;
      if (m[role] !== null && (!Number.isInteger(m[role]) || m[role] < 0 || m[role] > 50)) throw bad('Ogiltig kolumnkoppling.');
      mapping[role] = m[role];
    }
    const parsed = parseStatement(text, mapping);
    if (parsed.rows.length > MAX_ROWS) throw bad(`Högst ${MAX_ROWS} rader åt gången. Dela upp utdraget.`);
    return { accountId, parsed };
  }

  router.add('POST', '/api/import/preview', { bodyLimit: IMPORT_LIMIT + 4096 }, ({ user, body }) => {
    const { accountId, parsed } = parseRequest(user, body);
    const rows = previewRows(db, user.id, accountId, parsed.rows);
    return {
      delimiter: parsed.delimiter,
      headers: parsed.headers,
      columns: parsed.columns,
      mapping: parsed.mapping,
      skipped: parsed.skipped.slice(0, 20),
      skipped_count: parsed.skipped.length,
      preview: parsed.preview,
      count: rows.length,
      new_count: rows.filter((r) => !r.duplicate).length,
      rows: rows.slice(0, 200),
      range: rows.length ? { from: rows.reduce((a, r) => (r.date < a ? r.date : a), rows[0].date), to: rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date) } : null,
    };
  });

  // Tolkar texten på nytt på servern. Klienten skickar aldrig färdiga rader.
  router.add('POST', '/api/import/commit', { bodyLimit: IMPORT_LIMIT + 4096 }, ({ user, body }) => {
    const { accountId, parsed } = parseRequest(user, body);
    if (!parsed.rows.length) throw bad('Inga rader kunde tolkas.');
    if (parsed.mapping.date === null || parsed.mapping.amount === null) throw bad('Datum och belopp måste kopplas till varsin kolumn.');
    return { ...importRows(db, user.id, accountId, parsed.rows), skipped: parsed.skipped.length };
  });
}
