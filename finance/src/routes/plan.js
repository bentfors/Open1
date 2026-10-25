import { bad, notFound } from '../http.js';
import { insertRow, updateRow, tx } from '../db.js';
import { scopeOf } from '../scope.js';
import { validateEvents } from '../scenario.js';
import { assumptionsOf, startingPoint, baselineFor, goalSummary, runPlan } from '../plan.js';
import { str, ore, num, isoDate, id } from '../validate.js';

export function registerPlan({ db, router, prices }) {
  router.add('GET', '/api/plan/start', {}, async ({ user, query }) => {
    const sc = scopeOf(user, query.scope);
    const { start, warnings } = await startingPoint(db, prices, sc);
    const baseline = baselineFor(db, sc, user.household_id, start.debts);
    return { start, baseline, assumptions: assumptionsOf(db, user.household_id), warnings: [...warnings, ...baseline.warnings] };
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
    const assumptions = assumptionsOf(db, user.household_id);
    for (const key of Object.keys(assumptions)) if (o[key] !== undefined && o[key] !== null) assumptions[key] = num(o[key], key, { min: -20, max: 30 });
    return { years, events, overrides, assumptions };
  }

  // Basfallet (inga händelser), scenariot och ett stresstest med två procentenheter högre ränta.
  router.add('POST', '/api/plan/run', {}, async ({ user, body, query }) => runPlan(db, prices, scopeOf(user, query.scope), user.household_id, parseRun(body, user)));

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

  router.add('GET', '/api/goals', {}, async ({ user, query }) => goalSummary(db, prices, scopeOf(user, query.scope), user.household_id));
}
