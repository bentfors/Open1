import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, seedApprovedWeek, entry } from './world.js';
import { toCsv } from '../src/csv.js';

describe('tidrapporter och TB per konsult', () => {
  let w, anna, dan, eve, carl, admin;

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, eve, carl } = w.users);
    admin = w.admin;
    await seedApprovedWeek(w);
  });
  after(() => w.close());

  const range = 'from=2025-03-01&to=2025-03-31';

  test('tidrapport per projekt: admin ser pengar, räknat för hand', async () => {
    const r = (await admin.get(`/api/reports/time?${range}&group_by=project`)).json;
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    assert.equal(byLabel['ACME-1 Plattform'].hours, 10);
    assert.equal(byLabel['ACME-1 Plattform'].billable_hours, 8);
    assert.equal(byLabel['ACME-1 Plattform'].revenue, 9600);
    assert.equal(byLabel['ACME-1 Plattform'].cost, 5000);
    assert.equal(byLabel['ACME-2 Fastpris'].revenue, 3600);
    assert.equal(byLabel['(frånvaro)'].hours, 8);
    assert.equal(byLabel['(frånvaro)'].cost, 0, 'frånvaro har ingen projektkostnad');
    assert.equal(r.total.hours, 22);
    assert.equal(r.total.revenue, 13200);
  });

  test('tidrapport per kategori och per månad', async () => {
    const cat = (await admin.get(`/api/reports/time?${range}&group_by=category`)).json.rows;
    assert.equal(cat.find((x) => x.label === 'Konsult Expert').hours, 22);
    const month = (await admin.get(`/api/reports/time?${range}&group_by=month`)).json.rows;
    assert.deepEqual(month.map((m) => m.label), ['2025-03']);
  });

  test('övriga ser tid men aldrig pengar, och bara det de har rätt till', async () => {
    const own = (await anna.client.get(`/api/reports/time?${range}&group_by=project`)).json;
    assert.equal(own.total.hours, 22);
    assert.equal('revenue' in own.total, false);
    assert.equal('revenue' in own.rows[0], false);
    assert.equal('cost' in own.rows[0], false);

    const pm = (await dan.client.get(`/api/reports/time?${range}&group_by=project`)).json;
    assert.deepEqual(pm.rows.map((r) => r.label), ['ACME-1 Plattform'], 'projektledaren ser bara sitt projekt');
    assert.equal((await carl.client.get(`/api/reports/time?${range}&group_by=user`)).json.total.hours, 22, 'chefen ser sin underställda');
    assert.equal((await eve.client.get(`/api/reports/time?${range}&group_by=user`)).json.rows.length, 0);
  });

  test('filter: debiterbar, och ogiltiga perioder', async () => {
    assert.equal((await admin.get(`/api/reports/time?${range}&group_by=user&billable=yes`)).json.total.hours, 12);
    assert.equal((await admin.get('/api/reports/time?from=2025-03-31&to=2025-03-01')).status, 400);
    assert.equal((await admin.get('/api/reports/time?from=2025-03-01')).status, 400);
    assert.equal((await admin.get(`/api/reports/time?${range}&billable=maybe`)).status, 400);
  });

  test('TB per konsult: intäkt 13200 − kostnad 7000 = 6200', async () => {
    const a = (await admin.get(`/api/reports/margin?${range}`)).json.consultants.find((c) => c.name === 'Anna Konsult');
    assert.equal(a.revenue, 13200);
    assert.equal(a.cost, 7000);
    assert.equal(a.margin, 6200);
    assert.equal(a.hours, 14, 'frånvaro räknas inte');
    assert.equal(a.category, 'Konsult Expert');
  });

  test('inställningen "bara debiterbar kostnad" ändrar TB till 7200', async () => {
    await admin.patch('/api/settings', { tb_cost_basis: 'billable' });
    assert.equal((await admin.get(`/api/reports/margin?${range}`)).json.consultants[0].margin, 7200);
    await admin.patch('/api/settings', { tb_cost_basis: 'worked' });
  });

  test('TB visas bara för administratörer', async () => {
    assert.deepEqual((await anna.client.get(`/api/reports/margin?${range}`)).json.consultants, []);
  });

  test('ej godkänd tid ingår först när man ber om det', async () => {
    await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 60));
    assert.equal((await admin.get(`/api/reports/margin?${range}`)).json.consultants[0].margin, 6200);
    assert.equal((await admin.get(`/api/reports/margin?${range}&status=all`)).json.consultants[0].margin, 6900, '1 h × (1200 − 500)');
    await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 0));
  });
});

