import { bad, notFound, forbidden, HttpError } from '../http.js';
import { insertRow, tx } from '../db.js';
import { config } from '../config.js';
import { members } from '../household.js';
import { advisorScope, scopeOf } from '../scope.js';
import { approvalsFor, grantState, activeGrant, logAccess, hashCode, newCode } from '../advisor.js';
import { incomeStatement, balanceSheet } from './reports.js';
import { monthlyReport, defaultMonth } from '../report.js';
import { goalSummary, runPlan, assumptionsOf } from '../plan.js';
import { monthRangeOf } from '../budget.js';
import { ymAdd } from '../scenario.js';
import { normalizeText } from '../domain.js';
import { str } from '../validate.js';

const CODE_DAYS = 7;
const monthParam = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(v || '') ? v : defaultMonth());

function requireEnabled() {
  if (!config.advisorEnabled) throw new HttpError(404, 'Rådgivarfunktionen är avstängd.');
}

const stripLinks = (g) => ({ ...g, items: g.items.map(({ account_ids, hidden_accounts, ...rest }) => rest) });

// ── Månadsrapport för användaren själv ────────────────────────────────
export function registerMonthly({ db, router, prices }) {
  router.add('GET', '/api/report/monthly', {}, ({ user, query }) => monthlyReport(db, prices, scopeOf(user, query.scope), user.household_id, monthParam(query.month)));
}

