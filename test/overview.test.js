import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry, addTime } from './world.js';
import { createUser } from './helpers.js';
import { setTodayForTests } from '../src/dates.js';

// Idag är onsdag 2026-05-20 (vecka 21). Översikten tittar på fem veckor: v17 (20/4) till v21.
//   Anna (BM Cia): v17 inget, v18 4 h attesterat (28/4), v19 5 × 8 h attesterat, v20 3 × 8 h + semester inskickat.
//                  Uppdrag till 30 juni. Ett utlägg avslaget.
//   Olle (BM Cia, 20 tim): v17–v19 inget, v20 4 h utkast.
describe('översikten', () => {
  let w, admin, anna, cia, olle, sup, basic;

  before(async () => {
    setTodayForTests('2026-05-20');
    w = await buildWorld();
    ({ anna, cia } = w.users);
    admin = w.admin;
    olle = await createUser(w.app, admin, { email: 'olle@t.se', name: 'Olle Student', weekly_hours: 20, bm_id: cia.id });
    sup = await createUser(w.app, admin, { email: 'sup@t.se', name: 'Sara Superuser', finance: 2 });
    basic = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: 1 });
    await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id });
    await admin.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, project_id: w.p1, start_date: '2026-01-01', end_date: '2026-06-30', hourly_rate: 1200, hours_per_week: 40 });

    addTime(w, { user_id: anna.id, date: '2026-04-28', activity_id: w.p1Activity, minutes: 240 });
    const put = (who, date, target, minutes) => who.client.put('/api/time/entries', entry(date, target, minutes)).then((r) => assert.equal(r.status, 200, r.text));
    for (const d of ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']) await put(anna, d, { activity_id: w.p1Activity }, 480);
    for (const d of ['2026-05-11', '2026-05-12', '2026-05-13']) await put(anna, d, { activity_id: w.p1Activity }, 480);
    await put(anna, '2026-05-15', { absence_type_id: w.vacation }, 480);
    await anna.client.post('/api/time/submit', { week_start: '2026-05-04' });
    await anna.client.post('/api/time/submit', { week_start: '2026-05-11' });
    const first = (await cia.client.get('/api/approvals')).json.time.filter((r) => r.date <= '2026-05-08').map((r) => r.id);
    await cia.client.post('/api/approvals/decide', { kind: 'time', ids: first, decision: 'approve' });
    const exp = await anna.client.post('/api/expenses', { date: '2026-05-19', description: 'Taxi', amount: 300 });
    await cia.client.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'reject', note: 'Kvitto saknas' });

    const meetings = w.app.db.prepare("SELECT a.id FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = 'INT-1' AND a.name = 'Möten'").get().id;
    await put(olle, '2026-05-11', { activity_id: meetings }, 240);
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  const overview = async (who) => {
    const r = await who.get('/api/overview');
    assert.equal(r.status, 200, r.text);
    return r.json;
  };

  test('konsulten: veckan, veckor som inte är inskickade och avslaget', async () => {
    const o = await overview(anna.client);
    assert.deepEqual([o.me.this_week.start, o.me.this_week.status, o.me.this_week.norm_hours, o.me.this_week.reported_hours], ['2026-05-18', 'missing', 40, 0]);
    assert.deepEqual(o.me.late.map((c) => [c.week, c.status]), [[17, 'missing']], 'v18 har attesterad tid, v20 är inskickad');
    assert.deepEqual(o.rejected, { time: 0, expense: 1, mileage: 0 });
    assert.equal(o.approvals, undefined);
    assert.equal(o.team, undefined, 'konsulten följer inte upp någon');
    assert.equal(o.billing, undefined);
    assert.deepEqual(o.next_holiday, { date: '2026-06-19', name: 'Midsommarafton', eve: true, week: 25 }, 'nationaldagen är en lördag');
  });

  test('BM: att attestera, inrapporteringen för sina konsulter och uppdrag som tar slut', async () => {
    const o = await overview(cia.client);
    assert.equal(o.me, undefined, 'Cia rapporterar inte själv');
    assert.deepEqual(o.approvals, { time: 4, expense: 0, mileage: 0, total: 4 });
    assert.deepEqual([o.team.people, o.team.scope, o.team.late_people], [2, 'mine', 2]);
    // Anna: v17 saknas. Olle: v17–v19 saknas, v20 utkast. Annas v20 väntar på attest.
    assert.deepEqual(o.team.counts, { missing: 4, draft: 1, rejected: 0, submitted: 1 });
    assert.deepEqual(o.team.late.map((p) => [p.name, p.weeks.map((c) => c.week)]), [['Anna Konsult', [17]], ['Olle Student', [17, 18, 19, 20]]]);
    assert.deepEqual(o.expiring, [{ name: 'Anna Konsult', customer: 'Acme AB', end_date: '2026-06-30' }]);
  });

  test('ekonomi: förra månadens fakturering, låsning, lön och avtal', async () => {
    const o = await overview(sup.client);
    assert.deepEqual(o.billing, { month: '2026-04', ready: 4800, waiting: 0 }, '4 h × 1200 den 28 april');
    assert.deepEqual(o.lock, { locked_until: null, month_end: '2026-04-30', behind: true });
    assert.deepEqual(o.payroll, { month: '2026-04', people: 0, pending_people: 0 });
    assert.equal(o.warnings.count, 4, 'Anna saknar anställning, hennes uppdrag tar slut, Olle saknar uppdrag och anställning');
    assert.deepEqual([o.team.scope, o.team.people], ['all', 2]);

    const low = await overview(basic.client);
    assert.deepEqual([low.billing.ready, low.payroll, low.warnings], [4800, undefined, undefined], 'lägre nivå ser inte lön och avtal');

    await sup.client.patch('/api/settings', { locked_until: '2026-04-30' });
    assert.equal((await overview(sup.client)).lock.behind, false);
  });

  test('administratören attesterar allt', async () => {
    const o = await overview(admin);
    assert.equal(o.approvals.total, 4);
    assert.equal(o.is_admin, true);
    assert.ok(o.payroll);
  });
});
