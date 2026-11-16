import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';
import { createUser } from './helpers.js';
import { setTodayForTests } from '../src/dates.js';

// Idag är 2026-06-10, förvald månad maj. Anna har 1200 kr/tim på ACME-1, Beta har 800 kr/tim.
//   Acme: 28/4 4 h (äldre, ofakturerat) + 4/5 8 h attesterat = 12 h × 1200 = 14 400, plus utlägg 500 = 14 900.
//         5/5 4 h på fastprisprojektet ACME-2. 7/5 8 h inskickat (väntar, 9600). 8/5 2 h utkast. 2/6 8 h efter månaden.
//   Beta: 6/5 8 h × 800 = 6400, plus körning 50 km × 2,50 = 125, totalt 6525.
describe('månadsfakturering', () => {
  let w, admin, anna, basic, beta, betaProject;

  before(async () => {
    setTodayForTests('2026-06-10');
    w = await buildWorld();
    anna = w.users.anna;
    admin = w.admin;
    basic = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: 1 });
    beta = (await admin.post('/api/customers', { name: 'Beta AB' })).json.id;
    betaProject = (await admin.post('/api/projects', { customer_id: beta, code: 'BETA-1', name: 'Integration', billing_type: 'hourly', hourly_rate: 800 })).json.id;
    await admin.put(`/api/projects/${betaProject}/members/${anna.id}`, {});
    const betaActivity = (await admin.get(`/api/projects/${betaProject}`)).json.activities[0].id;

    const put = (date, target, minutes) => anna.client.put('/api/time/entries', entry(date, target, minutes)).then((r) => assert.equal(r.status, 200, r.text));
    await put('2026-04-28', { activity_id: w.p1Activity }, 240);
    await put('2026-05-04', { activity_id: w.p1Activity }, 480);
    await put('2026-05-05', { activity_id: w.p2Activity }, 240);
    await put('2026-05-06', { activity_id: betaActivity }, 480);
    await put('2026-05-07', { activity_id: w.p1Activity }, 480);
    await put('2026-06-02', { activity_id: w.p1Activity }, 480);
    for (const week of ['2026-04-27', '2026-05-04', '2026-06-01']) await anna.client.post('/api/time/submit', { week_start: week });
    await put('2026-05-08', { activity_id: w.p1Activity }, 120); // utkast efter inskick

    const exp = await anna.client.post('/api/expenses', { date: '2026-05-12', description: 'Hotell', amount: 500, project_id: w.p1, billable: true });
    const trip = await anna.client.post('/api/mileage', { date: '2026-05-13', purpose: 'Workshop', km: 50, project_id: betaProject, billable: true });
    const queue = (await admin.get('/api/approvals')).json;
    const ids = queue.time.filter((r) => r.date !== '2026-05-07').map((r) => r.id);
    assert.equal((await admin.post('/api/approvals/decide', { kind: 'time', ids, decision: 'approve' })).status, 200);
    await admin.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'approve' });
    await admin.post('/api/approvals/decide', { kind: 'mileage', ids: [trip.json.id], decision: 'approve' });

    // Nummer i ekonomisystemet
    await admin.patch(`/api/customers/${w.customer}`, { ext_no: '1001' });
    await admin.patch(`/api/activities/${w.p1Activity}`, { article_no: 'KONS' });
    await admin.patch('/api/settings', { article_no_expense: 'UTL', article_no_mileage: 'BIL' });
    const lkp = (await admin.post('/api/cost-centers', { code: 'LKP', name: 'Linköping' })).json.id;
    await admin.patch(`/api/users/${anna.id}`, { cost_center_id: lkp });
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  const preview = async (q = '') => {
    const r = await basic.client.get(`/api/billing/month${q}`);
    assert.equal(r.status, 200, r.text);
    return r.json;
  };

  test('förhandsvisning per kund för förra månaden, med äldre ofakturerat och det som inte är klart', async () => {
    const m = await preview();
    assert.deepEqual([m.month, m.from, m.to, m.include_older], ['2026-05', '2026-05-01', '2026-05-31', true]);
    assert.deepEqual(m.rows.map((r) => r.customer_name), ['Acme AB', 'Beta AB']);
    const acme = m.rows[0];
    assert.deepEqual(
      [acme.ext_no, acme.projects, acme.ready_rows, acme.ready, acme.older, acme.waiting, acme.draft_hours, acme.fixed_hours],
      ['1001', 1, 3, 14900, 4800, 9600, 2, 4],
    );
    assert.deepEqual([m.rows[1].ready, m.rows[1].ready_rows, m.rows[1].waiting], [6525, 2, 0]);
    assert.deepEqual(m.totals, { ready: 21425, older: 4800, waiting: 9600, draft_hours: 2, fixed_hours: 4, customers: 2 });
  });

  test('utan äldre: bara det som avser månaden', async () => {
    const m = await preview('?include_older=0');
    assert.deepEqual([m.include_older, m.rows[0].ready, m.rows[0].older], [false, 10100, 0], '9600 + 500');
  });

  test('ett underlag per kund i ett steg, allt eller inget', async () => {
    const none = await basic.client.post('/api/billing/month', { month: '2026-05', customer_ids: [w.customer, 9999] });
    assert.equal(none.status, 400, 'en okänd kund stoppar hela körningen');
    assert.equal((await basic.client.get('/api/invoices')).json.length, 0);

    const r = await basic.client.post('/api/billing/month', { month: '2026-05', invoice_date: '2026-06-01', customer_ids: [w.customer, beta] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.created.map((c) => [c.customer_name, c.total]), [['Acme AB', 14900], ['Beta AB', 6525]]);
    assert.equal(r.json.total, 21425);
    const invoices = (await basic.client.get('/api/invoices')).json;
    const acme = invoices.find((i) => i.customer_id === w.customer);
    assert.deepEqual([acme.invoice_date, acme.period_from, acme.period_to, acme.note], ['2026-06-01', '2026-04-28', '2026-05-12', 'Månadsfakturering 2026-05']);

    // Efteråt: Acme har bara det som inte var klart kvar, Beta inget alls.
    const after_ = await preview();
    assert.deepEqual(after_.rows.map((x) => [x.customer_name, x.ready, x.waiting]), [['Acme AB', 0, 9600]]);
    const again = await basic.client.post('/api/billing/month', { month: '2026-05', customer_ids: [w.customer] });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /Acme AB har inget att fakturera/);
    const log = (await admin.get('/api/audit?entity=invoice&action=create')).json.rows;
    assert.equal(log.length, 2);
    assert.equal(log[0].actor_name, 'Ella Ekonomi');
  });

  test('underlaget har kundnummer, artikelnummer och projektnummer per rad', async () => {
    const acme = (await basic.client.get('/api/invoices')).json.find((i) => i.customer_id === w.customer);
    const csv = (await basic.client.get(`/api/invoices/${acme.id}?format=csv`)).text.trimEnd().split('\r\n');
    assert.equal(csv[0], '﻿Kundnummer;Typ;Artikelnummer;Projektnummer;Kostnadsställe;Projekt;Beskrivning;Antal;Enhet;À-pris;Belopp');
    assert.deepEqual(csv.slice(1), [
      '1001;Tid;KONS;ACME-1;LKP;ACME-1 Plattform;Arbete – Anna Konsult;12;tim;1200;14400',
      '1001;Utlägg;UTL;ACME-1;LKP;ACME-1 Plattform;2026-05-12 Hotell (Anna Konsult);1;st;500;500',
      ';;;;;;Summa;;;;14900',
    ]);
    const beta_ = (await basic.client.get('/api/invoices')).json.find((i) => i.customer_id === beta);
    const lines = (await basic.client.get(`/api/invoices/${beta_.id}`)).json.lines;
    assert.deepEqual(lines.map((l) => [l.kind, l.article_no, l.project_code, l.amount]), [['Tid', '', 'BETA-1', 6400], ['Körning', 'BIL', 'BETA-1', 125]]);
  });

  test('validering och behörighet', async () => {
    assert.equal((await basic.client.post('/api/billing/month', { month: '2026-05', customer_ids: [] })).status, 400);
    assert.equal((await basic.client.post('/api/billing/month', { month: '2026-13', customer_ids: [beta] })).status, 400);
    assert.equal((await basic.client.get('/api/billing/month?month=maj')).status, 400);
    assert.equal((await anna.client.get('/api/billing/month')).status, 403);
    assert.equal((await anna.client.post('/api/billing/month', { customer_ids: [beta] })).status, 403);
    assert.equal((await admin.patch(`/api/customers/${beta}`, { ext_no: 'x'.repeat(31) })).status, 400);
  });
});
