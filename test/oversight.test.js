import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';
import { createUser } from './helpers.js';
import { setTodayForTests } from '../src/dates.js';

// Idag är onsdag 2026-05-20 (vecka 21). Vecka 20 har Kristi himmelsfärd på torsdagen, maj har 19 arbetsdagar.
// Cia är BM för Anna (40 tim), Olle (20 tim, student) och Pia (40 tim). Carl är Annas chef.
//   Anna v19: 5 × 8 h Arbete (debiterbart, 1200 kr), attesterat.  v20: 3 × 8 h Arbete + 8 h semester, inskickat.
//   Olle v19: 4 h Utbildning, inskickat och avslaget.             v20: 4 h Möten (internt), utkast.
//   Pia:      ingenting.
describe('inrapportering och debiteringsgrad', () => {
  let w, admin, anna, carl, cia, eve, olle, pia, sup;
  const act = {};

  before(async () => {
    setTodayForTests('2026-05-20');
    w = await buildWorld();
    ({ anna, carl, cia, eve } = w.users);
    admin = w.admin;
    olle = await createUser(w.app, admin, { email: 'olle@t.se', name: 'Olle Student', weekly_hours: 20, bm_id: cia.id });
    pia = await createUser(w.app, admin, { email: 'pia@t.se', name: 'Pia Next', bm_id: cia.id });
    sup = await createUser(w.app, admin, { email: 'sup@t.se', name: 'Sara Superuser', finance: 2 });
    await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id });
    const internal = (name) => w.app.db.prepare("SELECT a.id FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = 'INT-1' AND a.name = ?").get(name).id;
    act.training = internal('Utbildning');
    act.meetings = internal('Möten');

    const put = (who, date, target, minutes) => who.client.put('/api/time/entries', entry(date, target, minutes)).then((r) => assert.equal(r.status, 200, r.text));
    for (const d of ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']) await put(anna, d, { activity_id: w.p1Activity }, 480);
    for (const d of ['2026-05-11', '2026-05-12', '2026-05-13']) await put(anna, d, { activity_id: w.p1Activity }, 480);
    await put(anna, '2026-05-15', { absence_type_id: w.vacation }, 480);
    await anna.client.post('/api/time/submit', { week_start: '2026-05-04' });
    await anna.client.post('/api/time/submit', { week_start: '2026-05-11' });
    const queue = (await cia.client.get('/api/approvals')).json.time;
    const week19 = queue.filter((r) => r.user_id === anna.id && r.date <= '2026-05-08').map((r) => r.id);
    assert.equal(week19.length, 5);
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'time', ids: week19, decision: 'approve' })).status, 200);

    await put(olle, '2026-05-04', { activity_id: act.training }, 240);
    await olle.client.post('/api/time/submit', { week_start: '2026-05-04' });
    const olles = (await cia.client.get('/api/approvals')).json.time.filter((r) => r.user_id === olle.id).map((r) => r.id);
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'time', ids: olles, decision: 'reject', note: 'Fel aktivitet' })).status, 200);
    await put(olle, '2026-05-11', { activity_id: act.meetings }, 240);
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  const status = async (who, q = '?weeks=3') => (await who.client.get(`/api/reports/submission${q}`)).json;
  const cell = (data, name, start) => data.people.find((p) => p.name === name).weeks.find((x) => x.start === start);

  test('inrapportering vecka för vecka, för BM:s konsulter', async () => {
    const data = await status(cia);
    assert.deepEqual(data.weeks.map((x) => [x.start, x.week, x.current]), [['2026-05-04', 19, false], ['2026-05-11', 20, false], ['2026-05-18', 21, true]]);
    assert.deepEqual(data.people.map((p) => p.name), ['Anna Konsult', 'Olle Student', 'Pia Next'], 'Cia själv rapporterar inte och är inte med');
    const show = (name) => data.people.find((p) => p.name === name).weeks.map((x) => x.status);
    assert.deepEqual(show('Anna Konsult'), ['approved', 'submitted', 'missing']);
    assert.deepEqual(show('Olle Student'), ['rejected', 'draft', 'missing']);
    assert.deepEqual(show('Pia Next'), ['missing', 'missing', 'missing']);
    assert.deepEqual(cell(data, 'Anna Konsult', '2026-05-11'), { start: '2026-05-11', status: 'submitted', norm_hours: 32, reported_hours: 32, short_hours: 0 }, 'Kristi himmelsfärd');
    assert.deepEqual([cell(data, 'Olle Student', '2026-05-11').norm_hours, cell(data, 'Olle Student', '2026-05-11').short_hours], [16, 12], '4 dagar × 4 h, 4 h rapporterat');
    // Innevarande vecka räknas inte som försenad.
    assert.deepEqual(data.counts, { missing: 2, draft: 1, rejected: 1, submitted: 1 });
  });

  test('vem som ser vem', async () => {
    assert.deepEqual((await status(carl)).people.map((p) => p.name), ['Anna Konsult'], 'chefen ser sin underställda');
    assert.deepEqual((await status(anna)).people.map((p) => p.name), ['Anna Konsult'], 'konsulten ser bara sig själv');
    assert.deepEqual((await status(eve)).people, [], 'ingen BM, inget avtal, ingen tid');
    assert.deepEqual((await status(sup)).people.map((p) => p.name), ['Anna Konsult', 'Olle Student', 'Pia Next'], 'ekonomi ser alla som förväntas rapportera');
    const me = async (who) => (await who.client.get('/api/auth/me')).json.user.oversees;
    assert.deepEqual([await me(cia), await me(carl), await me(anna), await me(sup)], [true, true, false, false]);
  });

  test('antal veckor valideras', async () => {
    for (const q of ['?weeks=0', '?weeks=27', '?weeks=x', '?to=igår']) assert.equal((await cia.client.get(`/api/reports/submission${q}`)).status, 400, q);
    assert.equal((await status(cia, '?weeks=1')).weeks.length, 1);
  });

  const util = async (who, q) => {
    const r = await who.client.get(`/api/reports/utilization?from=2026-05-01&to=2026-05-31${q ?? ''}`);
    assert.equal(r.status, 200, r.text);
    return r.json;
  };

  test('debiteringsgrad per person: debiterbart av normtid minus frånvaro', async () => {
    const data = await util(cia);
    const anna_ = data.rows.find((r) => r.label === 'Anna Konsult');
    // Maj: 19 arbetsdagar × 8 h = 152 h. 8 h semester ger 144 h tillgänglig tid. 64 h debiterbart.
    assert.deepEqual(
      [anna_.norm_hours, anna_.absence_hours, anna_.available_hours, anna_.worked_hours, anna_.billable_hours, anna_.utilization, anna_.of_norm],
      [152, 8, 144, 64, 64, 44.44, 42.11],
    );
    const olle_ = data.rows.find((r) => r.label === 'Olle Student');
    assert.deepEqual([olle_.norm_hours, olle_.worked_hours, olle_.internal_hours, olle_.utilization], [76, 4, 4, 0], 'avslagen tid räknas inte');
    // Totalt: normtid 152 + 76 + 152 = 380, frånvaro 8, debiterbart 64 → 64 / 372.
    assert.deepEqual([data.total.people, data.total.norm_hours, data.total.available_hours, data.total.billable_hours, data.total.utilization, data.total.of_norm], [3, 380, 372, 64, 17.2, 16.84]);
    assert.equal('revenue' in anna_, false, 'BM ser inga pengar');
  });

  test('bara attesterad tid', async () => {
    const data = await util(cia, '&status=approved');
    const anna_ = data.rows.find((r) => r.label === 'Anna Konsult');
    assert.deepEqual([anna_.absence_hours, anna_.billable_hours, anna_.utilization], [0, 40, 26.32], 'v20 och semestern är inte attesterade: 40 / 152');
    assert.equal(data.total.utilization, 10.53, '40 / 380');
  });

  test('gruppering per BM och månad, och pengar för ekonomi', async () => {
    const byBm = await util(sup, '&group_by=bm');
    assert.deepEqual(byBm.rows.map((r) => [r.label, r.people, r.billable_hours, r.utilization]), [['Cia BM', 3, 64, 17.2]]);
    assert.deepEqual([byBm.total.revenue, byBm.total.avg_rate], [76800, 1200], '64 h × 1200');
    const r = await sup.client.get('/api/reports/utilization?from=2026-04-01&to=2026-05-31&group_by=month');
    assert.deepEqual(r.json.rows.map((x) => [x.label, x.norm_hours, x.billable_hours, x.utilization]), [['2026-04', 400, 0, 0], ['2026-05', 380, 64, 17.2]], 'april: 20 arbetsdagar');
    const byCategory = await util(sup, '&group_by=category');
    assert.deepEqual(byCategory.rows.map((x) => x.label), ['(ingen kategori)', 'Konsult Expert']);
  });

  test('vem som räknas: konsulter som standard, alla på begäran', async () => {
    assert.deepEqual((await util(sup)).rows.map((r) => r.label), ['Anna Konsult', 'Olle Student', 'Pia Next']);
    const everyone = (await util(sup, '&everyone=1')).rows.map((r) => r.label);
    assert.ok(everyone.includes('Carl Chef') && everyone.includes('Administratör'));
    assert.deepEqual((await util(carl)).rows.map((r) => r.label), ['Anna Konsult']);
    assert.deepEqual((await util(anna)).rows.map((r) => r.label), ['Anna Konsult']);
    assert.deepEqual((await util(eve)).rows, []);
    assert.deepEqual((await util(sup, `&bm_id=${cia.id}`)).rows.length, 3);
    assert.deepEqual((await util(sup, `&bm_id=${carl.id}`)).rows.length, 0);
  });

  test('CSV och validering', async () => {
    const csv = await sup.client.get('/api/reports/utilization?from=2026-05-01&to=2026-05-31&format=csv');
    assert.equal(csv.status, 200);
    assert.ok(csv.text.startsWith('﻿Person;Kategori;BM;Normtid;Frånvaro;Tillgänglig tid;Projekttid;Debiterbart;Ej debiterbart;Debiteringsgrad %'));
    assert.ok(csv.text.includes('Anna Konsult;Konsult Expert;Cia BM;152;8;144;64;64;0;44,44;42,11;76800;1200'));
    assert.equal((await sup.client.get('/api/reports/utilization?from=2024-01-01&to=2026-05-31')).status, 400, 'högst två år');
    assert.equal((await sup.client.get('/api/reports/utilization?from=2026-05-01')).status, 400);
  });
});
