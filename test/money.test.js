import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, entry } from './world.js';
import { toCsv } from '../src/csv.js';

// Alla belopp nedan är handräknade, se kommentarerna.
describe('TB, provision och fakturaunderlag', () => {
  let w, anna, dan, bo, cia, eve, carl, admin;

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, bo, cia, eve, carl } = w.users);
    admin = w.admin;

    const put = (d, t, m) => anna.client.put('/api/time/entries', entry(d, t, m));
    await put('2025-03-03', { activity_id: w.p1Activity }, 480); // 8 h × 1200 = 9600 intäkt, 8 h × 500 = 4000 kostnad
    await put('2025-03-04', { activity_id: w.meeting }, 120); //   2 h ej debiterbar, kostnad 1000
    await put('2025-03-05', { activity_id: w.p2Activity }, 240); // 4 h fastpris × 900 = 3600 värde, kostnad 2000
    await put('2025-03-06', { absence_type_id: w.vacation }, 480); // frånvaro, räknas inte
    await anna.client.post('/api/time/submit', { week_start: '2025-03-03' });
    const ids = (await admin.get('/api/approvals')).json.time.map((r) => r.id);
    await admin.post('/api/approvals/decide', { kind: 'time', ids, decision: 'approve' });
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

    // Projektledaren ser tid på sitt projekt men inte Annas frånvaro eller fastprisprojektet.
    const pm = (await dan.client.get(`/api/reports/time?${range}&group_by=project`)).json;
    assert.deepEqual(pm.rows.map((r) => r.label), ['ACME-1 Plattform']);
    // Chefen ser sin underställdas allt.
    assert.equal((await carl.client.get(`/api/reports/time?${range}&group_by=user`)).json.total.hours, 22);
    // Utomstående ser ingenting.
    assert.equal((await eve.client.get(`/api/reports/time?${range}&group_by=user`)).json.rows.length, 0);
  });

  test('filter: debiterbar, användare och ogiltig period', async () => {
    const billable = (await admin.get(`/api/reports/time?${range}&group_by=user&billable=yes`)).json;
    assert.equal(billable.total.hours, 12);
    assert.equal((await admin.get('/api/reports/time?from=2025-03-31&to=2025-03-01')).status, 400);
    assert.equal((await admin.get('/api/reports/time?from=2025-03-01')).status, 400);
    assert.equal((await admin.get(`/api/reports/time?${range}&billable=maybe`)).status, 400);
  });

  test('TB per konsult: intäkt 13200 − kostnad 7000 = 6200', async () => {
    const r = (await admin.get(`/api/reports/margin?${range}`)).json;
    const a = r.consultants.find((c) => c.name === 'Anna Konsult');
    assert.equal(a.revenue, 13200);
    assert.equal(a.cost, 7000);
    assert.equal(a.margin, 6200);
    assert.equal(a.hours, 14, 'frånvaro räknas inte');
    assert.equal(a.category, 'Konsult Expert');
  });

  test('provision: Bo 10 % = 620 och Cia 5 % = 310', async () => {
    const r = (await admin.get(`/api/reports/margin?${range}`)).json;
    const byEarner = Object.fromEntries(r.earners.map((e) => [e.name, e.commission]));
    assert.equal(byEarner['Bo AM'], 620);
    assert.equal(byEarner['Cia BM'], 310);
    const line = r.commissions.find((c) => c.earner_name === 'Bo AM');
    assert.equal(line.source_name, 'Anna Konsult');
    assert.equal(line.margin, 6200);
    assert.equal(line.earner_category, 'AM');
  });

  test('mottagare ser bara sin egen provision, ingen annans TB', async () => {
    const mine = (await bo.client.get(`/api/reports/margin?${range}`)).json;
    assert.deepEqual(mine.earners.map((e) => e.name), ['Bo AM']);
    assert.equal(mine.consultants.length, 0);
    assert.equal(mine.commissions.length, 1);
    const none = (await eve.client.get(`/api/reports/margin?${range}`)).json;
    assert.equal(none.commissions.length, 0);
    const annaSelf = (await anna.client.get(`/api/reports/margin?${range}`)).json;
    assert.equal(annaSelf.commissions.length, 0, 'konsulten ser inte vem som får provision på hens TB');
  });

  test('inställningen "bara debiterbar kostnad" ändrar TB till 7200', async () => {
    await admin.patch('/api/settings', { tb_cost_basis: 'billable' });
    const r = (await admin.get(`/api/reports/margin?${range}`)).json;
    assert.equal(r.consultants[0].margin, 7200);
    assert.equal(r.earners.find((e) => e.name === 'Bo AM').commission, 720);
    await admin.patch('/api/settings', { tb_cost_basis: 'worked' });
  });

  test('provisionskoppling med giltighetsperiod räknar bara poster inom perioden', async () => {
    // Dan får 20 % av Annas TB från och med 5 mars: bara fastprisdagen (3600 − 2000 = 1600) → 320.
    const link = await admin.post('/api/commission-links', {
      earner_id: dan.id,
      source_id: anna.id,
      percent: 20,
      valid_from: '2025-03-05',
    });
    assert.equal(link.status, 200);
    const r = (await admin.get(`/api/reports/margin?${range}`)).json;
    assert.equal(r.earners.find((e) => e.name === 'Dan Projektledare').commission, 320);

    const overlap = await admin.post('/api/commission-links', {
      earner_id: dan.id,
      source_id: anna.id,
      percent: 5,
      valid_from: '2025-04-01',
    });
    assert.equal(overlap.status, 409, 'öppen period överlappar');
    const nonOverlap = await admin.patch(`/api/commission-links/${link.json.id}`, { valid_to: '2025-03-31' });
    assert.equal(nonOverlap.status, 200);
    const ok = await admin.post('/api/commission-links', {
      earner_id: dan.id,
      source_id: anna.id,
      percent: 5,
      valid_from: '2025-04-01',
    });
    assert.equal(ok.status, 200);
  });

  test('ogiltiga provisionskopplingar avvisas', async () => {
    const self = await admin.post('/api/commission-links', { earner_id: anna.id, source_id: anna.id, percent: 5 });
    assert.equal(self.status, 400);
    assert.equal((await admin.post('/api/commission-links', { earner_id: bo.id, source_id: eve.id, percent: 101 })).status, 400);
    assert.equal((await admin.post('/api/commission-links', { earner_id: 9999, source_id: eve.id, percent: 5 })).status, 400);
    assert.equal((await bo.client.post('/api/commission-links', { earner_id: bo.id, source_id: eve.id, percent: 50 })).status, 403);
  });

  test('provision på ej godkänd tid ingår inte, men kan förhandsvisas', async () => {
    await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 60));
    const approvedOnly = (await admin.get(`/api/reports/margin?${range}`)).json;
    assert.equal(approvedOnly.consultants[0].margin, 6200);
    const all = (await admin.get(`/api/reports/margin?${range}&status=all`)).json;
    assert.equal(all.consultants[0].margin, 6200 + 700, '1 h × (1200 − 500)');
    await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 0));
  });

  // Fakturaunderlag ───────────────────────────────────────────────────
  let invoiceId;

  test('förhandsvisning: bara debiterbar tid på löpande räkning', async () => {
    const r = (await admin.get(`/api/invoices/preview?customer_id=${w.customer}&${range}`)).json;
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].quantity, 8);
    assert.equal(r.lines[0].rate, 1200);
    assert.equal(r.total, 9600, 'fastpris och ej debiterbar tid ingår inte');
  });

  test('utlägg och körning vidarefaktureras när de är godkända', async () => {
    const noProject = await anna.client.post('/api/expenses', { date: '2025-03-04', description: 'Tåg', amount: 500, billable: true });
    assert.equal(noProject.status, 400);
    const exp = await anna.client.post('/api/expenses', {
      date: '2025-03-04',
      description: 'Tåg till kund',
      amount: 500,
      vat: 30,
      billable: true,
      project_id: w.p1,
    });
    assert.equal(exp.status, 200);
    const trip = await anna.client.post('/api/mileage', {
      date: '2025-03-04',
      from_place: 'Kontoret',
      to_place: 'Acme',
      purpose: 'Kundmöte',
      km: 100,
      billable: true,
      project_id: w.p1,
    });
    assert.equal(trip.status, 200);

    // Ej godkänt ingår inte
    let r = (await admin.get(`/api/invoices/preview?customer_id=${w.customer}&${range}`)).json;
    assert.equal(r.total, 9600);

    const queue = (await dan.client.get('/api/approvals')).json;
    assert.equal(queue.expenses.length, 1);
    assert.equal(queue.mileage.length, 1);
    assert.equal((await eve.client.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'approve' })).status, 403);
    await dan.client.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'approve' });
    await dan.client.post('/api/approvals/decide', { kind: 'mileage', ids: [trip.json.id], decision: 'approve' });

    r = (await admin.get(`/api/invoices/preview?customer_id=${w.customer}&${range}`)).json;
    assert.equal(r.lines.length, 3);
    assert.equal(r.total, 9600 + 500 + 250, '100 km × 2,50 kr');

    // Godkänt utlägg kan inte ändras
    assert.equal((await anna.client.patch(`/api/expenses/${exp.json.id}`, { amount: 1 })).status, 409);
    assert.equal((await anna.client.del(`/api/mileage/${trip.json.id}`)).status, 409);
  });

  test('skapa underlag markerar raderna som fakturerade', async () => {
    const created = await admin.post('/api/invoices', { customer_id: w.customer, from: '2025-03-01', to: '2025-03-31' });
    assert.equal(created.status, 200);
    invoiceId = created.json.id;

    assert.equal((await admin.get(`/api/invoices/preview?customer_id=${w.customer}&${range}`)).json.lines.length, 0);
    const again = await admin.post('/api/invoices', { customer_id: w.customer, from: '2025-03-01', to: '2025-03-31' });
    assert.equal(again.status, 400, 'inget kvar att fakturera');

    const detail = (await admin.get(`/api/invoices/${invoiceId}`)).json;
    assert.equal(detail.total, 10350);
    assert.equal(detail.lines.length, 3);
    assert.match(detail.number, /^\d{4}-0001$/);
    assert.equal((await admin.get('/api/invoices')).json[0].total_amount, 10350);

    const first = w.app.db.prepare('SELECT id FROM time_entries WHERE invoice_id = ?').get(invoiceId);
    assert.equal((await admin.post('/api/approvals/reopen', { kind: 'time', ids: [first.id] })).status, 409);
    assert.equal((await anna.client.put('/api/time/entries', entry('2025-03-03', { activity_id: w.p1Activity }, 60))).status, 409);
  });

  test('underlaget kan exporteras som CSV för svensk Excel', async () => {
    const r = await admin.get(`/api/invoices/${invoiceId}?format=csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.text.startsWith('﻿'), 'BOM');
    assert.match(r.text, /Typ;Projekt;Beskrivning;Antal;Enhet;À-pris;Belopp/);
    assert.match(r.text, /10350/);
  });

  test('ångra underlag gör raderna fakturerbara igen', async () => {
    assert.equal((await admin.del(`/api/invoices/${invoiceId}`)).status, 200);
    assert.equal((await admin.get(`/api/invoices/preview?customer_id=${w.customer}&${range}`)).json.total, 10350);
    assert.equal((await anna.client.get('/api/invoices')).status, 403);
  });

  test('rapportering över en annan kund eller period lämnar underlaget orört', async () => {
    const other = (await admin.post('/api/customers', { name: 'Beta AB' })).json.id;
    assert.equal((await admin.get(`/api/invoices/preview?customer_id=${other}&${range}`)).json.lines.length, 0);
    assert.equal((await admin.get(`/api/invoices/preview?customer_id=${w.customer}&from=2025-04-01&to=2025-04-30`)).json.lines.length, 0);
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
    const exp = await anna.client.post('/api/expenses', {
      ...base,
      project_id: w.p1,
      receipt: { name: 'k.png', data: PNG.toString('base64') },
    });
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
