import { bad, conflict, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow, tx } from '../db.js';
import { today } from '../dates.js';
import { round2 } from '../domain.js';
import { audit, changesFor, changeOf } from '../audit.js';
import { budgetView } from '../budget.js';

const COST_CENTER_SCHEMA = {
  code: f.str({ required: true, max: 20, label: 'Kod' }),
  name: f.str({ required: true, max: 80, label: 'Namn' }),
  active: f.bool({ label: 'Aktiv' }),
};

const money = (n) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(n);

export function registerBudget({ db, router }) {
  // ── Kostnadsställen ───────────────────────────────────────────────────
  router.add('GET', '/api/cost-centers', {}, () =>
    db
      .prepare(
        `SELECT cc.id, cc.code, cc.name, cc.active, (SELECT COUNT(*) FROM users u WHERE u.cost_center_id = cc.id AND u.active = 1) AS users
         FROM cost_centers cc ORDER BY cc.active DESC, cc.code`,
      )
      .all(),
  );

  router.add('POST', '/api/cost-centers', { auth: 'admin' }, ({ body, user }) => {
    const data = parse(body, COST_CENTER_SCHEMA);
    if (db.prepare('SELECT 1 FROM cost_centers WHERE code = ?').get(data.code)) throw conflict('Koden används redan.');
    return tx(db, () => {
      const id = insertRow(db, 'cost_centers', data);
      audit(db, user, { entity: 'cost_center', action: 'create', entityId: id, label: `${data.code} ${data.name}`, changes: changesFor(db, null, data, 'cost_center') });
      return { id };
    });
  });

  router.add('PATCH', '/api/cost-centers/:id', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM cost_centers WHERE id = ?').get(id);
    if (!existing) throw notFound('Kostnadsstället finns inte.');
    const data = parse(body, COST_CENTER_SCHEMA, { partial: true });
    if (data.code && db.prepare('SELECT 1 FROM cost_centers WHERE code = ? AND id <> ?').get(data.code, id)) throw conflict('Koden används redan.');
    tx(db, () => {
      updateRow(db, 'cost_centers', id, data);
      const m = { ...existing, ...data };
      audit(db, user, { entity: 'cost_center', action: 'update', entityId: id, label: `${m.code} ${m.name}`, changes: changesFor(db, existing, data, 'cost_center') });
    });
    return { ok: true };
  });

  router.add('DELETE', '/api/cost-centers/:id', { auth: 'admin' }, ({ params, user }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM cost_centers WHERE id = ?').get(id);
    if (!existing) return { ok: true };
    const used = db.prepare('SELECT COUNT(*) AS n FROM users WHERE cost_center_id = ?').get(id).n;
    if (used) throw conflict(`Kostnadsstället används av ${used} personer. Flytta dem eller inaktivera kostnadsstället i stället.`);
    if (db.prepare('SELECT 1 FROM budgets WHERE kst = ? LIMIT 1').get(id)) throw conflict('Kostnadsstället har budget. Inaktivera det i stället.');
    tx(db, () => {
      audit(db, user, { entity: 'cost_center', action: 'delete', entityId: id, label: `${existing.code} ${existing.name}` });
      db.prepare('DELETE FROM cost_centers WHERE id = ?').run(id);
    });
    return { ok: true };
  });

  // ── Budget ────────────────────────────────────────────────────────────
  const parseYear = (raw) => {
    const year = raw === undefined || raw === '' ? Number(today().slice(0, 4)) : Number(raw);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('Ogiltigt år.');
    return year;
  };
  // Tomt = alla kostnadsställen, 0 = utan kostnadsställe.
  const parseKst = (raw, { required = false } = {}) => {
    if (raw === undefined || raw === null || raw === '') {
      if (required) throw bad('Välj ett kostnadsställe.');
      return null;
    }
    const kst = Number(raw);
    if (!Number.isInteger(kst) || kst < 0) throw bad('Ogiltigt kostnadsställe.');
    if (kst > 0 && !db.prepare('SELECT 1 FROM cost_centers WHERE id = ?').get(kst)) throw bad('Kostnadsstället finns inte.');
    return kst;
  };
  const kstName = (kst) => (kst === 0 ? 'utan kostnadsställe' : db.prepare("SELECT code || ' ' || name AS n FROM cost_centers WHERE id = ?").get(kst)?.n ?? '');

  router.add('GET', '/api/budget', { auth: 'finance_super' }, ({ query }) => budgetView(db, { year: parseYear(query.year), kst: parseKst(query.kst) }));

  // Hela årets budget för ett kostnadsställe. Månader som inte skickas med lämnas orörda.
  router.add('PUT', '/api/budget', { auth: 'finance_super' }, ({ body, user }) => {
    const year = parseYear(body.year);
    const kst = parseKst(body.kst, { required: true });
    if (!Array.isArray(body.months) || !body.months.length || body.months.length > 12) throw bad('Ange mellan 1 och 12 månader.');
    const schema = {
      month: f.str({ required: true, max: 7, label: 'Månad' }),
      revenue: f.num({ required: true, min: 0, max: 1e11, label: 'Budgeterad intäkt' }),
      margin: f.num({ required: true, min: -1e11, max: 1e11, label: 'Budgeterat TB' }),
    };
    const months = body.months.map((m) => {
      const v = parse(m ?? {}, schema);
      if (!new RegExp(`^${year}-(0[1-9]|1[0-2])$`).test(v.month)) throw bad(`Månaden ${v.month} ligger inte i ${year}.`);
      return v;
    });
    if (new Set(months.map((m) => m.month)).size !== months.length) throw bad('En månad finns med två gånger.');

    tx(db, () => {
      const changes = [];
      for (const m of months) {
        const before = db.prepare('SELECT revenue, margin FROM budgets WHERE kst = ? AND month = ?').get(kst, m.month) ?? { revenue: 0, margin: 0 };
        if (before.revenue !== m.revenue) changes.push(changeOf(`${m.month} intäkt`, money(before.revenue), money(m.revenue)));
        if (before.margin !== m.margin) changes.push(changeOf(`${m.month} TB`, money(before.margin), money(m.margin)));
        db.prepare(
          `INSERT INTO budgets (kst, month, revenue, margin) VALUES (?, ?, ?, ?)
           ON CONFLICT(kst, month) DO UPDATE SET revenue = excluded.revenue, margin = excluded.margin`,
        ).run(kst, m.month, round2(m.revenue), round2(m.margin));
      }
      audit(db, user, { entity: 'budget', action: 'update', label: `Budget ${year}, ${kstName(kst)}`, changes });
    });
    return budgetView(db, { year, kst });
  });
}
