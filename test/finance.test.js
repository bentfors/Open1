import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, seedApprovedWeek } from './world.js';
import { createUser } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

// Ekonomiadministratörer avgör fakturering och ser ekonomirapporter. Allt annat är administratörens.
describe('ekonomiadministratör', () => {
  let w, anna, dan, eve, bo, cia, fin, admin;
  let timeId, expenseId;

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, eve, bo, cia } = w.users);
    admin = w.admin;
    fin = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: true });
    await seedApprovedWeek(w);
    // Annas BM är Cia, som attesterar utlägget. Det visar att fakturering och attest är skilda saker.
    await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id });
    const exp = await anna.client.post('/api/expenses', {
      date: '2025-03-04',
      description: 'Tåg',
      amount: 500,
      billable: true,
      project_id: w.p1,
      receipt: { name: 'k.png', data: PNG.toString('base64') },
    });
    expenseId = exp.json.id;
    await cia.client.post('/api/approvals/decide', { kind: 'expense', ids: [expenseId], decision: 'approve' });
  });
  after(() => w.close());

  test('flaggan syns i sessionen och bara administratörer kan sätta den', async () => {
    assert.equal((await fin.client.get('/api/auth/me')).json.user.finance, true);
    assert.equal((await anna.client.get('/api/auth/me')).json.user.finance, false);
    assert.equal((await admin.get('/api/auth/me')).json.user.finance, true, 'administratörer har ekonomibehörighet');
    assert.equal((await fin.client.patch(`/api/users/${eve.id}`, { finance: true })).status, 403);
    assert.equal((await admin.patch(`/api/users/${eve.id}`, { finance: true })).status, 200);
    assert.equal((await admin.get('/api/users')).json.find((u) => u.id === eve.id).finance, 1);
    assert.equal((await admin.patch(`/api/users/${eve.id}`, { finance: false })).status, 200);
  });

  test('ekonomi ser och fakturerar valda rader', async () => {
    const d = (await fin.client.get(`/api/billing/items?project_id=${w.p1}`)).json;
    const time = d.items.find((i) => i.kind === 'time' && i.what === 'Arbete');
    timeId = time.id;
    assert.deepEqual([time.amount, time.selectable], [9600, true]);
    assert.equal(d.items.find((i) => i.kind === 'expense').selectable, true, 'utlägget är attesterat av BM');

    const r = await fin.client.post('/api/invoices', { customer_id: w.customer, invoice_date: '2025-04-02', time_ids: [timeId], expense_ids: [expenseId] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 10100);
    assert.equal((await fin.client.get('/api/invoices')).json.length, 1);
    assert.equal((await fin.client.get(`/api/invoices/${r.json.id}?format=csv`)).status, 200);
    assert.equal((await fin.client.del(`/api/invoices/${r.json.id}`)).status, 200, 'ekonomi kan ångra');
  });

  test('ekonomi kan avskriva och ångra avskrivning', async () => {
    assert.equal((await fin.client.post('/api/billing/waive', { time_ids: [timeId], note: 'Kulans' })).status, 200);
    assert.equal((await fin.client.post('/api/billing/restore', { time_ids: [timeId] })).status, 200);
  });

  test('ekonomi ser upplupet och tidrapporter med pengar för alla', async () => {
    const acc = (await fin.client.get('/api/reports/accrued?to=2025-03-31&as_of=2025-03-31')).json;
    assert.equal(acc.rows[0].label, 'Acme AB');
    assert.equal(acc.rows[0].time_approved, 9600);

    const rep = (await fin.client.get('/api/reports/time?from=2025-03-01&to=2025-03-31&group_by=user')).json;
    assert.deepEqual(rep.rows.map((r) => r.label), ['Anna Konsult'], 'ser andras tid');
    assert.equal(rep.total.revenue, 13200, 'och pengarna');
    assert.equal(rep.total.cost, 7000);
    // En vanlig användare, och en BM, ser fortfarande inga pengar.
    assert.equal('revenue' in (await cia.client.get('/api/reports/time?from=2025-03-01&to=2025-03-31&group_by=user')).json.total, false);
  });

  test('ekonomi kan läsa kund- och projektlistor men inte ändra dem', async () => {
    assert.equal((await fin.client.get('/api/customers')).status, 200);
    assert.equal((await fin.client.get('/api/projects')).status, 200);
    assert.equal((await fin.client.post('/api/customers', { name: 'Ny' })).status, 403);
    assert.equal((await fin.client.patch(`/api/projects/${w.p1}`, { hourly_rate: 1 })).status, 403);
    assert.equal((await fin.client.get(`/api/projects/${w.p1}`)).status, 403, 'detaljvyn med team och priser är administratörens');
  });

  test('ekonomi når inte administratörens områden', async () => {
    for (const url of ['/api/users', '/api/commission-rules', '/api/employments', '/api/assignments', '/api/contracts/warnings', '/api/stats/people', '/api/approvals/approved']) {
      assert.equal((await fin.client.get(url)).status, 403, url);
    }
    assert.equal((await fin.client.post('/api/users', { email: 'x@t.se', name: 'X', role: 'admin', password: 'losenord-for-test-1' })).status, 403);
    assert.equal((await fin.client.patch('/api/settings', { locked_until: '2030-01-01' })).status, 403);
    assert.equal((await fin.client.post('/api/commission-rules', { earner_id: fin.id, kind: 'per_consultant', period: 'month', amount: 99999 })).status, 403);
    assert.equal((await fin.client.post('/api/approvals/reopen', { kind: 'time', ids: [timeId] })).status, 403);
  });

  test('ekonomi ser varken TB per konsult eller andras provision', async () => {
    await admin.post('/api/commission-rules', { earner_id: bo.id, kind: 'tb_percent', period: 'month', percent: 10, source_ids: [anna.id] });
    assert.deepEqual((await fin.client.get('/api/reports/margin?from=2025-03-01&to=2025-03-31')).json.consultants, []);
    const com = (await fin.client.get('/api/reports/commission?from=2025-03-01&to=2025-03-31')).json;
    assert.equal(com.rows.length, 0);
    assert.equal((await fin.client.get(`/api/stats?earner_id=${bo.id}`)).json.earner.name, 'Ella Ekonomi', 'statistiken blir den egna');
  });

  test('fakturering ger ingen rätt att attestera', async () => {
    assert.deepEqual((await fin.client.get('/api/approvals')).json.time, []);
    assert.equal((await fin.client.post('/api/approvals/decide', { kind: 'time', ids: [timeId], decision: 'approve' })).status, 403);
  });

  test('en vanlig användare når fortfarande inget av detta', async () => {
    for (const url of [`/api/billing/items?project_id=${w.p1}`, '/api/invoices', '/api/reports/accrued', '/api/customers', '/api/projects']) {
      assert.equal((await anna.client.get(url)).status, 403, url);
    }
    assert.equal((await dan.client.post('/api/billing/waive', { time_ids: [timeId], note: 'x' })).status, 403);
  });

  test('kvitton: ägare, BM, projektledare och ekonomi får se, andra inte', async () => {
    const url = `/api/expenses/${expenseId}/receipt`;
    for (const [who, expected] of [[anna, 200], [cia, 200], [dan, 200], [fin, 200], [eve, 403], [bo, 403]]) {
      assert.equal((await who.client.get(url)).status, expected, String(who.id));
    }
  });
});
