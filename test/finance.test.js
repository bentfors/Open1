import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, seedApprovedWeek, entry } from './world.js';
import { createUser } from './helpers.js';
import { openDb, migrate } from '../src/db.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

// Ekonomi har två nivåer. Nivå 1 skapar fakturaunderlag och ser ekonomirapporter.
// Superuser (nivå 2) kan dessutom avskriva, ångra underlag och låsa perioder. Ingen av dem attesterar eller administrerar.
describe('ekonomiadministratörer, två nivåer', () => {
  let w, anna, dan, eve, bo, cia, sup, basic, admin;
  let timeId, expenseId;

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, eve, bo, cia } = w.users);
    admin = w.admin;
    sup = await createUser(w.app, admin, { email: 'sara@t.se', name: 'Sara Superuser', finance: 2 });
    basic = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: 1 });
    await seedApprovedWeek(w);
    // Annas BM är Cia, som attesterar utlägget. Fakturering och attest är skilda saker.
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

  const both = () => [sup, basic];

  test('nivån syns i sessionen och bara administratörer kan sätta den', async () => {
    const level = async (u) => (await u.client.get('/api/auth/me')).json.user.finance_level;
    assert.deepEqual([await level(sup), await level(basic), await level(anna)], [2, 1, 0]);
    assert.equal((await admin.get('/api/auth/me')).json.user.finance_level, 2, 'administratörer har högsta nivån');
    assert.equal((await sup.client.patch(`/api/users/${eve.id}`, { finance: 2 })).status, 403, 'inte ens superuser');
    assert.equal((await basic.client.patch(`/api/users/${eve.id}`, { finance: 1 })).status, 403);
    assert.equal((await admin.patch(`/api/users/${eve.id}`, { finance: 3 })).status, 400);
    assert.equal((await admin.patch(`/api/users/${eve.id}`, { finance: true })).status, 400);
    assert.equal((await admin.patch(`/api/users/${eve.id}`, { finance: 1 })).status, 200);
    assert.equal((await admin.get('/api/users')).json.find((u) => u.id === eve.id).finance, 1);
    assert.equal((await admin.patch(`/api/users/${eve.id}`, { finance: 0 })).status, 200);
  });

  test('båda nivåerna ser och fakturerar valda rader', async () => {
    const d = (await basic.client.get(`/api/billing/items?project_id=${w.p1}`)).json;
    const time = d.items.find((i) => i.kind === 'time' && i.what === 'Arbete');
    timeId = time.id;
    assert.deepEqual([time.amount, time.selectable], [9600, true]);
    assert.equal(d.items.find((i) => i.kind === 'expense').selectable, true, 'utlägget är attesterat av BM');

    const r = await basic.client.post('/api/invoices', { customer_id: w.customer, invoice_date: '2025-04-02', time_ids: [timeId], expense_ids: [expenseId] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 10100);
    for (const u of both()) {
      assert.equal((await u.client.get('/api/invoices')).json.length, 1);
      assert.equal((await u.client.get(`/api/invoices/${r.json.id}?format=csv`)).status, 200);
    }

    // Att ångra ett skapat underlag är superuserns sak.
    assert.equal((await basic.client.del(`/api/invoices/${r.json.id}`)).status, 403);
    assert.equal((await sup.client.del(`/api/invoices/${r.json.id}`)).status, 200);
    assert.equal((await sup.client.post('/api/invoices', { customer_id: w.customer, time_ids: [timeId] })).status, 200, 'raderna är fakturerbara igen');
    const id = (await sup.client.get('/api/invoices')).json[0].id;
    await sup.client.del(`/api/invoices/${id}`);
  });

  test('avskrivning kräver superuser', async () => {
    assert.equal((await basic.client.post('/api/billing/waive', { time_ids: [timeId], note: 'Kulans' })).status, 403);
    assert.equal((await sup.client.post('/api/billing/waive', { time_ids: [timeId], note: 'Kulans' })).status, 200);
    assert.equal((await basic.client.post('/api/billing/restore', { time_ids: [timeId] })).status, 403);
    assert.equal((await sup.client.post('/api/billing/restore', { time_ids: [timeId] })).status, 200);
  });

  test('periodlåsning: superuser får låsa, ekonomi på lägre nivå får inte, och övriga inställningar är administratörens', async () => {
    assert.equal((await basic.client.patch('/api/settings', { locked_until: '2025-03-31' })).status, 403);
    const locked = await sup.client.patch('/api/settings', { locked_until: '2025-03-31' });
    assert.equal(locked.status, 200);
    assert.equal(locked.json.locked_until, '2025-03-31');
    assert.equal((await sup.client.patch('/api/settings', { company_name: 'Ändrat' })).status, 403);
    assert.equal((await sup.client.patch('/api/settings', { locked_until: '2025-03-31', mileage_rate: 9 })).status, 403, 'inget slinker med');
    assert.equal((await sup.client.patch('/api/settings', { bench_cap_hours: 1 })).status, 403);
    assert.notEqual((await basic.client.get('/api/settings')).json.company_name, 'Ändrat');

    // Låsningen gäller: Anna kan inte längre rapportera eller ändra i perioden.
    const blocked = await anna.client.put('/api/time/entries', entry('2025-03-12', { activity_id: w.p1Activity }, 60));
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /låst/);
    // Ekonomi kan själv inte skriva i en låst period.
    assert.equal((await sup.client.put('/api/time/entries', { ...entry('2025-03-12', { activity_id: w.p1Activity }, 60), user_id: anna.id })).status, 403);

    assert.equal((await sup.client.patch('/api/settings', { locked_until: null })).json.locked_until, '', 'superuser kan låsa upp');
    assert.equal((await anna.client.put('/api/time/entries', entry('2025-03-12', { activity_id: w.p1Activity }, 60))).status, 200);
    await anna.client.put('/api/time/entries', entry('2025-03-12', { activity_id: w.p1Activity }, 0));
    assert.equal((await admin.patch('/api/settings', { company_name: 'x-time', locked_until: null })).status, 200, 'administratören kan allt');
  });

  test('båda nivåerna ser upplupet och tidrapporter med pengar för alla', async () => {
    for (const u of both()) {
      const acc = (await u.client.get('/api/reports/accrued?to=2025-03-31&as_of=2025-03-31')).json;
      assert.equal(acc.rows[0].time_approved, 9600);
      const rep = (await u.client.get('/api/reports/time?from=2025-03-01&to=2025-03-31&group_by=user')).json;
      assert.deepEqual(rep.rows.map((r) => r.label), ['Anna Konsult']);
      assert.deepEqual([rep.total.revenue, rep.total.cost], [13200, 7000]);
    }
    // En BM och en vanlig användare ser inga pengar.
    assert.equal('revenue' in (await cia.client.get('/api/reports/time?from=2025-03-01&to=2025-03-31&group_by=user')).json.total, false);
  });

  test('båda nivåerna kan läsa kund- och projektlistor men inte ändra dem', async () => {
    for (const u of both()) {
      assert.equal((await u.client.get('/api/customers')).status, 200);
      assert.equal((await u.client.get('/api/projects')).status, 200);
      assert.equal((await u.client.post('/api/customers', { name: 'Ny' })).status, 403);
      assert.equal((await u.client.patch(`/api/projects/${w.p1}`, { hourly_rate: 1 })).status, 403);
      assert.equal((await u.client.get(`/api/projects/${w.p1}`)).status, 403, 'detaljvyn med team och priser är administratörens');
    }
  });

  test('ingen av nivåerna når administratörens områden', async () => {
    for (const u of both()) {
      for (const url of ['/api/users', '/api/commission-rules', '/api/employments', '/api/assignments', '/api/contracts/warnings', '/api/stats/people', '/api/approvals/approved']) {
        assert.equal((await u.client.get(url)).status, 403, url);
      }
      assert.equal((await u.client.post('/api/users', { email: 'x@t.se', name: 'X', role: 'admin', password: 'losenord-for-test-1' })).status, 403);
      assert.equal((await u.client.post('/api/commission-rules', { earner_id: u.id, kind: 'per_consultant', period: 'month', amount: 99999 })).status, 403);
      assert.equal((await u.client.post('/api/approvals/reopen', { kind: 'time', ids: [timeId] })).status, 403);
      assert.equal((await u.client.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, start_date: '2030-01-01', hourly_rate: 1, hours_per_week: 1 })).status, 403);
    }
  });

  test('ekonomi ser varken TB per konsult eller andras provision', async () => {
    await admin.post('/api/commission-rules', { earner_id: bo.id, kind: 'tb_percent', period: 'month', percent: 10, source_ids: [anna.id] });
    for (const u of both()) {
      assert.deepEqual((await u.client.get('/api/reports/margin?from=2025-03-01&to=2025-03-31')).json.consultants, []);
      assert.equal((await u.client.get('/api/reports/commission?from=2025-03-01&to=2025-03-31')).json.rows.length, 0);
      assert.equal((await u.client.get(`/api/stats?earner_id=${bo.id}`)).json.earner.id, u.id, 'statistiken blir den egna');
    }
  });

  test('fakturering ger ingen rätt att attestera', async () => {
    for (const u of both()) {
      assert.deepEqual((await u.client.get('/api/approvals')).json.time, []);
      assert.equal((await u.client.post('/api/approvals/decide', { kind: 'time', ids: [timeId], decision: 'approve' })).status, 403);
    }
  });

  test('en vanlig användare når fortfarande inget av detta', async () => {
    for (const url of [`/api/billing/items?project_id=${w.p1}`, '/api/invoices', '/api/reports/accrued', '/api/customers', '/api/projects']) {
      assert.equal((await anna.client.get(url)).status, 403, url);
    }
    assert.equal((await dan.client.post('/api/billing/waive', { time_ids: [timeId], note: 'x' })).status, 403);
    assert.equal((await dan.client.patch('/api/settings', { locked_until: '2030-01-01' })).status, 403);
  });

  test('kvitton: ägare, BM, projektledare och ekonomi får se, andra inte', async () => {
    const url = `/api/expenses/${expenseId}/receipt`;
    for (const [who, expected] of [[anna, 200], [cia, 200], [dan, 200], [sup, 200], [basic, 200], [eve, 403], [bo, 403]]) {
      assert.equal((await who.client.get(url)).status, expected, String(who.id));
    }
  });

  test('migrering: den som hade ekonomibehörighet blir superuser, ingen tappar något', () => {
    const db = openDb(':memory:');
    db.exec(`INSERT INTO users (email, name, password_hash, finance) VALUES ('a@t.se','Gammal ekonomi','x',1), ('b@t.se','Vanlig','x',0)`);
    db.exec('PRAGMA user_version = 5'); // som en databas före nivåerna
    migrate(db);
    const rows = db.prepare('SELECT name, finance FROM users ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.name, r.finance]), [['Gammal ekonomi', 2], ['Vanlig', 0]]);
    db.close();
  });
});
