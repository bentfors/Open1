import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';
import { createUser } from './helpers.js';
import { setTodayForTests } from '../src/dates.js';

describe('avtalsvarningar och rapportering åt någon annan', () => {
  let w, admin, anna, cia, eve;

  before(async () => {
    setTodayForTests('2026-05-20');
    w = await buildWorld();
    ({ anna, cia, eve } = w.users);
    admin = w.admin;
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  const warnings = async () => (await admin.get('/api/contracts/warnings')).json.map((x) => x.text);

  test('uppdragets pris jämförs med det som debiteras i projektet', async () => {
    // Anna har 1200 kr/tim som medlem i ACME-1. Avtalet säger 1100.
    const a = (await admin.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, project_id: w.p1, start_date: '2026-01-01', hourly_rate: 1100, hours_per_week: 40 })).json.id;
    assert.ok((await warnings()).some((t) => /Anna Konsults uppdrag hos Acme AB har 1\s100 kr\/tim i avtalet men debiteras 1\s200 kr\/tim i projektet ACME-1\./u.test(t)));
    await admin.patch(`/api/assignments/${a}`, { hourly_rate: 1200 });
    assert.ok(!(await warnings()).some((t) => t.includes('i avtalet men debiteras')), 'samma pris ger ingen varning');
  });

  test('konsulter utan kostnadsställe, när kostnadsställen används', async () => {
    await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id });
    assert.ok(!(await warnings()).some((t) => t.includes('saknar kostnadsställe')), 'inga kostnadsställen, ingen varning');
    const lkp = (await admin.post('/api/cost-centers', { code: 'LKP', name: 'Linköping' })).json.id;
    assert.ok((await warnings()).includes('Anna Konsult saknar kostnadsställe och räknas inte in i någon KST-budget.'));
    await admin.patch(`/api/users/${anna.id}`, { cost_center_id: lkp });
    assert.ok(!(await warnings()).some((t) => t.includes('saknar kostnadsställe')));
  });

  test('underkonsult utan inköpspris', async () => {
    const ulf = await createUser(w.app, admin, { email: 'ulf@t.se', name: 'Ulf Underkonsult', pay_type: 'subcontractor' });
    assert.ok((await warnings()).some((t) => t.startsWith('Ulf Underkonsult är underkonsult men saknar inköpspris')));
    await admin.patch(`/api/users/${ulf.id}`, { cost_rate: 650 });
    assert.ok(!(await warnings()).some((t) => t.startsWith('Ulf Underkonsult')));
  });

  test('administratören hämtar en annan persons projekt, rapporterar, skickar in och tar tillbaka', async () => {
    const annas = (await admin.get(`/api/my/targets?user_id=${anna.id}`)).json.activities.map((a) => a.code);
    assert.ok(annas.includes('ACME-1'), 'Anna är medlem i ACME-1');
    const eves = (await admin.get(`/api/my/targets?user_id=${eve.id}`)).json.activities.map((a) => a.code);
    assert.ok(!eves.includes('ACME-1') && eves.includes('INT-1'), 'Eve ser bara det interna projektet');

    assert.equal((await admin.put('/api/time/entries', { ...entry('2026-05-18', { activity_id: w.p1Activity }, 480), user_id: anna.id })).status, 200);
    const submitted = await admin.post('/api/time/submit', { week_start: '2026-05-18', user_id: anna.id });
    assert.deepEqual([submitted.status, submitted.json.submitted], [200, 1]);
    const week = (await anna.client.get('/api/time/week?start=2026-05-18')).json;
    assert.equal(week.entries[0].status, 'submitted');
    assert.equal((await admin.post('/api/time/recall', { week_start: '2026-05-18', user_id: anna.id })).json.recalled, 1);
    assert.equal((await anna.client.get('/api/time/week?start=2026-05-18')).json.entries[0].status, 'open');
  });

  test('vanliga användare kan inte göra det åt andra', async () => {
    assert.equal((await anna.client.get(`/api/my/targets?user_id=${eve.id}`)).status, 403);
    assert.equal((await anna.client.post('/api/time/submit', { week_start: '2026-05-18', user_id: eve.id })).status, 403);
    assert.equal((await anna.client.post('/api/time/recall', { week_start: '2026-05-18', user_id: eve.id })).status, 403);
    assert.equal((await anna.client.get(`/api/my/targets?user_id=${anna.id}`)).status, 200, 'sig själv går bra');
    assert.equal((await admin.post('/api/time/submit', { week_start: '2026-05-18', user_id: 'x' })).status, 400);
  });
});
