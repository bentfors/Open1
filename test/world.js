import { ADMIN, createUser, startApp } from './helpers.js';

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

  // Bo och Cia får provision på Annas TB.
  await admin.post('/api/commission-links', { earner_id: bo.id, source_id: anna.id, percent: 10 });
  await admin.post('/api/commission-links', { earner_id: cia.id, source_id: anna.id, percent: 5 });

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
