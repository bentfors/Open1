import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';

describe('tidrapportering och attest', () => {
  let w, anna, dan, carl, eve, admin;
  const D1 = '2025-03-03'; // måndag
  const D2 = '2025-03-04';
  const D3 = '2025-03-05';
  const D4 = '2025-03-06';

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, carl, eve } = w.users);
    admin = w.admin;
  });
  after(() => w.close());

  test('medlem kan rapportera, icke-medlem kan inte', async () => {
    const ok = await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 480, { note: 'Bygge' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.minutes, 480);
    assert.equal(ok.json.status, 'open');

    const denied = await eve.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 60));
    assert.equal(denied.status, 403);
  });

  test('samma cell uppdateras i stället för att dubbleras, 0 minuter raderar', async () => {
    await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 420));
    const week = (await anna.client.get(`/api/time/week?start=2025-03-03`)).json;
    assert.equal(week.entries.filter((e) => e.work_date === D1).length, 1);
    assert.equal(week.entries[0].minutes, 420);
    assert.equal(week.entries[0].note, 'Bygge', 'anteckningen behålls när bara tiden ändras');

    const del = await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 0));
    assert.equal(del.json.deleted, true);
    assert.equal((await anna.client.get(`/api/time/week?start=2025-03-03`)).json.entries.length, 0);
    await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 480));
  });

  test('ogiltiga indata avvisas', async () => {
    const c = anna.client;
    assert.equal((await c.put('/api/time/entries', { date: D1, minutes: 60 })).status, 400, 'varken aktivitet eller frånvaro');
    assert.equal(
      (await c.put('/api/time/entries', { date: D1, minutes: 60, activity_id: w.p1Activity, absence_type_id: w.vacation })).status,
      400,
      'både och',
    );
    assert.equal((await c.put('/api/time/entries', entry('2025-02-30', { activity_id: w.p1Activity }, 60))).status, 400);
    assert.equal((await c.put('/api/time/entries', entry(D2, { activity_id: w.p1Activity }, -5))).status, 400);
    assert.equal((await c.put('/api/time/entries', entry(D2, { activity_id: w.p1Activity }, 1441))).status, 400);
    assert.equal((await c.put('/api/time/entries', entry(D2, { activity_id: 9999 }, 60))).status, 400);
    assert.equal((await c.get('/api/time/week?start=2025-03-04')).status, 400, 'veckan måste börja på en måndag');
  });

  test('projekttid framåt i tiden nekas men planerad frånvaro tillåts', async () => {
    const future = await anna.client.put('/api/time/entries', entry('2999-01-04', { activity_id: w.p1Activity }, 60));
    assert.equal(future.status, 400);
    const leave = await anna.client.put('/api/time/entries', entry('2999-01-04', { absence_type_id: w.vacation }, 480));
    assert.equal(leave.status, 200);
    await anna.client.put('/api/time/entries', entry('2999-01-04', { absence_type_id: w.vacation }, 0));
  });

  test('en dag kan inte överstiga 24 timmar', async () => {
    await anna.client.put('/api/time/entries', entry(D2, { activity_id: w.p1Activity }, 1000));
    const over = await anna.client.put('/api/time/entries', entry(D2, { activity_id: w.meeting }, 500));
    assert.equal(over.status, 400);
    await anna.client.put('/api/time/entries', entry(D2, { activity_id: w.p1Activity }, 0));
  });

  test('användare kan inte skriva tid åt någon annan, admin kan', async () => {
    const r = await eve.client.put('/api/time/entries', { ...entry(D1, { absence_type_id: w.vacation }, 60), user_id: anna.id });
    assert.equal(r.status, 403);
    assert.equal((await eve.client.get(`/api/time/week?start=2025-03-03&user_id=${anna.id}`)).status, 403);
    assert.equal((await admin.get(`/api/time/week?start=2025-03-03&user_id=${anna.id}`)).status, 200);
  });

  test('fyll veckan: debiterbar, ej debiterbar, fastpris och frånvaro', async () => {
    const put = (d, t, m) => anna.client.put('/api/time/entries', entry(d, t, m));
    assert.equal((await put(D2, { activity_id: w.meeting }, 120)).status, 200);
    assert.equal((await put(D3, { activity_id: w.p2Activity }, 240)).status, 200);
    assert.equal((await put(D4, { absence_type_id: w.vacation }, 480)).status, 200);
  });

  test('inskickad tid är låst, och kan tas tillbaka', async () => {
    const sub = await anna.client.post('/api/time/submit', { week_start: '2025-03-03' });
    assert.equal(sub.json.submitted, 4);
    const edit = await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 300));
    assert.equal(edit.status, 409);

    const recall = await anna.client.post('/api/time/recall', { week_start: '2025-03-03' });
    assert.equal(recall.json.recalled, 4);
    assert.equal((await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 480))).status, 200);
    await anna.client.post('/api/time/submit', { week_start: '2025-03-03' });
  });

  test('attestkön följer projektledare och chef', async () => {
    const danQueue = (await dan.client.get('/api/approvals')).json.time;
    assert.deepEqual(
      danQueue.map((r) => r.project_code),
      ['ACME-1', 'ACME-1'],
      'Dan ser bara sitt projekt',
    );
    const carlQueue = (await carl.client.get('/api/approvals')).json.time;
    assert.equal(carlQueue.length, 2, 'Carl är chef: fastpris utan projektledare och frånvaron');
    assert.ok(carlQueue.some((r) => r.absence_name === 'Semester'));
    assert.equal((await eve.client.get('/api/approvals')).json.time.length, 0);
    assert.equal((await anna.client.get('/api/approvals')).json.time.length, 0, 'ingen attesterar sig själv');
    assert.equal((await dan.client.get('/api/approvals/count')).json.count, 2);
  });

  test('fel person kan inte attestera, allt eller inget', async () => {
    const ids = (await admin.get(`/api/reports/time?from=${D1}&to=${D4}&group_by=day`)).status; // sanity
    assert.equal(ids, 200);
    const all = (await admin.get('/api/approvals')).json.time.map((r) => r.id);
    assert.equal(all.length, 4);

    const eveTry = await eve.client.post('/api/approvals/decide', { kind: 'time', ids: all, decision: 'approve' });
    assert.equal(eveTry.status, 403);
    const annaTry = await anna.client.post('/api/approvals/decide', { kind: 'time', ids: all, decision: 'approve' });
    assert.equal(annaTry.status, 403);
    const mixed = await dan.client.post('/api/approvals/decide', { kind: 'time', ids: all, decision: 'approve' });
    assert.equal(mixed.status, 403, 'Dan får inte attestera chefens rader, och inget sparas');
    assert.equal((await admin.get('/api/approvals')).json.time.length, 4);
  });

  test('avslag kräver anledning och ger användaren möjlighet att rätta', async () => {
    const danQueue = (await dan.client.get('/api/approvals')).json.time;
    const target = danQueue.find((r) => r.activity_name === 'Möte');
    const noNote = await dan.client.post('/api/approvals/decide', { kind: 'time', ids: [target.id], decision: 'reject' });
    assert.equal(noNote.status, 400);
    const rej = await dan.client.post('/api/approvals/decide', {
      kind: 'time',
      ids: [target.id],
      decision: 'reject',
      note: 'Fel dag',
    });
    assert.equal(rej.json.rejected, 1);

    const week = (await anna.client.get('/api/time/week?start=2025-03-03')).json;
    const row = week.entries.find((e) => e.id === target.id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.reject_note, 'Fel dag');

    // Rätta och skicka in igen
    assert.equal((await anna.client.put('/api/time/entries', entry(D2, { activity_id: w.meeting }, 120))).json.status, 'open');
    assert.equal((await anna.client.post('/api/time/submit', { week_start: '2025-03-03' })).json.submitted, 1);
  });

  test('godkännande låser tiden, admin kan öppna den igen', async () => {
    const danQueue = (await dan.client.get('/api/approvals')).json.time.map((r) => r.id);
    assert.equal(danQueue.length, 2);
    assert.equal((await dan.client.post('/api/approvals/decide', { kind: 'time', ids: danQueue, decision: 'approve' })).json.approved, 2);
    const carlQueue = (await carl.client.get('/api/approvals')).json.time.map((r) => r.id);
    assert.equal((await carl.client.post('/api/approvals/decide', { kind: 'time', ids: carlQueue, decision: 'approve' })).json.approved, 2);

    assert.equal((await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 300))).status, 409);
    assert.equal((await anna.client.post('/api/approvals/reopen', { kind: 'time', ids: [1] })).status, 403);

    const week = (await anna.client.get('/api/time/week?start=2025-03-03')).json;
    const first = week.entries.find((e) => e.work_date === D1);
    assert.equal((await admin.post('/api/approvals/reopen', { kind: 'time', ids: [first.id] })).json.reopened, 1);
    assert.equal((await anna.client.put('/api/time/entries', entry(D1, { activity_id: w.p1Activity }, 480))).status, 200);
    assert.equal((await anna.client.post('/api/time/submit', { week_start: '2025-03-03' })).json.submitted, 1);
    assert.equal((await dan.client.post('/api/approvals/decide', { kind: 'time', ids: [first.id], decision: 'approve' })).status, 200);
  });

  test('låst period stoppar användare men inte admin', async () => {
    await admin.patch('/api/settings', { locked_until: '2025-03-31' });
    const blocked = await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 60));
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /låst/);
    const byAdmin = await admin.put('/api/time/entries', { ...entry('2025-03-10', { activity_id: w.p1Activity }, 60), user_id: anna.id });
    assert.equal(byAdmin.status, 200);
    await admin.patch('/api/settings', { locked_until: null });
    assert.equal((await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 0))).status, 200);
  });

  test('prisändring före attest slår igenom, efter attest inte', async () => {
    const D = '2025-03-07';
    await anna.client.put('/api/time/entries', entry(D, { activity_id: w.p1Activity }, 60));
    await anna.client.post('/api/time/submit', { week_start: '2025-03-03' });
    await admin.put(`/api/projects/${w.p1}/members/${anna.id}`, { hourly_rate: 1500 });
    const id = (await dan.client.get('/api/approvals')).json.time[0].id;
    await dan.client.post('/api/approvals/decide', { kind: 'time', ids: [id], decision: 'approve' });
    const row = w.app.db.prepare('SELECT bill_rate FROM time_entries WHERE id = ?').get(id);
    assert.equal(row.bill_rate, 1500);
    await admin.put(`/api/projects/${w.p1}/members/${anna.id}`, { hourly_rate: 1200 });
    assert.equal(w.app.db.prepare('SELECT bill_rate FROM time_entries WHERE id = ?').get(id).bill_rate, 1500);
    // Återställ för efterföljande testfiler som delar mönster men inte data
    await admin.post('/api/approvals/reopen', { kind: 'time', ids: [id] });
    await anna.client.put('/api/time/entries', entry(D, { activity_id: w.p1Activity }, 0));
  });
});
