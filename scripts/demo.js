// Startar x-time med påhittad demodata i en separat databas (data-demo/), bara på 127.0.0.1.
// Använd aldrig mot riktig data: kontona har kända lösenord.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { bootstrap } from '../src/seed.js';
import { today, addDays, weekStart } from '../src/dates.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data-demo');
const port = Number(process.env.PORT || 3000);
const PASSWORD = 'demo-password-1';

const db = openDb(path.join(dataDir, 'x-time.sqlite'));
const fresh = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
await bootstrap(db, { adminEmail: 'admin@demo.test', adminPassword: PASSWORD });
const server = createApp({ db, dataDir });
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('xtime_session='));
    if (sc) cookie = sc.split(';')[0];
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${json?.error}`);
    return json;
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b), patch: (u, b = {}) => call('PATCH', u, b) };
}

if (fresh) {
  const admin = client();
  await admin.post('/api/auth/login', { email: 'admin@demo.test', password: PASSWORD });
  const cats = Object.fromEntries((await admin.get('/api/categories')).map((c) => [c.name, c.id]));

  const mk = async (email, name, cat, extra = {}) => {
    const { id } = await admin.post('/api/users', { email, name, role: 'user', password: PASSWORD, category_id: cats[cat], ...extra });
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
    const c = client();
    await c.post('/api/auth/login', { email, password: PASSWORD });
    return { id, c };
  };
  const chef = await mk('chef@demo.test', 'Cecilia Chef', 'Chef', { cost_rate: 0 });
  const am = await mk('am@demo.test', 'Axel Andersson', 'AM');
  const bm = await mk('bm@demo.test', 'Berit Björk', 'BM');
  const pl = await mk('pl@demo.test', 'Peter Projektledare', 'TA');
  await mk('ekonomi@demo.test', 'Ella Ekonomi', 'OH', { finance: 2 });
  await mk('ekonomi1@demo.test', 'Erik Ekonomiassistent', 'OH', { finance: 1 });
  const k1 = await mk('erik@demo.test', 'Erik Expert', 'Konsult Expert', { manager_id: chef.id, bm_id: bm.id, cost_rate: 650 });
  const k2 = await mk('nora@demo.test', 'Nora Next', 'Konsult Next', { manager_id: chef.id, bm_id: bm.id, cost_rate: 500 });
  const k3 = await mk('tim@demo.test', 'Tim Talent', 'Konsult Talent', { manager_id: chef.id, bm_id: bm.id, cost_rate: 380 });

  const kund1 = (await admin.post('/api/customers', { name: 'Nordic Retail AB', org_no: '556123-4567', contact_name: 'Lena Lind', email: 'lena@nordicretail.example' })).id;
  const kund2 = (await admin.post('/api/customers', { name: 'Kommunen Exempel', org_no: '212000-1234' })).id;
  const proj = async (customer_id, code, name, rate, extra = {}) => {
    const { id } = await admin.post('/api/projects', { customer_id, code, name, hourly_rate: rate, manager_id: pl.id, ...extra });
    return id;
  };
  const p1 = await proj(kund1, 'NR-100', 'Ny webbplattform', 1250);
  const p2 = await proj(kund1, 'NR-200', 'Förvaltning', 1050);
  const p3 = await proj(kund2, 'KE-10', 'Integrationsprojekt', 1150, { billing_type: 'fixed' });
  const act = async (p, name, billable = true) => (await admin.post(`/api/projects/${p}/activities`, { name, billable })).id;
  const a1 = (await admin.get(`/api/projects/${p1}`)).activities[0].id;
  const a1b = await act(p1, 'Möten', false);
  const a2 = (await admin.get(`/api/projects/${p2}`)).activities[0].id;
  const a3 = (await admin.get(`/api/projects/${p3}`)).activities[0].id;
  for (const [p, users] of [[p1, [k1, k2]], [p2, [k2, k3]], [p3, [k1, k3]]]) for (const u of users) await admin.put(`/api/projects/${p}/members/${u.id}`, {});
  await admin.put(`/api/projects/${p1}/members/${k1.id}`, { hourly_rate: 1450 });

  // Provision: procent av TB per månad och kvartal, samt koppling till antal konsulter i uppdrag.
  await admin.post('/api/commission-rules', { earner_id: am.id, name: 'AM 8 % av TB', kind: 'tb_percent', period: 'month', percent: 8, source_ids: [k1.id, k2.id] });
  await admin.post('/api/commission-rules', { earner_id: bm.id, name: 'BM 5 % av TB per kvartal', kind: 'tb_percent', period: 'quarter', percent: 5, source_ids: [k1.id, k3.id] });
  await admin.post('/api/commission-rules', { earner_id: chef.id, name: 'Chefsbonus per konsult i uppdrag', kind: 'per_consultant', period: 'month', amount: 500, min_hours: 8, category_ids: [cats['Konsult Talent'], cats['Konsult Next'], cats['Konsult Expert']] });
  await admin.post('/api/commission-rules', { earner_id: chef.id, name: 'Chef, trappa på antal konsulter', kind: 'tb_tiered', period: 'quarter', source_ids: [k1.id, k2.id, k3.id], tiers: [{ min: 0, percent: 2 }, { min: 3, percent: 4 }] });

  // Avtalsregister: anställningar och uppdrag, som underlag för prognoserna under Statistik.
  const emp = (u, start, type = 'permanent') => admin.post('/api/employments', { user_id: u.id, start_date: start, type, notice_months: 3 });
  await emp(k1, '2021-03-01');
  await emp(k2, '2023-08-15');
  await emp(k3, '2025-02-01');
  const job = (u, customer_id, project_id, title, start_date, end_date, hourly_rate, hours_per_week) =>
    admin.post('/api/assignments', { user_id: u.id, customer_id, project_id, title, start_date, end_date, hourly_rate, hours_per_week });
  const y = new Date().getFullYear();
  await job(k1, kund1, p1, 'Teknisk arkitekt', `${y}-01-01`, `${y + 1}-03-31`, 1450, 30);
  await job(k1, kund2, p3, 'Integrationsspecialist', `${y}-01-01`, `${y + 1}-06-30`, 1150, 10);
  await job(k2, kund1, p1, 'Utvecklare', `${y}-01-01`, `${y + 1}-01-31`, 1250, 20);
  await job(k2, kund1, p2, 'Förvaltare', `${y}-01-01`, `${y}-12-19`, 1050, 15);
  await job(k3, kund1, p2, 'Förvaltare', `${y}-01-01`, `${y + 1}-02-28`, 1050, 25);
  await job(k3, kund2, p3, 'Testare', `${y}-01-01`, `${y}-11-30`, 1150, 10);

  const internal = (await admin.get('/api/my/targets')).activities.find((t) => t.code === 'INT-1' && t.activity_name === 'Utbildning').activity_id;
  const plan = [
    [k1, [[a1, 6], [a3, 2]]],
    [k2, [[a1, 4], [a2, 3], [a1b, 1]]],
    [k3, [[a2, 5], [a3, 2], [internal, 1]]],
  ];
  const t = today();
  const thisMonday = weekStart(t);
  for (let w = 5; w >= 1; w--) {
    const monday = addDays(thisMonday, -7 * w);
    for (const [u, rows] of plan) {
      for (let d = 0; d < 5; d++) {
        for (const [activity_id, hours] of rows) await u.c.put('/api/time/entries', { date: addDays(monday, d), activity_id, minutes: hours * 60 });
      }
      await u.c.post('/api/time/submit', { week_start: monday });
    }
  }
  // Allt utom senaste veckan godkänns, så att attestkön har innehåll.
  const queue = await admin.get('/api/approvals');
  const lastMonday = addDays(thisMonday, -7);
  const ids = queue.time.filter((r) => r.date < lastMonday).map((r) => r.id);
  if (ids.length) await admin.post('/api/approvals/decide', { kind: 'time', ids, decision: 'approve' });

  const d = addDays(thisMonday, -9);
  await k1.c.post('/api/expenses', { date: d, description: 'Tågbiljett Stockholm–Göteborg', amount: 1290, vat: 77.4, project_id: p1, billable: true });
  await k2.c.post('/api/mileage', { date: d, from_place: 'Kontoret', to_place: 'Nordic Retail', purpose: 'Kundmöte', km: 84, project_id: p2, billable: true });
  // Fakturera de äldsta veckorna på NR-100 men lämna resten kvar att fakturera.
  const cutoff = addDays(thisMonday, -21);
  const open = await admin.get(`/api/billing/items?project_id=${p1}`);
  const first = open.items.filter((i) => i.selectable && i.date < cutoff);
  if (first.length) {
    await admin.post('/api/invoices', {
      customer_id: kund1,
      invoice_date: addDays(thisMonday, -14),
      note: 'Ny webbplattform, första etappen',
      time_ids: first.filter((i) => i.kind === 'time').map((i) => i.id),
      expense_ids: first.filter((i) => i.kind === 'expense').map((i) => i.id),
      mileage_ids: first.filter((i) => i.kind === 'mileage').map((i) => i.id),
    });
  }
  console.log('Demodata skapad.');
}

console.log(`\nx-time demo: ${base}`);
console.log(`  Admin:        admin@demo.test / ${PASSWORD}`);
console.log(`  Konsult:      erik@demo.test, nora@demo.test, tim@demo.test`);
console.log(`  AM / BM:      am@demo.test, bm@demo.test  (provision)`);
console.log(`  BM (attest):  bm@demo.test attesterar alla konsulters tid`);
console.log(`  Ekonomi:      ekonomi@demo.test (superuser), ekonomi1@demo.test (lägre nivå)`);
console.log(`  Chef / PL:    chef@demo.test, pl@demo.test`);
console.log(`  Lösenord för alla: ${PASSWORD}\n`);