export function registerAdvisor({ db, router, prices }) {
  const nameOf = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name ?? null;

  // ── Kundens sida: ge, godkänna och återkalla samtycke ──────────────
  router.add('GET', '/api/advisors', {}, ({ user }) => {
    const grants = db.prepare('SELECT * FROM advisor_grants WHERE household_id = ? ORDER BY id DESC').all(user.household_id);
    const items = grants.map((g) => {
      const approvals = approvalsFor(db, g);
      return {
        id: g.id,
        level: g.level,
        state: grantState(db, g),
        advisor: g.advisor_id ? nameOf(g.advisor_id) : null,
        created_at: g.created_at,
        accepted_at: g.accepted_at,
        expires_at: g.expires_at,
        revoked_at: g.revoked_at,
        approvals,
        i_approved: approvals.approved.some((m) => m.id === user.id),
      };
    });
    const log = db
      .prepare(
        `SELECT l.id, l.at, l.action, l.grant_id, u.name AS advisor FROM advisor_access_log l JOIN users u ON u.id = l.advisor_id
         WHERE l.household_id = ? ORDER BY l.id DESC LIMIT 100`,
      )
      .all(user.household_id);
    return { enabled: config.advisorEnabled, items, log };
  });

  router.add('POST', '/api/advisors', {}, ({ user, body }) => {
    requireEnabled();
    const level = body.level === 'detail' ? 'detail' : body.level === 'summary' ? 'summary' : null;
    if (!level) throw bad('Välj nivå: sammanfattning eller detaljer.');
    const months = body.months === undefined ? 12 : body.months;
    if (!Number.isInteger(months) || months < 1 || months > 24) throw bad('Samtycket kan gälla 1–24 månader.');
    const code = newCode();
    return tx(db, () => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO advisor_grants (household_id, created_by, code_hash, code_expires_at, level, expires_at)
             VALUES (?, ?, ?, datetime('now', ?), ?, datetime('now', ?))`,
          )
          .run(user.household_id, user.id, hashCode(code), `+${CODE_DAYS} days`, level, `+${months} months`).lastInsertRowid,
      );
      db.prepare('INSERT INTO advisor_approvals (grant_id, user_id) VALUES (?, ?)').run(id, user.id);
      return { id, code, code_days: CODE_DAYS };
    });
  });

  const ownGrant = (id, user) => {
    const g = db.prepare('SELECT * FROM advisor_grants WHERE id = ? AND household_id = ?').get(id, user.household_id);
    if (!g) throw notFound();
    return g;
  };

  router.add('POST', '/api/advisors/:id/approve', {}, ({ user, params }) => {
    const g = ownGrant(Number(params.id), user);
    if (g.revoked_at) throw bad('Samtycket är återkallat.');
    db.prepare('INSERT OR IGNORE INTO advisor_approvals (grant_id, user_id) VALUES (?, ?)').run(g.id, user.id);
    return { state: grantState(db, g) };
  });

  // Vem som helst i hushållet kan återkalla. Återkallat samtycke kan inte återupplivas, ge ett nytt.
  router.add('POST', '/api/advisors/:id/revoke', {}, ({ user, params }) => {
    const g = ownGrant(Number(params.id), user);
    if (!g.revoked_at) db.prepare(`UPDATE advisor_grants SET revoked_at = datetime('now') WHERE id = ?`).run(g.id);
    return { state: 'revoked' };
  });

  // ── Rådgivarens sida ───────────────────────────────────────────────
  router.add('POST', '/api/advisor/redeem', {}, ({ user, body }) => {
    requireEnabled();
    const code = str(body.code, 'Kod', { max: 100 });
    const g = db.prepare('SELECT * FROM advisor_grants WHERE code_hash = ?').get(hashCode(code));
    const fail = () => bad('Koden är ogiltig eller har gått ut.');
    if (!g || g.accepted_at || g.revoked_at || grantState(db, g) !== 'invitation') throw fail();
    if (members(db, g.household_id).some((m) => m.id === user.id)) throw bad('Du kan inte vara rådgivare åt ditt eget hushåll.');
    db.prepare(`UPDATE advisor_grants SET advisor_id = ?, accepted_at = datetime('now') WHERE id = ?`).run(user.id, g.id);
    return { id: g.id, state: grantState(db, db.prepare('SELECT * FROM advisor_grants WHERE id = ?').get(g.id)) };
  });

  router.add('GET', '/api/advisor/clients', {}, ({ user }) => {
    requireEnabled();
    const rows = db.prepare('SELECT * FROM advisor_grants WHERE advisor_id = ? AND revoked_at IS NULL ORDER BY id DESC').all(user.id);
    return {
      items: rows.map((g) => ({
        grant_id: g.id,
        state: grantState(db, g),
        level: g.level,
        since: g.accepted_at,
        expires_at: g.expires_at,
        members: grantState(db, g) === 'active' ? members(db, g.household_id).map((m) => m.name) : [],
      })),
    };
  });

  // Alla dataanrop går genom den här: samtycket måste vara aktivt, och anropet loggas så att kunden ser det.
  function client(user, params, action, { needLevel } = {}) {
    requireEnabled();
    const g = activeGrant(db, user.id, Number(params.id));
    if (!g) throw notFound('Samtycket finns inte eller är inte aktivt.');
    if (needLevel === 'detail' && g.level !== 'detail') throw forbidden('Kunden har inte gett tillgång till enskilda transaktioner.');
    logAccess(db, g, action);
    return { g, sc: advisorScope(g.household_id) };
  }

  router.add('GET', '/api/advisor/clients/:id/overview', {}, async ({ user, params, query }) => {
    const month = monthParam(query.month);
    const { g, sc } = client(user, params, `Översikt ${month}`);
    const hid = g.household_id;
    const budget = db.prepare('SELECT c.name AS category, c.kind, b.amount FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.household_id = ? ORDER BY c.kind DESC, b.amount DESC').all(hid);
    const from12 = monthRangeOf(ymAdd(month, -11)).from;
    const to = monthRangeOf(month).to;
    const scenarios = db.prepare('SELECT id, name, horizon_years, events FROM scenarios WHERE household_id = ? ORDER BY name').all(hid).map((s) => ({ id: s.id, name: s.name, horizon_years: s.horizon_years, events: JSON.parse(s.events).length }));
    return {
      client: { grant_id: g.id, level: g.level, expires_at: g.expires_at, since: g.accepted_at, members: members(db, hid).map((m) => m.name) },
      month,
      report: await monthlyReport(db, prices, sc, hid, month),
      income_12m: incomeStatement(db, sc, from12, to),
      balance: await balanceSheet(db, prices, sc),
      budget,
      // Antal och id:n på länkade konton avslöjar att privata konton finns, så de följer inte med.
      goals: stripLinks(await goalSummary(db, prices, sc, hid)),
      assumptions: assumptionsOf(db, hid),
      scenarios,
      notice: 'Privata konton och deras innehav ingår aldrig i rådgivarens vy.',
    };
  });

  router.add('GET', '/api/advisor/clients/:id/report', {}, async ({ user, params, query }) => {
    const month = monthParam(query.month);
    const { g, sc } = client(user, params, `Månadsrapport ${month}`);
    return monthlyReport(db, prices, sc, g.household_id, month);
  });

  router.add('GET', '/api/advisor/clients/:id/scenarios/:sid/run', {}, async ({ user, params }) => {
    const { g, sc } = client(user, params, 'Scenario');
    const s = db.prepare('SELECT * FROM scenarios WHERE id = ? AND household_id = ?').get(Number(params.sid), g.household_id);
    if (!s) throw notFound();
    return { name: s.name, ...(await runPlan(db, prices, sc, g.household_id, { years: s.horizon_years, events: JSON.parse(s.events), assumptions: assumptionsOf(db, g.household_id) })) };
  });

  router.add('GET', '/api/advisor/clients/:id/transactions', {}, ({ user, params, query }) => {
    const { sc } = client(user, params, 'Transaktioner', { needLevel: 'detail' });
    const where = [sc.acct('a')];
    const args = [];
    if (query.from) (where.push('t.date >= ?'), args.push(String(query.from)));
    if (query.to) (where.push('t.date <= ?'), args.push(String(query.to)));
    if (query.q) {
      where.push(`t.search LIKE ? ESCAPE '\\'`);
      args.push(`%${normalizeText(query.q).replace(/[%_\\]/g, '\\$&')}%`);
    }
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const from = `FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
    const items = db.prepare(`SELECT t.id, t.date, t.description, t.amount, a.name AS account, c.name AS category ${from} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { total, items };
  });

  // Rådgivarens egna anteckningar. Läsbara så länge rådgivaren har haft samtycke (även efter att det upphört),
  // eftersom de är rådgivarens egen dokumentation. Kunden ser dem aldrig.
  const notesGrant = (user, params) => {
    requireEnabled();
    const g = db.prepare('SELECT * FROM advisor_grants WHERE id = ? AND advisor_id = ?').get(Number(params.id), user.id);
    if (!g) throw notFound();
    return g;
  };

  router.add('GET', '/api/advisor/clients/:id/notes', {}, ({ user, params }) => {
    const g = notesGrant(user, params);
    return { items: db.prepare('SELECT id, body, created_at FROM advisor_notes WHERE advisor_id = ? AND household_id = ? ORDER BY id DESC').all(user.id, g.household_id) };
  });

  router.add('POST', '/api/advisor/clients/:id/notes', {}, ({ user, params, body }) => {
    const g = notesGrant(user, params);
    if (grantState(db, g) !== 'active') throw forbidden('Samtycket är inte aktivt.');
    return { id: insertRow(db, 'advisor_notes', { advisor_id: user.id, household_id: g.household_id, body: str(body.body, 'Anteckning', { max: 4000 }) }) };
  });

  router.add('DELETE', '/api/advisor/clients/:id/notes/:noteId', {}, ({ user, params }) => {
    const g = notesGrant(user, params);
    db.prepare('DELETE FROM advisor_notes WHERE id = ? AND advisor_id = ? AND household_id = ?').run(Number(params.noteId), user.id, g.household_id);
  });

}
