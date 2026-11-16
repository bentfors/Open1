import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';
import { createUser } from './helpers.js';
import { setTodayForTests } from '../src/dates.js';

// Idag är 2026-06-10, så förvald månad är maj. Cia är BM och attesterar.
//   Anna (månadslön): 4/5 8 h Arbete, 5/5 8 h semester, 6/5 4 h sjuk + 4 h Arbete – attesterat. 7/5 8 h Arbete – inskickat.
//                     Utlägg 500 kr (varav moms 100) attesterat, utlägg 200 kr inskickat.
//                     Körning 100 km när milersättningen är 3 kr/km: 300 kr, varav 250 skattefritt (2,50 kr/km) och 50 skattepliktigt.
//   Olle (timlön):    4/5 4 h Utbildning, 5/5 4 h Möten – attesterat.
//   Ulf (underkonsult, inköp 700 kr/tim): 4/5 8 h Arbete på ACME-1 (1000 kr/tim) attesterat, 5/5 8 h inskickat.
describe('löneunderlag och underkonsulter', () => {
  let w, admin, anna, cia, eve, olle, ulf, sup, basic;
  const types = {};

  before(async () => {
    setTodayForTests('2026-06-10');
    w = await buildWorld();
    ({ anna, cia, eve } = w.users);
    admin = w.admin;
    sup = await createUser(w.app, admin, { email: 'sup@t.se', name: 'Sara Superuser', finance: 2 });
    basic = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: 1 });
    olle = await createUser(w.app, admin, { email: 'olle@t.se', name: 'Olle Student', weekly_hours: 20, bm_id: cia.id });
    ulf = await createUser(w.app, admin, { email: 'ulf@t.se', name: 'Ulf Underkonsult', bm_id: cia.id, cost_rate: 700, pay_type: 'subcontractor' });
    await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id });
    assert.equal((await sup.client.patch(`/api/users/${olle.id}`, { pay_type: 'hourly' })).status, 200, 'superusern sätter ersättningsform');
    await admin.put(`/api/projects/${w.p1}/members/${ulf.id}`, {});

    for (const t of (await admin.get('/api/absence-types')).json) types[t.name] = t.id;
    await admin.patch(`/api/absence-types/${types.Semester}`, { pay_code: '200' });
    await admin.patch(`/api/absence-types/${types.Sjukdom}`, { pay_code: '300' });
    await admin.patch('/api/settings', { pay_code_hours: '100', pay_code_expenses: '810', pay_code_mileage_free: '820', pay_code_mileage_taxable: '821', mileage_rate: 3 });

    const internal = (name) => w.app.db.prepare("SELECT a.id FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = 'INT-1' AND a.name = ?").get(name).id;
    const put = (who, date, target, minutes) => who.client.put('/api/time/entries', entry(date, target, minutes)).then((r) => assert.equal(r.status, 200, r.text));
    await put(anna, '2026-05-04', { activity_id: w.p1Activity }, 480);
    await put(anna, '2026-05-05', { absence_type_id: types.Semester }, 480);
    await put(anna, '2026-05-06', { absence_type_id: types.Sjukdom }, 240);
    await put(anna, '2026-05-06', { activity_id: w.p1Activity }, 240);
    await put(anna, '2026-05-07', { activity_id: w.p1Activity }, 480);
    await put(olle, '2026-05-04', { activity_id: internal('Utbildning') }, 240);
    await put(olle, '2026-05-05', { activity_id: internal('Möten') }, 240);
    await put(ulf, '2026-05-04', { activity_id: w.p1Activity }, 480);
    await put(ulf, '2026-05-05', { activity_id: w.p1Activity }, 480);
    for (const who of [anna, olle, ulf]) await who.client.post('/api/time/submit', { week_start: '2026-05-04' });

    const queue = (await cia.client.get('/api/approvals')).json;
    const timeIds = queue.time.filter((r) => (r.user_id === anna.id && r.date <= '2026-05-06') || r.user_id === olle.id || (r.user_id === ulf.id && r.date === '2026-05-04')).map((r) => r.id);
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'time', ids: timeIds, decision: 'approve' })).status, 200);

    const exp = await anna.client.post('/api/expenses', { date: '2026-05-08', description: 'Tåg', amount: 500, vat: 100 });
    await anna.client.post('/api/expenses', { date: '2026-05-09', description: 'Parkering', amount: 200 });
    const trip = await anna.client.post('/api/mileage', { date: '2026-05-11', purpose: 'Kundmöte', km: 100 });
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'approve' })).status, 200);
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'mileage', ids: [trip.json.id], decision: 'approve' })).status, 200);
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  test('löneunderlaget för förra månaden: avvikelser och ersättningar, bara attesterat', async () => {
    const r = await sup.client.get('/api/payroll');
    assert.equal(r.status, 200, r.text);
    const p = r.json;
    assert.deepEqual([p.month, p.from, p.to], ['2026-05', '2026-05-01', '2026-05-31']);
    assert.deepEqual(p.rows.map((x) => [x.name, x.pay_type]), [['Anna Konsult', 'monthly'], ['Olle Student', 'hourly']], 'underkonsulten och personer utan något att rapportera är inte med');
    const a = p.rows[0];
    assert.equal(a.worked_hours, 12, '8 + 4 attesterat, 7/5 är bara inskickat');
    assert.deepEqual(a.absence.map((x) => [x.name, x.pay_code, x.hours, x.days]), [['Semester', '200', 8, 1], ['Sjukdom', '300', 4, 1]]);
    assert.deepEqual(a.expenses, { count: 1, amount: 500, vat: 100 });
    assert.deepEqual(a.mileage, { count: 1, km: 100, amount: 300, taxfree: 250, taxable: 50 });
    assert.deepEqual(a.pending, { time_hours: 8, expenses: 1, mileage: 0 });
    assert.equal(p.rows[1].worked_hours, 8);
    assert.deepEqual(p.totals, { worked_hours: 20, absence: [{ name: 'Semester', hours: 8 }, { name: 'Sjukdom', hours: 4 }], expenses: 500, mileage_taxfree: 250, mileage_taxable: 50, pending_people: 1 });
  });

  test('en rad per person och löneart, milersättning i mil', async () => {
    const r = await sup.client.get('/api/payroll?month=2026-05&format=lines');
    assert.equal(r.status, 200);
    const lines = r.text.trimEnd().split('\r\n');
    assert.equal(lines[0], '﻿Namn;E-post;Ersättningsform;Löneart;Benämning;Antal;Enhet;Belopp');
    assert.deepEqual(lines.slice(1), [
      'Anna Konsult;anna@t.se;Månadslön;200;Semester;8;tim;',
      'Anna Konsult;anna@t.se;Månadslön;300;Sjukdom;4;tim;',
      'Anna Konsult;anna@t.se;Månadslön;810;Utlägg (1 st, varav moms 100);1;st;500',
      'Anna Konsult;anna@t.se;Månadslön;820;Milersättning, skattefri;10;mil;250',
      'Anna Konsult;anna@t.se;Månadslön;821;Milersättning, skattepliktig del;10;mil;50',
      'Olle Student;olle@t.se;Timlön;100;Arbetade timmar;8;tim;',
    ]);
  });

  test('sammanställning per person som CSV', async () => {
    const r = await sup.client.get('/api/payroll?month=2026-05&format=csv');
    const [head, anna_] = r.text.trimEnd().split('\r\n');
    assert.equal(head, '﻿Namn;E-post;Ersättningsform;Arbetade timmar;Semester (tim);Semester (dagar);Sjukdom (tim);Sjukdom (dagar);Utlägg;Varav moms;Körda km;Milersättning skattefri;Milersättning skattepliktig;Ej attesterat (tim)');
    assert.equal(anna_, 'Anna Konsult;anna@t.se;Månadslön;12;8;1;4;1;500;100;100;250;50;8');
  });

  test('inköpsunderlag för underkonsulter: attesterade timmar × inköpspris', async () => {
    const r = await basic.client.get('/api/subcontractors?month=2026-05');
    assert.equal(r.status, 200, 'ekonomi på lägre nivå får se inköpen');
    const [u] = r.json.rows;
    assert.deepEqual([u.name, u.hours, u.cost, u.revenue, u.margin, u.pending_hours], ['Ulf Underkonsult', 8, 5600, 8000, 2400, 8]);
    assert.deepEqual(u.projects, [{ project_id: w.p1, project: 'ACME-1 Plattform', customer: 'Acme AB', hours: 8, cost: 5600, revenue: 8000, pending_hours: 8 }]);
    assert.deepEqual(r.json.totals, { hours: 8, cost: 5600, revenue: 8000, margin: 2400, pending_hours: 8 });
    const csv = await basic.client.get('/api/subcontractors?month=2026-05&format=csv');
    assert.ok(csv.text.includes('Ulf Underkonsult;ACME-1 Plattform;Acme AB;8;5600;8000;8'));
    assert.equal((await basic.client.get('/api/subcontractors?month=2026-04')).json.rows.length, 0);
  });

  test('vem som ser vad', async () => {
    assert.equal((await basic.client.get('/api/payroll')).status, 403, 'löneunderlaget innehåller sjukfrånvaro');
    assert.equal((await admin.get('/api/payroll')).status, 200);
    for (const who of [anna, cia, eve]) {
      assert.equal((await who.client.get('/api/payroll')).status, 403);
      assert.equal((await who.client.get('/api/subcontractors')).status, 403);
    }
    for (const bad of ['?month=2026-13', '?month=maj', '?month=2026-5']) assert.equal((await sup.client.get(`/api/payroll${bad}`)).status, 400, bad);
  });

  test('ersättningsform och löneart loggas och valideras', async () => {
    const log = (await admin.get(`/api/audit?entity=user&user_id=${olle.id}&action=update`)).json.rows;
    assert.ok(log.some((r) => r.changes.some((c) => c.field === 'Ersättningsform' && c.from === 'Månadslön' && c.to === 'Timlön')));
    assert.equal((await admin.patch(`/api/users/${olle.id}`, { pay_type: 'provision' })).status, 400);
    assert.equal((await sup.client.patch(`/api/absence-types/${types.Semester}`, { pay_code: '999' })).status, 403);
    assert.equal((await admin.patch(`/api/absence-types/${types.Semester}`, { pay_code: 'x'.repeat(21) })).status, 400);
  });
});
