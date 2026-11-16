import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, addTime } from './world.js';
import { createUser } from './helpers.js';
import { setTodayForTests } from '../src/dates.js';

// Idag är 2026-03-16. Beläggning 100 %, kostnad på all projekttid.
//   Anna (KST LKP, 500 kr/tim): uppdrag 1 jan–30 jun, 1200 kr/tim, 40 tim. Attesterat: 12/1, 2/2 och 2/3, 8 h var (9600 / TB 5600).
//   Olle (KST STH, 20 tim, 300 kr/tim): inget uppdrag. Attesterat 13/1 4 h internt (TB −1200). Prognos: bänk 4 h/dag.
//   Pia (inget KST, 400 kr/tim): uppdrag från 1 april, 1000 kr/tim, 40 tim. Bänk i mars.
// Arbetsdagar 2026: mar 22, apr 20, maj 19, jun 21, jul 23, aug 21, sep 22, okt 22, nov 21, dec 20.
describe('kostnadsställen och budget', () => {
  let w, admin, anna, cia, sup, basic, olle, pia, lkp, sth;

  before(async () => {
    setTodayForTests('2026-03-16');
    w = await buildWorld();
    ({ anna, cia } = w.users);
    admin = w.admin;
    sup = await createUser(w.app, admin, { email: 'sup@t.se', name: 'Sara Superuser', finance: 2 });
    basic = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: 1 });
    await admin.patch('/api/settings', { forecast_utilization: 100 });

    lkp = (await admin.post('/api/cost-centers', { code: 'LKP', name: 'Linköping' })).json.id;
    sth = (await admin.post('/api/cost-centers', { code: 'STH', name: 'Stockholm' })).json.id;
    olle = await createUser(w.app, admin, { email: 'olle@t.se', name: 'Olle Student', weekly_hours: 20, cost_rate: 300, bm_id: cia.id, cost_center_id: sth });
    pia = await createUser(w.app, admin, { email: 'pia@t.se', name: 'Pia Next', cost_rate: 400, bm_id: cia.id });
    assert.equal((await sup.client.patch(`/api/users/${anna.id}`, { bm_id: cia.id, cost_center_id: lkp })).status, 200);

    await admin.post('/api/employments', { user_id: anna.id, start_date: '2020-01-01' });
    await admin.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, project_id: w.p1, start_date: '2026-01-01', end_date: '2026-06-30', hourly_rate: 1200, hours_per_week: 40 });
    await admin.post('/api/assignments', { user_id: pia.id, customer_id: w.customer, start_date: '2026-04-01', hourly_rate: 1000, hours_per_week: 40 });

    for (const date of ['2026-01-12', '2026-02-02', '2026-03-02']) addTime(w, { user_id: anna.id, date, activity_id: w.p1Activity, minutes: 480 });
    const meetings = w.app.db.prepare("SELECT a.id FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = 'INT-1' AND a.name = 'Möten'").get().id;
    addTime(w, { user_id: olle.id, date: '2026-01-13', activity_id: meetings, minutes: 240 });

    const months = (revenue, margin, list) => list.map((m) => ({ month: m, revenue, margin }));
    const all = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
    assert.equal((await sup.client.put('/api/budget', { year: 2026, kst: lkp, months: months(100000, 40000, all) })).status, 200);
    assert.equal((await sup.client.put('/api/budget', { year: 2026, kst: sth, months: months(50000, 10000, ['2026-01']) })).status, 200);
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  const view = async (q) => {
    const r = await sup.client.get(`/api/budget?year=2026${q}`);
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const month = (v, m) => v.months.find((x) => x.month === m);

  test('budget, utfall och prognos per månad för ett kostnadsställe', async () => {
    const v = await view(`&kst=${lkp}`);
    const jan = month(v, '2026-01');
    assert.deepEqual([jan.state, jan.budget, jan.actual, jan.forecast, jan.deviation], ['past', { revenue: 100000, margin: 40000 }, { revenue: 9600, margin: 5600, hours: 8 }, null, { revenue: -90400, margin: -34400 }]);
    const mar = month(v, '2026-03');
    assert.deepEqual([mar.state, mar.actual.revenue, mar.forecast], ['current', 9600, { revenue: 211200, margin: 123200 }], 'mars: 22 × 9600 och 22 × 5600');
    assert.deepEqual(month(v, '2026-06').forecast, { revenue: 201600, margin: 117600 }, '21 dagar, midsommarafton är ledig');
    assert.deepEqual(month(v, '2026-07').forecast, { revenue: 0, margin: -92000 }, 'uppdraget slut, 23 dagars bänk × 4000');
    assert.deepEqual(month(v, '2026-12').forecast, { revenue: 0, margin: -80000 });
    assert.equal(month(v, '2026-07').actual, null);
    // Helår: utfall jan–feb, prognos mars–dec.
    assert.deepEqual(v.totals.budget, { revenue: 1200000, margin: 480000 });
    assert.deepEqual(v.totals.actual, { revenue: 28800, margin: 16800 });
    assert.deepEqual(v.totals.outcome, { revenue: 806400, margin: -45600 });
    assert.deepEqual(v.totals.deviation, { revenue: -393600, margin: -525600 });
  });

  test('andra kostnadsställen, utan kostnadsställe och alla tillsammans', async () => {
    const s = await view(`&kst=${sth}`);
    assert.deepEqual([month(s, '2026-01').budget, month(s, '2026-01').actual], [{ revenue: 50000, margin: 10000 }, { revenue: 0, margin: -1200, hours: 0 }]);
    assert.deepEqual(month(s, '2026-03').forecast, { revenue: 0, margin: -26400 }, '22 dagar × 4 h × 300');
    const none = await view('&kst=0');
    assert.deepEqual([month(none, '2026-03').forecast, month(none, '2026-04').forecast], [{ revenue: 0, margin: -70400 }, { revenue: 160000, margin: 96000 }], 'Pia: bänk i mars, uppdrag från april');
    const all = await view('');
    assert.deepEqual(month(all, '2026-01').budget, { revenue: 150000, margin: 50000 });
    assert.deepEqual(month(all, '2026-03').forecast, { revenue: 211200, margin: 26400 }, '123 200 − 26 400 − 70 400');
  });

  test('ändringar i budgeten loggas, och bara superuser och administratörer ser och ändrar den', async () => {
    const log = (await admin.get('/api/audit?entity=budget')).json.rows;
    const lkpRow = log.find((r) => r.label === 'Budget 2026, LKP Linköping');
    assert.ok(lkpRow);
    assert.equal(lkpRow.changes.length, 24, '12 månader × intäkt och TB');
    assert.equal(lkpRow.changes[0].field, '2026-01 intäkt');
    assert.match(lkpRow.changes[0].to, /^100\s000$/u);
    for (const who of [basic, anna, cia]) {
      assert.equal((await who.client.get('/api/budget?year=2026')).status, 403);
      assert.equal((await who.client.put('/api/budget', { year: 2026, kst: lkp, months: [{ month: '2026-01', revenue: 1, margin: 1 }] })).status, 403);
    }
    const bad = async (body, why) => assert.equal((await sup.client.put('/api/budget', { year: 2026, kst: lkp, ...body })).status, 400, why);
    await bad({ months: [{ month: '2027-01', revenue: 1, margin: 1 }] }, 'fel år');
    await bad({ months: [{ month: '2026-01', revenue: -1, margin: 1 }] }, 'negativ intäkt');
    await bad({ months: [{ month: '2026-01', revenue: 1, margin: 1 }, { month: '2026-01', revenue: 2, margin: 2 }] }, 'samma månad två gånger');
    await bad({ months: [] }, 'inga månader');
    await bad({ kst: '', months: [{ month: '2026-01', revenue: 1, margin: 1 }] }, 'kostnadsställe saknas');
    await bad({ kst: 999, months: [{ month: '2026-01', revenue: 1, margin: 1 }] }, 'okänt kostnadsställe');
    assert.equal((await sup.client.put('/api/budget', { year: 2026, kst: 0, months: [{ month: '2026-02', revenue: 1000, margin: -500 }] })).status, 200, 'negativt TB och utan kostnadsställe går bra');
  });

  test('kostnadsställen: register, användare och rapporter', async () => {
    assert.equal((await admin.post('/api/cost-centers', { code: 'lkp', name: 'Dubblett' })).status, 409, 'koden är unik oavsett skiftläge');
    assert.equal((await admin.del(`/api/cost-centers/${lkp}`)).status, 409, 'används av Anna');
    const tmp = (await admin.post('/api/cost-centers', { code: 'TMP', name: 'Tillfälligt' })).json.id;
    assert.equal((await admin.del(`/api/cost-centers/${tmp}`)).status, 200);
    assert.equal((await sup.client.post('/api/cost-centers', { code: 'X', name: 'X' })).status, 403);
    assert.equal((await admin.patch(`/api/users/${pia.id}`, { cost_center_id: 999 })).status, 400);
    const users = (await admin.get('/api/users')).json;
    assert.equal(users.find((u) => u.id === anna.id).cost_center_name, 'Linköping');
    const list = (await anna.client.get('/api/cost-centers')).json;
    assert.deepEqual(list.map((c) => [c.code, c.users]), [['LKP', 1], ['STH', 1]]);

    const time = (await sup.client.get('/api/reports/time?from=2026-01-01&to=2026-03-31&group_by=kst')).json;
    assert.deepEqual(time.rows.map((r) => [r.label, r.hours, r.revenue]), [['LKP Linköping', 24, 28800], ['STH Stockholm', 4, 0]]);
    const util = (await sup.client.get('/api/reports/utilization?from=2026-01-01&to=2026-02-28&group_by=kst')).json;
    assert.deepEqual(util.rows.map((r) => [r.label, r.billable_hours]), [['(inget kostnadsställe)', 0], ['LKP Linköping', 16], ['STH Stockholm', 0]]);
    const log = (await admin.get(`/api/audit?entity=user&user_id=${anna.id}`)).json.rows;
    assert.ok(log.some((r) => r.changes.some((c) => c.field === 'Kostnadsställe' && c.to === 'LKP Linköping')));
  });
});
