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
    }
    // Detaljvyn med team och priser: superusern läser, ekonomi på lägre nivå gör det inte.
    assert.equal((await sup.client.get(`/api/projects/${w.p1}`)).status, 200);
    assert.equal((await basic.client.get(`/api/projects/${w.p1}`)).status, 403);
  });

  test('administratörens områden: lägre nivå når inget, och ingen av nivåerna kan ändra eller öppna godkänt', async () => {
    for (const url of ['/api/users', '/api/commission-rules', '/api/employments', '/api/assignments', '/api/contracts/warnings', '/api/stats/people']) {
      assert.equal((await basic.client.get(url)).status, 403, url);
    }
    for (const u of both()) {
      assert.equal((await u.client.get('/api/approvals/approved')).status, 403, 'listan över godkänt att öppna igen är administratörens');
      assert.equal((await u.client.post('/api/users', { email: 'x@t.se', name: 'X', role: 'admin', password: 'losenord-for-test-1' })).status, 403);
      assert.equal((await u.client.post('/api/commission-rules', { earner_id: u.id, kind: 'per_consultant', period: 'month', amount: 99999 })).status, 403);
      assert.equal((await u.client.post('/api/approvals/reopen', { kind: 'time', ids: [timeId] })).status, 403);
      assert.equal((await u.client.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, start_date: '2030-01-01', hourly_rate: 1, hours_per_week: 1 })).status, 403);
    }
  });

  test('TB per konsult och provision: bara ekonomi-superuser och administratörer', async () => {
    await admin.post('/api/commission-rules', { earner_id: bo.id, kind: 'tb_percent', period: 'month', percent: 10, source_ids: [anna.id] });
    const range = 'from=2025-03-01&to=2025-03-31';

    // Ekonomi på lägre nivå ser ingenting av detta.
    assert.deepEqual((await basic.client.get(`/api/reports/margin?${range}`)).json.consultants, []);
    assert.equal((await basic.client.get(`/api/reports/commission?${range}`)).json.rows.length, 0);

    // Superusern ser TB per konsult och allas provision, och kan filtrera på mottagare.
    const margin = (await sup.client.get(`/api/reports/margin?${range}`)).json.consultants;
    assert.deepEqual([margin[0].name, margin[0].margin], ['Anna Konsult', 6200]);
    const all = (await sup.client.get(`/api/reports/commission?${range}`)).json;
    assert.deepEqual(all.rows.map((r) => [r.earner_name, r.commission]), [['Bo AM', 620]]);
    assert.equal((await sup.client.get(`/api/reports/commission?${range}&earner_id=${bo.id}`)).json.rows.length, 1);
    assert.equal((await sup.client.get(`/api/reports/commission?${range}&earner_id=${cia.id}`)).json.rows.length, 0);
    assert.equal((await sup.client.get(`/api/reports/commission?${range}&format=csv`)).status, 200);

    // Ekonomi på lägre nivå ser varken reglerna eller någon annans statistik.
    assert.equal((await basic.client.get('/api/commission-rules')).status, 403);
    assert.equal((await basic.client.get(`/api/stats?earner_id=${bo.id}`)).json.earner.id, basic.id, 'statistiken blir den egna');
  });

  test('superusern ser allt och ändrar bara användare: läsrätt till resten av administrationen och allas statistik', async () => {
    const READ = ['/api/users', '/api/employments', '/api/assignments', '/api/contracts/warnings', '/api/commission-rules', '/api/stats/people', `/api/projects/${w.p1}`, '/api/customers', '/api/projects'];
    for (const url of READ) {
      assert.equal((await sup.client.get(url)).status, 200, `superuser läser ${url}`);
      assert.equal((await basic.client.get(url)).status, url === '/api/customers' || url === '/api/projects' ? 200 : 403, `lägre nivå ${url}`);
    }
    // Statistik för den som väljs, inte bara den egna.
    assert.equal((await sup.client.get(`/api/stats?earner_id=${bo.id}`)).json.earner.id, bo.id);
    assert.equal((await sup.client.get(`/api/stats/scenario?count=1&rate=1000&cost=500&earner_id=${bo.id}`)).status, 200);

    // Allt som skriver är fortfarande administratörens.
    const WRITE = [
      ['post', '/api/customers', { name: 'Ny kund' }],
      ['post', '/api/commission-rules', { earner_id: bo.id, kind: 'tb_percent', period: 'month', percent: 5, source_ids: [anna.id] }],
      ['post', '/api/employments', { user_id: anna.id, type: 'permanent', start_date: '2030-01-01' }],
      ['post', '/api/assignments', { user_id: anna.id, customer_id: w.customer, start_date: '2030-01-01', hourly_rate: 1, hours_per_week: 1 }],
      ['patch', '/api/settings', { company_name: 'Ändrat' }],
    ];
    for (const [method, url, body] of WRITE) {
      assert.equal((await sup.client[method](url, body)).status, 403, `${method} ${url}`);
    }
  });

  test('superusern hanterar användare, men kan inte ge någon (eller sig själv) mer behörighet', async () => {
    const adminId = (await sup.client.get('/api/users')).json.find((u) => u.role === 'admin').id;
    const status = async (call) => (await call).status;

    // Skapa och ändra vanliga användare, inklusive lösenord, kostnad och BM.
    const created = await sup.client.post('/api/users', { email: 'ny@t.se', name: 'Ny Person', role: 'user', password: 'ett-langt-losenord', cost_rate: 400 });
    assert.equal(created.status, 200);
    const row = (id) => admin.get('/api/users').then((r) => r.json.find((u) => u.id === id));
    const fresh = created.json.id;
    assert.deepEqual([(await row(fresh)).role, (await row(fresh)).finance, (await row(fresh)).must_change_password], ['user', 0, 1]);
    assert.equal(await status(sup.client.patch(`/api/users/${fresh}`, { name: 'Ny K', cost_rate: 700, bm_id: cia.id })), 200);
    assert.deepEqual([(await row(fresh)).cost_rate, (await row(fresh)).bm_id], [700, cia.id]);
    assert.equal(await status(sup.client.post(`/api/users/${fresh}/password`, { password: 'nytt-tillfalligt-1' })), 200);
    // Oförändrade värden för roll och nivå är inget försök att ändra dem.
    assert.equal(await status(sup.client.patch(`/api/users/${fresh}`, { role: 'user', finance: 0 })), 200);

    // Inget som ger högre behörighet.
    assert.equal(await status(sup.client.post('/api/users', { email: 'a2@t.se', name: 'A', role: 'admin', password: 'ett-langt-losenord' })), 403);
    assert.equal(await status(sup.client.post('/api/users', { email: 'f2@t.se', name: 'F', role: 'user', finance: 1, password: 'ett-langt-losenord' })), 403);
    assert.equal(await status(sup.client.patch(`/api/users/${anna.id}`, { role: 'admin' })), 403);
    assert.equal(await status(sup.client.patch(`/api/users/${anna.id}`, { finance: 2 })), 403);
    assert.equal(await status(sup.client.patch(`/api/users/${sup.id}`, { role: 'admin' })), 403, 'inte heller sitt eget konto');
    assert.equal(await status(sup.client.patch(`/api/users/${sup.id}`, { finance: 0 })), 403);

    // Administratörers konton är administratörens.
    assert.equal(await status(sup.client.patch(`/api/users/${adminId}`, { name: 'Övertagen' })), 403);
    assert.equal(await status(sup.client.patch(`/api/users/${adminId}`, { active: false })), 403);
    assert.equal(await status(sup.client.post(`/api/users/${adminId}/password`, { password: 'overtaget-losen-1' })), 403);

    // Man utser inte sig själv till attestant.
    assert.equal(await status(sup.client.patch(`/api/users/${anna.id}`, { bm_id: sup.id })), 403);
    assert.equal(await status(sup.client.patch(`/api/users/${anna.id}`, { manager_id: sup.id })), 403);
    assert.equal((await row(anna.id)).bm_id, cia.id, 'Annas BM är kvar');

    // Ekonomi på lägre nivå och vanliga användare når ingenting av detta.
    for (const u of [basic, anna]) {
      assert.equal(await status(u.client.post('/api/users', { email: 'q@t.se', name: 'Q', role: 'user', password: 'ett-langt-losenord' })), 403);
      assert.equal(await status(u.client.patch(`/api/users/${eve.id}`, { name: 'Q' })), 403);
      assert.equal(await status(u.client.post(`/api/users/${eve.id}/password`, { password: 'ett-langt-losenord' })), 403);
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