describe('utlägg och kvitton', () => {
  let w, anna, dan, eve, admin;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, eve } = w.users);
    admin = w.admin;
  });
  after(() => w.close());

  const base = { date: '2025-03-04', description: 'Lunch', amount: 120 };

  test('kvitto måste vara bild eller PDF, bedömt på innehållet', async () => {
    const fake = await anna.client.post('/api/expenses', {
      ...base,
      receipt: { name: 'kvitto.pdf', data: Buffer.from('<script>alert(1)</script>').toString('base64') },
    });
    assert.equal(fake.status, 400);

    const ok = await anna.client.post('/api/expenses', { ...base, receipt: { name: '../../etc/x.png', data: PNG.toString('base64') } });
    assert.equal(ok.status, 200);
    const list = (await anna.client.get('/api/expenses')).json;
    assert.equal(list[0].has_receipt, 1);
    assert.doesNotMatch(list[0].receipt_name, /\//, 'filnamnet saneras');
  });

  test('kvitto ses av ägare, admin och attestant men inte av andra', async () => {
    const exp = await anna.client.post('/api/expenses', { ...base, project_id: w.p1, receipt: { name: 'k.png', data: PNG.toString('base64') } });
    const url = `/api/expenses/${exp.json.id}/receipt`;
    const own = await anna.client.get(url);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await admin.get(url)).status, 200);
    assert.equal((await dan.client.get(url)).status, 200, 'projektledaren attesterar och får se kvittot');
    assert.equal((await eve.client.get(url)).status, 403);
  });

  test('användare ser bara sina egna utlägg, admin kan se alla', async () => {
    assert.ok((await anna.client.get('/api/expenses')).json.length >= 2);
    assert.equal((await eve.client.get('/api/expenses')).json.length, 0);
    assert.equal((await eve.client.get(`/api/expenses?user_id=${anna.id}`)).status, 403);
    assert.ok((await admin.get('/api/expenses?all=1')).json.length >= 2);
  });

  test('icke-medlem kan inte lägga utlägg på projekt', async () => {
    assert.equal((await eve.client.post('/api/expenses', { ...base, project_id: w.p1 })).status, 403);
  });

  test('vidarefakturering kräver ett projekt', async () => {
    assert.equal((await anna.client.post('/api/expenses', { ...base, billable: true })).status, 400);
  });

  test('avslag kan rättas och skickas in igen', async () => {
    const exp = await anna.client.post('/api/expenses', { ...base, project_id: w.p1 });
    await dan.client.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'reject', note: 'Saknar kvitto' });
    let row = (await anna.client.get('/api/expenses')).json.find((e) => e.id === exp.json.id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.reject_note, 'Saknar kvitto');
    await anna.client.patch(`/api/expenses/${exp.json.id}`, { receipt: { name: 'k.png', data: PNG.toString('base64') } });
    row = (await anna.client.get('/api/expenses')).json.find((e) => e.id === exp.json.id);
    assert.equal(row.status, 'submitted');
    assert.equal(row.has_receipt, 1);
  });

  test('körjournal sparar milersättningen som gällde när resan registrerades', async () => {
    await admin.patch('/api/settings', { mileage_rate: 2.5 });
    const trip = await anna.client.post('/api/mileage', { date: '2025-03-04', purpose: 'Kundbesök', km: 40 });
    await admin.patch('/api/settings', { mileage_rate: 3 });
    const row = (await anna.client.get('/api/mileage')).json.find((m) => m.id === trip.json.id);
    assert.equal(row.rate_per_km, 2.5);
    assert.equal(row.amount, 100);
  });
});

describe('CSV', () => {
  test('formelinjektion neutraliseras och svenska tecken bevaras', () => {
    const csv = toCsv([{ key: 'a', label: 'Namn' }, { key: 'b', label: 'Tim' }], [
      { a: '=HYPERLINK("http://x")', b: 7.5 },
      { a: 'Åsa; "Ö"', b: 8 },
    ]);
    assert.ok(csv.startsWith('﻿Namn;Tim\r\n'));
    assert.ok(csv.includes(`'=HYPERLINK`));
    assert.ok(csv.includes('7,5'));
    assert.ok(csv.includes('"Åsa; ""Ö"""'));
  });
});
