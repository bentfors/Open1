import { bad, conflict, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow, tx } from '../db.js';
import { today } from '../dates.js';
import { audit, changesFor } from '../audit.js';

const PROJECT_SCHEMA = {
  customer_id: f.int({ required: true, min: 1, label: 'Kund' }),
  code: f.str({ required: true, max: 30, label: 'Projektnummer' }),
  name: f.str({ required: true, max: 150, label: 'Projektnamn' }),
  manager_id: f.int({ nullable: true, min: 1, label: 'Projektledare' }),
  status: f.oneOf(['active', 'closed'], { label: 'Status' }),
  billing_type: f.oneOf(['hourly', 'fixed', 'internal'], { label: 'Debitering' }),
  hourly_rate: f.num({ min: 0, max: 100000, label: 'Timpris' }),
  budget_hours: f.num({ nullable: true, min: 0, max: 1e7, label: 'Budget (timmar)' }),
  budget_amount: f.num({ nullable: true, min: 0, max: 1e10, label: 'Budget (belopp)' }),
  start_date: f.date({ nullable: true, label: 'Startdatum' }),
  end_date: f.date({ nullable: true, label: 'Slutdatum' }),
  open_for_all: f.bool({ label: 'Öppet för alla' }),
  notes: f.str({ max: 2000, label: 'Anteckningar' }),
};

const ACTIVITY_SCHEMA = {
  name: f.str({ required: true, max: 80, label: 'Aktivitet' }),
  billable: f.bool({ label: 'Debiterbar' }),
  hourly_rate: f.num({ nullable: true, min: 0, max: 100000, label: 'Timpris' }),
  active: f.bool({ label: 'Aktiv' }),
};

const DEFAULT_ACTIVITIES = ['Arbete'];

function assertProjectRefs(db, data) {
  if (data.customer_id != null && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(data.customer_id)) {
    throw bad('Kunden finns inte.');
  }
  if (data.manager_id != null && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(data.manager_id)) {
    throw bad('Projektledaren finns inte eller är inaktiv.');
  }
}

function assertDates(data, existing) {
  const m = { ...existing, ...data };
  if (m.start_date && m.end_date && m.end_date < m.start_date) throw bad('Slutdatum kan inte ligga före startdatum.');
}

