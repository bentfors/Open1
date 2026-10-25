import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, seedApprovedWeek, entry } from './world.js';

// Utgångsläge (se world.js): Annas godkända vecka 3–6 mars 2025, plus ett godkänt utlägg (500 kr) och en godkänd
// körning (100 km × 2,50 = 250 kr) på ACME-1, båda vidarefakturerbara.
describe('fakturering per projekt och upplupet', () => {
  let w, anna, dan, eve, admin;
  let timeId, meetingId, expenseId, mileageId, fixedId, draftId;
  let invoice1, invoice2;

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, eve } = w.users);
    admin = w.admin;
    await seedApprovedWeek(w);

    const exp = await anna.client.post('/api/expenses', { date: '2025-03-04', description: 'Tåg', amount: 500, billable: true, project_id: w.p1 });
    const trip = await anna.client.post('/api/mileage', { date: '2025-03-04', purpose: 'Kundmöte', km: 100, billable: true, project_id: w.p1 });
    await dan.client.post('/api/approvals/decide', { kind: 'expense', ids: [exp.json.id], decision: 'approve' });
    await dan.client.post('/api/approvals/decide', { kind: 'mileage', ids: [trip.json.id], decision: 'approve' });
    expenseId = exp.json.id;
    mileageId = trip.json.id;
  });
  after(() => w.close());

  const items = async (q) => (await admin.get(`/api/billing/items?${q}`)).json;
  const find = (data, kind, what) => data.items.find((i) => i.kind === kind && (!what || i.what === what));
  const accrued = async (q = '') => (await admin.get(`/api/reports/accrued?${q}`)).json;

  test('projektvyn visar allt som rapporterats, med det som går att fakturera markerat', async () => {
    const d = await items(`project_id=${w.p1}`);
    assert.equal(d.scope, 'project');
    assert.equal(d.meta.code, 'ACME-1');
    assert.equal(d.items.length, 4);

    const time = find(d, 'time', 'Arbete');
    timeId = time.id;
    assert.deepEqual([time.quantity, time.rate, time.amount, time.selectable], [8, 1200, 9600, true]);

    const meeting = find(d, 'time', 'Möte');
    meetingId = meeting.id;
    assert.equal(meeting.selectable, false);
    assert.equal(meeting.reason, 'Ej debiterbar');
    assert.equal(meeting.amount, 0);

    assert.deepEqual([find(d, 'expense').amount, find(d, 'expense').selectable], [500, true]);
    assert.deepEqual([find(d, 'mileage').amount, find(d, 'mileage').quantity], [250, 100]);

    assert.deepEqual(d.summary, { hours: 10, billable_hours: 8, invoiced: 0, open_approved: 10350, open_unapproved: 0, waived: 0 });
  });

  test('fastprisprojekt syns men faktureras inte per timme', async () => {
    const d = await items(`project_id=${w.p2}`);
    const row = find(d, 'time');
    fixedId = row.id;
    assert.equal(row.selectable, false);
    assert.equal(row.reason, 'Fast pris, faktureras separat');
    assert.equal(d.summary.open_approved, 0);
  });

  test('kundvyn samlar alla kundens projekt', async () => {
    const d = await items(`customer_id=${w.customer}`);
    assert.equal(d.scope, 'customer');
    assert.deepEqual([...new Set(d.items.map((i) => i.project_code))].sort(), ['ACME-1', 'ACME-2']);
    assert.equal((await admin.get('/api/billing/items')).status, 400);
    assert.equal((await admin.get('/api/billing/items?project_id=9999')).status, 404);
  });

  test('ej godkänd tid syns med förklaring och går inte att välja', async () => {
    await anna.client.put('/api/time/entries', entry('2025-03-10', { activity_id: w.p1Activity }, 60));
    let d = await items(`project_id=${w.p1}`);
    const draft = d.items.find((i) => i.date === '2025-03-10');
    draftId = draft.id;
    assert.equal(draft.reason, 'Utkast, ej inskickad');
    assert.equal(draft.selectable, false);
    assert.equal(d.summary.open_unapproved, 1200);

    await anna.client.post('/api/time/submit', { week_start: '2025-03-10' });
    d = await items(`project_id=${w.p1}`);
    assert.equal(d.items.find((i) => i.id === draftId && i.kind === 'time').reason, 'Väntar på attest');
  });

  test('faktura av valda rader: resten ligger kvar till nästa gång', async () => {
    const r = await admin.post('/api/invoices', {
      customer_id: w.customer,
      invoice_date: '2025-04-02',
      note: 'Mars, del 1',
      time_ids: [timeId],
      expense_ids: [expenseId],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 10100);
    invoice1 = r.json.id;

    const open = await items(`project_id=${w.p1}`);
    assert.ok(open.items.some((i) => i.kind === 'mileage' && i.selectable), 'körningen ligger kvar');
    assert.ok(!open.items.some((i) => i.id === timeId && i.kind === 'time'), 'fakturerad tid är borta ur kön');
    assert.equal(open.summary.invoiced, 10100);
    assert.equal(open.summary.open_approved, 250);

    const invoiced = await items(`project_id=${w.p1}&show=invoiced`);
    assert.equal(invoiced.items.length, 2);
    assert.match(invoiced.items[0].invoice_number, /^\d{4}-0001$/);
    assert.equal(invoiced.items[0].invoice_date, '2025-04-02');
    assert.ok(invoiced.items.every((i) => !i.selectable && i.reason === 'Fakturerad'));

    const detail = (await admin.get(`/api/invoices/${invoice1}`)).json;
    assert.equal(detail.invoice_date, '2025-04-02');
    assert.equal(detail.total, 10100);
    assert.deepEqual(detail.lines.map((l) => [l.kind, l.amount]), [['Tid', 9600], ['Utlägg', 500]]);
    assert.equal(detail.period_from, '2025-03-03');
    assert.equal(detail.period_to, '2025-03-04');
  });

  test('en ogiltig rad stoppar hela fakturan, ingenting markeras', async () => {
    const attempts = [
      { time_ids: [meetingId], mileage_ids: [mileageId] }, // ej debiterbar
      { time_ids: [draftId], mileage_ids: [mileageId] }, // ej godkänd
      { time_ids: [fixedId], mileage_ids: [mileageId] }, // fast pris
      { time_ids: [timeId], mileage_ids: [mileageId] }, // redan fakturerad
      { time_ids: [99999], mileage_ids: [mileageId] }, // finns inte
    ];
    for (const a of attempts) {
      const r = await admin.post('/api/invoices', { customer_id: w.customer, ...a });
      assert.equal(r.status, 409, JSON.stringify(a));
    }
    const other = (await admin.post('/api/customers', { name: 'Annan kund' })).json.id;
    assert.equal((await admin.post('/api/invoices', { customer_id: other, mileage_ids: [mileageId] })).status, 409, 'fel kund');
    assert.equal((await items(`project_id=${w.p1}`)).summary.open_approved, 250, 'körningen är orörd');

    assert.equal((await admin.post('/api/invoices', { customer_id: w.customer })).status, 400, 'inga rader');
    assert.equal((await admin.post('/api/invoices', { customer_id: w.customer, time_ids: ['x'] })).status, 400);
    assert.equal((await admin.post('/api/invoices', { customer_id: w.customer, mileage_ids: [mileageId], invoice_date: '2025-13-40' })).status, 400);
  });

  test('nästa tillfälle: det som blev över faktureras', async () => {
    const r = await admin.post('/api/invoices', { customer_id: w.customer, mileage_ids: [mileageId] });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 250);
    invoice2 = r.json.id;
    assert.match((await admin.get('/api/invoices')).json[0].number, /^\d{4}-0002$/);
  });

  test('avskrivning kräver anledning och kan ångras', async () => {
    assert.equal((await admin.post('/api/billing/waive', { time_ids: [fixedId] })).status, 400);
    assert.equal((await admin.post('/api/billing/waive', { time_ids: [fixedId], note: 'Faktureras som fast pris' })).status, 200);

    assert.ok(!(await items(`project_id=${w.p2}`)).items.some((i) => i.id === fixedId), 'borta ur kön');
    const waived = await items(`project_id=${w.p2}&show=waived`);
    assert.equal(waived.items[0].waived_note, 'Faktureras som fast pris');
    assert.equal(waived.items[0].reason, 'Avskriven');
    assert.equal((await items(`project_id=${w.p2}&show=all`)).items.length, 1);

    assert.equal((await admin.post('/api/billing/waive', { time_ids: [fixedId], note: 'igen' })).status, 409, 'redan avskriven');
    assert.equal((await admin.post('/api/billing/waive', { time_ids: [timeId], note: 'x' })).status, 409, 'fakturerad rad kan inte avskrivas');
    assert.equal((await admin.post('/api/billing/restore', { time_ids: [timeId] })).status, 409);

    assert.equal((await admin.post('/api/billing/restore', { time_ids: [fixedId] })).status, 200);
    assert.equal((await items(`project_id=${w.p2}`)).items.length, 1, 'tillbaka i kön');
  });

  test('bara administratörer når fakturering och upplupet', async () => {
    for (const c of [anna.client, eve.client, dan.client]) {
      assert.equal((await c.get(`/api/billing/items?project_id=${w.p1}`)).status, 403);
      assert.equal((await c.get('/api/reports/accrued')).status, 403);
      assert.equal((await c.post('/api/billing/waive', { time_ids: [fixedId], note: 'x' })).status, 403);
      assert.equal((await c.post('/api/invoices', { customer_id: w.customer, mileage_ids: [mileageId] })).status, 403);
      assert.equal((await c.get('/api/invoices')).status, 403);
    }
  });

  // Upplupet ──────────────────────────────────────────────────────────────
  // Läge: faktura 1 (tid 9600 + utlägg 500) daterad 2025-04-02, faktura 2 (körning 250) daterad idag.
  // Kvar ofakturerat: Annas 1 h den 10 mars, inskickad men ej godkänd (1200), och fastprisdagen (4 h, värde 3600).

  test('upplupet idag: det som är fakturerat är borta', async () => {
    const d = await accrued('from=2025-03-01&to=2025-03-31');
    assert.equal(d.rows.length, 1);
    const acme = d.rows[0];
    assert.equal(acme.label, 'Acme AB');
    assert.deepEqual(
      [acme.hours_approved, acme.time_approved, acme.other_approved, acme.hours_unapproved, acme.time_unapproved, acme.total_approved, acme.total],
      [0, 0, 0, 1, 1200, 0, 1200],
    );
    assert.deepEqual([acme.fixed_hours, acme.fixed_value], [4, 3600], 'fast pris redovisas för sig');
    assert.equal(acme.oldest, '2025-03-05');
  });

  test('"fakturerat per datum": upplupet som det såg ut vid månadsskiftet', async () => {
    // Per 31 mars var inget fakturerat. Båda underlagen skapades senare.
    let a = (await accrued('to=2025-03-31&as_of=2025-03-31')).rows[0];
    assert.deepEqual([a.hours_approved, a.time_approved, a.other_approved, a.total_approved, a.total], [8, 9600, 750, 10350, 11550]);

    // Faktura 1 är daterad 2 april: ofakturerad den 1 april men fakturerad den 2 april.
    a = (await accrued('to=2025-03-31&as_of=2025-04-01')).rows[0];
    assert.equal(a.total_approved, 10350);
    a = (await accrued('to=2025-03-31&as_of=2025-04-02')).rows[0];
    assert.deepEqual([a.time_approved, a.other_approved], [0, 250], 'bara körningen (faktura 2 daterad idag) återstår');
  });

  test('perioden avser det datum timmarna gäller', async () => {
    const asOf = '&as_of=2025-03-31';
    assert.equal((await accrued(`to=2025-03-03${asOf}`)).total.total_approved, 9600, 'bara 3 mars');
    const rest = (await accrued(`from=2025-03-04&to=2025-03-31${asOf}`)).total;
    assert.deepEqual([rest.time_approved, rest.other_approved, rest.time_unapproved], [0, 750, 1200]);
    assert.equal((await accrued(`from=2025-04-01&to=2025-04-30${asOf}`)).rows.length, 0);
    // Utan datum: allt som någonsin utförts
    assert.equal((await accrued(`as_of=2025-03-31`)).total.total_approved, 10350);
  });

  test('gruppering per projekt, användare och månad', async () => {
    const asOf = 'to=2025-03-31&as_of=2025-03-31';
    const byProject = (await accrued(`${asOf}&group_by=project`)).rows;
    const p1 = byProject.find((r) => r.label === 'ACME-1 Plattform');
    const p2 = byProject.find((r) => r.label === 'ACME-2 Fastpris');
    assert.equal(p1.total_approved, 10350);
    assert.equal(p2.total_approved, 0);
    assert.deepEqual([p2.fixed_hours, p2.billing_type, p2.customer_name], [4, 'fixed', 'Acme AB']);
    assert.equal((await accrued(`${asOf}&group_by=user`)).rows[0].label, 'Anna Konsult');
    assert.deepEqual((await accrued(`${asOf}&group_by=month`)).rows.map((r) => r.label), ['2025-03']);
    assert.equal((await accrued(`${asOf}&group_by=all`)).rows[0].label, 'Totalt');
    assert.equal((await accrued(`${asOf}&group_by=constructor`)).group_by, 'customer', 'prototypnyckel faller tillbaka');
  });

  test('ångrat underlag ger upplupet tillbaka', async () => {
    assert.equal((await admin.del(`/api/invoices/${invoice2}`)).status, 200);
    assert.equal((await accrued('to=2025-03-31')).rows[0].other_approved, 250);
    assert.ok((await items(`project_id=${w.p1}`)).items.some((i) => i.kind === 'mileage' && i.selectable));
  });

  test('avskrivet lämnar upplupet, men inte historiken före avskrivningen', async () => {
    assert.equal((await admin.post('/api/billing/waive', { mileage_ids: [mileageId], note: 'Kulans' })).status, 200);
    assert.equal((await accrued('to=2025-03-31')).rows[0].other_approved, 0, 'idag är den avskriven');
    assert.equal((await accrued('to=2025-03-31&as_of=2025-03-31')).rows[0].other_approved, 750, 'per 31 mars var den ännu inte avskriven');
    assert.equal((await items(`project_id=${w.p1}&show=waived`)).summary.waived, 250);
  });

  test('avslagen tid ingår inte i upplupet', async () => {
    const before = (await accrued('to=2025-03-31')).rows[0];
    assert.equal(before.time_unapproved, 1200);
    const r = await dan.client.post('/api/approvals/decide', { kind: 'time', ids: [draftId], decision: 'reject', note: 'Fel dag' });
    assert.equal(r.status, 200);
    assert.equal((await accrued('to=2025-03-31')).rows[0].time_unapproved, 0);
  });

  test('ogiltiga parametrar och CSV', async () => {
    assert.equal((await admin.get('/api/reports/accrued?from=2025-03-31&to=2025-03-01')).status, 400);
    assert.equal((await admin.get('/api/reports/accrued?as_of=imorgon')).status, 400);
    assert.equal((await admin.get('/api/reports/accrued?to=2025-02-31')).status, 400);
    const csv = await admin.get('/api/reports/accrued?to=2025-03-31&as_of=2025-03-31&format=csv');
    assert.equal(csv.status, 200);
    assert.ok(csv.text.startsWith('﻿Kund;Äldsta datum;'));
    assert.match(csv.text, /Acme AB/);
    assert.match(csv.text, /Summa/);
    assert.match(csv.headers.get('content-disposition'), /upplupet-2025-03-31\.csv/);
  });
});
