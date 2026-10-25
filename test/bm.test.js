import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';

// Alla konsulters tid attesteras av deras BM. Utan BM gäller den vanliga ordningen (projektledare, annars chef).
describe('BM attesterar konsulters tid', () => {
  let w, anna, dan, carl, cia, eve, admin;
  const submitWeek = async (client, week) => (await client.post('/api/time/submit', { week_start: week })).status;

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, carl, cia, eve } = w.users);
    admin = w.admin;
    assert.equal((await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id })).status, 200);

    const put = (d, t, m) => anna.client.put('/api/time/entries', entry(d, t, m));
    await put('2025-03-03', { activity_id: w.p1Activity }, 480); // projekt med projektledare Dan
    await put('2025-03-05', { activity_id: w.p2Activity }, 240); // projekt utan projektledare
    await put('2025-03-06', { absence_type_id: w.vacation }, 480); // frånvaro, Annas chef är Carl
    assert.equal(await submitWeek(anna.client, '2025-03-03'), 200);
  });
  after(() => w.close());

  const queue = async (u) => (await u.client.get('/api/approvals')).json.time;

  test('BM ser all Annas tid, ingen annan ser något', async () => {
    assert.equal((await queue(cia)).length, 3, 'projekttid, fastpris och frånvaro');
    assert.equal((await queue(dan)).length, 0, 'projektledaren attesterar inte längre');
    assert.equal((await queue(carl)).length, 0, 'inte heller chefen');
    assert.equal((await queue(eve)).length, 0);
    assert.equal((await queue(anna)).length, 0);
    assert.equal((await admin.get('/api/approvals')).json.time.length, 3, 'admin ser allt');
    assert.equal((await cia.client.get('/api/approvals/count')).json.count, 3);
    assert.equal((await dan.client.get('/api/approvals/count')).json.count, 0);
  });

  test('bara BM och admin kan attestera', async () => {
    const ids = (await queue(cia)).map((r) => r.id);
    for (const who of [dan, carl, eve, anna]) {
      const r = await who.client.post('/api/approvals/decide', { kind: 'time', ids, decision: 'approve' });
      assert.equal(r.status, 403, who.id);
    }
    assert.equal((await admin.get('/api/approvals')).json.time.length, 3, 'inget ändrades');
  });

  test('BM kan avslå med anledning och godkänna resten', async () => {
    const rows = await queue(cia);
    const vacation = rows.find((r) => r.absence_name === 'Semester');
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'time', ids: [vacation.id], decision: 'reject', note: 'Fel vecka' })).status, 200);
    const rest = rows.filter((r) => r.id !== vacation.id).map((r) => r.id);
    const ok = await cia.client.post('/api/approvals/decide', { kind: 'time', ids: rest, decision: 'approve' });
    assert.equal(ok.json.approved, 2);
    assert.equal((await queue(cia)).length, 0);
  });

  test('BM ser konsultens timmar i rapporter, men inga pengar', async () => {
    const r = (await cia.client.get('/api/reports/time?from=2025-03-01&to=2025-03-31&group_by=user')).json;
    assert.deepEqual(r.rows.map((x) => x.label), ['Anna Konsult']);
    assert.equal('revenue' in r.total, false);
    assert.equal((await eve.client.get('/api/reports/time?from=2025-03-01&to=2025-03-31&group_by=user')).json.rows.length, 0);
  });

  test('utlägg och körning följer fortsatt projektledaren', async () => {
    await anna.client.post('/api/expenses', { date: '2025-03-04', description: 'Tåg', amount: 100, project_id: w.p1 });
    assert.equal((await dan.client.get('/api/approvals')).json.expenses.length, 1);
    assert.equal((await cia.client.get('/api/approvals')).json.expenses.length, 0);
  });

  test('utan BM gäller den vanliga ordningen igen', async () => {
    assert.equal((await admin.patch(`/api/users/${anna.id}`, { bm_id: null })).status, 200);
    await anna.client.put('/api/time/entries', entry('2025-03-12', { activity_id: w.p1Activity }, 60));
    assert.equal(await submitWeek(anna.client, '2025-03-10'), 200);
    assert.equal((await queue(dan)).length, 1, 'projektledaren attesterar');
    assert.equal((await queue(cia)).length, 0);
  });

  test('ogiltig BM avvisas', async () => {
    assert.equal((await admin.patch(`/api/users/${anna.id}`, { bm_id: anna.id })).status, 400, 'inte sin egen BM');
    assert.equal((await admin.patch(`/api/users/${anna.id}`, { bm_id: 99999 })).status, 400);
    await admin.patch(`/api/users/${eve.id}`, { active: false });
    assert.equal((await admin.patch(`/api/users/${anna.id}`, { bm_id: eve.id })).status, 400, 'inaktiv');
    assert.equal((await anna.client.patch(`/api/users/${anna.id}`, { bm_id: anna.id })).status, 403, 'bara admin sätter BM');
    const users = (await admin.get('/api/users')).json;
    assert.equal('bm_name' in users[0], true);
  });
});