export function registerProjects({ db, router }) {
  router.add('GET', '/api/projects', { auth: 'finance' }, () =>
    db
      .prepare(
        `SELECT p.*, c.name AS customer_name, m.name AS manager_name,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS members,
                COALESCE((SELECT SUM(te.minutes) FROM time_entries te
                          JOIN activities a ON a.id = te.activity_id WHERE a.project_id = p.id), 0) AS minutes
         FROM projects p
         JOIN customers c ON c.id = p.customer_id
         LEFT JOIN users m ON m.id = p.manager_id
         ORDER BY (p.status = 'active') DESC, c.name, p.code`,
      )
      .all(),
  );

  router.add('GET', '/api/projects/:id', { auth: 'finance_super' }, ({ params }) => {
    const id = Number(params.id);
    const project = db
      .prepare(
        `SELECT p.*, c.name AS customer_name FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`,
      )
      .get(id);
    if (!project) throw notFound('Projektet finns inte.');
    project.members = db
      .prepare(
        `SELECT pm.user_id, u.name, u.active, pm.hourly_rate
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? ORDER BY u.name`,
      )
      .all(id);
    project.activities = db
      .prepare('SELECT id, name, billable, hourly_rate, active FROM activities WHERE project_id = ? ORDER BY name')
      .all(id);
    return project;
  });

  router.add('POST', '/api/projects', { auth: 'admin' }, ({ body, user }) => {
    const data = parse(body, PROJECT_SCHEMA);
    assertProjectRefs(db, data);
    assertDates(data, null);
    if (db.prepare('SELECT 1 FROM projects WHERE code = ?').get(data.code)) {
      throw conflict('Projektnumret används redan.');
    }
    return tx(db, () => {
      const id = insertRow(db, 'projects', data);
      for (const name of DEFAULT_ACTIVITIES) {
        insertRow(db, 'activities', { project_id: id, name, billable: data.billing_type === 'internal' ? 0 : 1 });
      }
      audit(db, user, { entity: 'project', action: 'create', entityId: id, label: `${data.code} ${data.name}`, projectId: id, changes: changesFor(db, null, data, 'project') });
      return { id };
    });
  });

  router.add('PATCH', '/api/projects/:id', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!existing) throw notFound('Projektet finns inte.');
    const data = parse(body, PROJECT_SCHEMA, { partial: true });
    assertProjectRefs(db, data);
    assertDates(data, existing);
    if (data.code && db.prepare('SELECT 1 FROM projects WHERE code = ? AND id <> ?').get(data.code, id)) {
      throw conflict('Projektnumret används redan.');
    }
    tx(db, () => {
      updateRow(db, 'projects', id, data);
      const merged = { ...existing, ...data };
      audit(db, user, { entity: 'project', action: 'update', entityId: id, label: `${merged.code} ${merged.name}`, projectId: id, changes: changesFor(db, existing, data, 'project') });
    });
    return { ok: true };
  });

  router.add('DELETE', '/api/projects/:id', { auth: 'admin' }, ({ params, user }) => {
    const id = Number(params.id);
    const used =
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM time_entries te JOIN activities a ON a.id = te.activity_id WHERE a.project_id = ?)
                + (SELECT COUNT(*) FROM expenses WHERE project_id = ?)
                + (SELECT COUNT(*) FROM mileage WHERE project_id = ?) AS n`,
        )
        .get(id, id, id).n;
    if (used) throw conflict('Projektet har rapporterad tid eller kostnader. Avsluta det i stället.');
    const existing = db.prepare('SELECT code, name FROM projects WHERE id = ?').get(id);
    tx(db, () => {
      if (existing) audit(db, user, { entity: 'project', action: 'delete', entityId: id, label: `${existing.code} ${existing.name}`, projectId: id });
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    return { ok: true };
  });

  // Projektmedlemmar
  router.add('PUT', '/api/projects/:id/members/:userId', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const userId = Number(params.userId);
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw notFound('Projektet finns inte.');
    const member = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (!member) throw notFound('Användaren finns inte.');
    const data = parse(body, { hourly_rate: f.num({ nullable: true, min: 0, max: 100000, label: 'Timpris' }) });
    const rate = { hourly_rate: data.hourly_rate ?? null };
    const before = db.prepare('SELECT hourly_rate FROM project_members WHERE project_id = ? AND user_id = ?').get(id, userId);
    tx(db, () => {
      db.prepare(
        `INSERT INTO project_members (project_id, user_id, hourly_rate) VALUES (?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET hourly_rate = excluded.hourly_rate`,
      ).run(id, userId, rate.hourly_rate);
      audit(db, user, { entity: 'project_member', action: before ? 'update' : 'create', label: member.name, userId, projectId: id, changes: changesFor(db, before, rate) });
    });
    return { ok: true };
  });

  router.add('DELETE', '/api/projects/:id/members/:userId', { auth: 'admin' }, ({ params, user }) => {
    const id = Number(params.id);
    const userId = Number(params.userId);
    const member = db.prepare('SELECT u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND pm.user_id = ?').get(id, userId);
    tx(db, () => {
      if (member) audit(db, user, { entity: 'project_member', action: 'delete', label: member.name, userId, projectId: id });
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
    });
    return { ok: true };
  });

  // Aktiviteter
  router.add('POST', '/api/projects/:id/activities', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const project = db.prepare('SELECT billing_type FROM projects WHERE id = ?').get(id);
    if (!project) throw notFound('Projektet finns inte.');
    const data = parse(body, ACTIVITY_SCHEMA);
    if (db.prepare('SELECT 1 FROM activities WHERE project_id = ? AND name = ?').get(id, data.name)) {
      throw conflict('Aktiviteten finns redan i projektet.');
    }
    return tx(db, () => {
      const activityId = insertRow(db, 'activities', { ...data, project_id: id });
      audit(db, user, { entity: 'activity', action: 'create', entityId: activityId, label: data.name, projectId: id, changes: changesFor(db, null, data) });
      return { id: activityId };
    });
  });

  router.add('PATCH', '/api/activities/:id', { auth: 'admin' }, ({ params, body, user }) => {
    const id = Number(params.id);
    const existing = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
    if (!existing) throw notFound('Aktiviteten finns inte.');
    const data = parse(body, ACTIVITY_SCHEMA, { partial: true });
    if (
      data.name &&
      db.prepare('SELECT 1 FROM activities WHERE project_id = ? AND name = ? AND id <> ?').get(existing.project_id, data.name, id)
    ) {
      throw conflict('Aktiviteten finns redan i projektet.');
    }
    tx(db, () => {
      updateRow(db, 'activities', id, data);
      audit(db, user, { entity: 'activity', action: 'update', entityId: id, label: data.name ?? existing.name, projectId: existing.project_id, changes: changesFor(db, existing, data) });
    });
    return { ok: true };
  });

  router.add('DELETE', '/api/activities/:id', { auth: 'admin' }, ({ params, user }) => {
    const id = Number(params.id);
    if (db.prepare('SELECT 1 FROM time_entries WHERE activity_id = ? LIMIT 1').get(id)) {
      throw conflict('Aktiviteten har rapporterad tid. Inaktivera den i stället.');
    }
    const existing = db.prepare('SELECT name, project_id FROM activities WHERE id = ?').get(id);
    tx(db, () => {
      if (existing) audit(db, user, { entity: 'activity', action: 'delete', entityId: id, label: existing.name, projectId: existing.project_id });
      db.prepare('DELETE FROM activities WHERE id = ?').run(id);
    });
    return { ok: true };
  });

  // Det en användare får rapportera på: aktiva aktiviteter i projekt där hen är medlem eller som är öppna för alla.
  router.add('GET', '/api/my/targets', {}, ({ user }) => {
    const date = today();
    const activities = db
      .prepare(
        `SELECT a.id AS activity_id, a.name AS activity_name, a.billable,
                p.id AS project_id, p.code, p.name AS project_name, p.billing_type, p.start_date, p.end_date,
                c.id AS customer_id, c.name AS customer_name
         FROM activities a
         JOIN projects p ON p.id = a.project_id
         JOIN customers c ON c.id = p.customer_id
         WHERE a.active = 1 AND p.status = 'active' AND c.active = 1
           AND (p.open_for_all = 1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))
           AND (p.end_date IS NULL OR p.end_date >= ?)
         ORDER BY c.name, p.code, a.name`,
      )
      .all(user.id, date);
    const absences = db.prepare('SELECT id, name FROM absence_types WHERE active = 1 ORDER BY name').all();
    return { activities, absences };
  });
}
