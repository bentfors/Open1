import { ADMIN, createUser, startApp } from './helpers.js';
import { resolveRates } from '../src/domain.js';

// Gemensam testvärld: ett litet företag med kunder, projekt, chefer och provisionsmottagare.
export async function buildWorld() {
  const app = await startApp();
  const admin = app.client();
  await admin.login(ADMIN.email, ADMIN.password);

  const categories = Object.fromEntries((await admin.get('/api/categories')).json.map((c) => [c.name, c.id]));

  const carl = await createUser(app, admin, { email: 'carl@t.se', name: 'Carl Chef', category_id: categories.Chef });
  const dan = await createUser(app, admin, { email: 'dan@t.se', name: 'Dan Projektledare', category_id: categories.TA });
  const bo = await createUser(app, admin, { email: 'bo@t.se', name: 'Bo AM', category_id: categories.AM });
  const cia = await createUser(app, admin, { email: 'cia@t.se', name: 'Cia BM', category_id: categories.BM });
  const eve = await createUser(app, admin, { email: 'eve@t.se', name: 'Eve Utomstående' });
  const anna = await createUser(app, admin, {
    email: 'anna@t.se',
    name: 'Anna Konsult',
    category_id: categories['Konsult Expert'],
    manager_id: carl.id,
    cost_rate: 500,
  });

  const customer = (await admin.post('/api/customers', { name: 'Acme AB' })).json.id;

  const p1 = (
    await admin.post('/api/projects', {
      customer_id: customer,
      code: 'ACME-1',
      name: 'Plattform',
      manager_id: dan.id,
      billing_type: 'hourly',
      hourly_rate: 1000,
    })
  ).json.id;
  const p1Activity = (await admin.get(`/api/projects/${p1}`)).json.activities[0].id; // "Arbete", debiterbar
  const meeting = (await admin.post(`/api/projects/${p1}/activities`, { name: 'Möte', billable: false })).json.id;
  await admin.put(`/api/projects/${p1}/members/${anna.id}`, { hourly_rate: 1200 });

  const p2 = (
    await admin.post('/api/projects', {
      customer_id: customer,
      code: 'ACME-2',
      name: 'Fastpris',
      billing_type: 'fixed',
      hourly_rate: 900,
    })
  ).json.id;
  const p2Activity = (await admin.get(`/api/projects/${p2}`)).json.activities[0].id;
  await admin.put(`/api/projects/${p2}/members/${anna.id}`, {});

  const absences = (await admin.get('/api/absence-types')).json;
  const vacation = absences.find((a) => a.name === 'Semester').id;

  return {
    app,
    admin,
    categories,
    users: { carl, dan, bo, cia, eve, anna },
    customer,
    p1,
    p1Activity,
    meeting,
    p2,
    p2Activity,
    vacation,
    close: () => app.close(),
  };
}

export const entry = (date, target, minutes, extra = {}) => ({ date, minutes, ...target, ...extra });

/**
 * Annas vecka 3–6 mars 2025, godkänd av admin. Handräknat (Annas timkostnad 500):
 *   mån  8 h ACME-1 Arbete, medlemspris 1200   intäkt 9600, kostnad 4000
 *   tis  2 h ACME-1 Möte, ej debiterbart       kostnad 1000
 *   ons  4 h ACME-2 fast pris, värde 900/tim   värde 3600, kostnad 2000
 *   tor  8 h semester                          räknas inte
 * TB = 13200 − 7000 = 6200.
 */
export async function seedApprovedWeek(w) {
  const { anna } = w.users;
  const put = (d, t, m) => anna.client.put('/api/time/entries', entry(d, t, m));
  await put('2025-03-03', { activity_id: w.p1Activity }, 480);
  await put('2025-03-04', { activity_id: w.meeting }, 120);
  await put('2025-03-05', { activity_id: w.p2Activity }, 240);
  await put('2025-03-06', { absence_type_id: w.vacation }, 480);
  await anna.client.post('/api/time/submit', { week_start: '2025-03-03' });
  const ids = (await w.admin.get('/api/approvals')).json.time.map((r) => r.id);
  await w.admin.post('/api/approvals/decide', { kind: 'time', ids, decision: 'approve' });
}

// Lägger in en rad direkt i databasen med korrekta priser. För att slippa attestflödet i tester som inte handlar om det.
export function addTime(w, { user_id, date, activity_id, minutes, status = 'approved' }) {
  const r = resolveRates(w.app.db, user_id, activity_id);
  return w.app.db
    .prepare(
      `INSERT INTO time_entries (user_id, work_date, activity_id, minutes, status, billable, bill_rate, cost_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(user_id, date, activity_id, minutes, status, r.billable, r.bill_rate, r.cost_rate).lastInsertRowid;
}
