import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, addTime } from './world.js';
import { setTodayForTests, daysBetween } from '../src/dates.js';
import { createUser } from './helpers.js';

// Idag är 2026-01-12 (en måndag). Arbetsdagar 2026: jan 22, feb 20, mar 22, apr 22, maj 21, jun 22.
// Anna: 40 tim/vecka (8 tim/dag), timkostnad 500. Uppdrag hos Acme 1 jan–31 mar 2026, 1200 kr/tim, 40 tim/vecka.
// Per arbetsdag i uppdrag: intäkt 9600, kostnad 4000, TB 5600. Beläggningen sätts till 100 % om inget annat anges.
describe('avtalsregister och prognos', () => {
  let w, anna, bo, cia, eve, admin;
  const ids = {};

  before(async () => {
    setTodayForTests('2026-01-12');
    w = await buildWorld();
    ({ anna, bo, cia, eve } = w.users);
    admin = w.admin;
    await admin.patch('/api/settings', { forecast_utilization: 100 });

    assert.equal((await admin.post('/api/employments', { user_id: anna.id, start_date: '2020-01-01' })).status, 200);
    const a = await admin.post('/api/assignments', {
      user_id: anna.id,
      customer_id: w.customer,
      project_id: w.p1,
      title: 'Utvecklare',
      start_date: '2026-01-01',
      end_date: '2026-03-31',
      hourly_rate: 1200,
      hours_per_week: 40,
    });
    assert.equal(a.status, 200, a.text);
    ids.assignment = a.json.id;

    const rule = async (body) => (await admin.post('/api/commission-rules', { earner_id: bo.id, period: 'month', ...body })).json.id;
    ids.month = await rule({ name: 'Månad 10 %', kind: 'tb_percent', percent: 10, source_ids: [anna.id] });
    ids.quarter = await rule({ name: 'Kvartal 10 %', kind: 'tb_percent', period: 'quarter', percent: 10, source_ids: [anna.id] });
    ids.count = await rule({ name: 'Per konsult', kind: 'per_consultant', amount: 500 });

    // Utfall: Anna debiterade en dag i december och en dag i januari (8 h × 1200 − 8 h × 500 = 5600).
    addTime(w, { user_id: anna.id, date: '2025-12-01', activity_id: w.p1Activity, minutes: 480 });
    addTime(w, { user_id: anna.id, date: '2026-01-05', activity_id: w.p1Activity, minutes: 480 });
  });
  after(async () => {
    setTodayForTests(null);
    await w.close();
  });

  const stats = async (client = bo.client, q = '') => (await client.get(`/api/stats${q}`)).json;
  const row = (s, ruleId, label) => s.timeline.find((r) => r.rule_id === ruleId && r.period_label === label);

  test('prognos per månad: arbetsdagar × 5600 × 10 %', async () => {
    const s = await stats();
    assert.deepEqual([row(s, ids.month, '2026-01').commission, row(s, ids.month, '2026-01').state], [12320, 'running']);
    assert.equal(row(s, ids.month, '2026-02').commission, 11200);
    assert.equal(row(s, ids.month, '2026-02').state, 'forecast');
    assert.equal(row(s, ids.month, '2026-03').commission, 12320);
    assert.equal(row(s, ids.month, '2026-01').tb, 123200, '22 × 5600');
  });

  test('efter uppdraget räknas bänk: negativ TB, golvas, och tar slut vid 300 timmar', async () => {
    const s = await stats();
    const apr = row(s, ids.month, '2026-04');
    assert.deepEqual([apr.tb, apr.raw_commission, apr.floored, apr.commission, apr.capped_hours], [-88000, -8800, true, 0, 0], '22 × 8 h × 500');
    const may = row(s, ids.month, '2026-05');
    assert.deepEqual([may.tb, may.tb_actual, may.capped_hours], [-62000, -84000, 44], '176 h förbrukade, 124 h kvar av 300');
    assert.deepEqual([row(s, ids.month, '2026-06').tb, row(s, ids.month, '2026-06').commission], [0, 0], 'efter 300 timmar räknas 0');
  });

  test('kvartal summerar månaderna i perioden', async () => {
    const s = await stats();
    assert.deepEqual([row(s, ids.quarter, 'Q1 2026').tb, row(s, ids.quarter, 'Q1 2026').commission], [358400, 35840]);
    assert.equal(row(s, ids.quarter, 'Q2 2026').tb, -150000, '−88 000 − 62 000 + 0');
    assert.equal(row(s, ids.quarter, 'Q2 2026').commission, 0);
  });

  test('belopp per konsult följer uppdragen: 1 konsult jan–mars, sedan 0', async () => {
    const s = await stats();
    assert.deepEqual(['2026-01', '2026-03', '2026-04'].map((m) => row(s, ids.count, m).commission), [500, 500, 0]);
  });

  test('utfall från attesterad tid för passerade perioder, och "hittills" för den pågående', async () => {
    const s = await stats();
    const dec = row(s, ids.month, '2025-12');
    assert.deepEqual([dec.state, dec.commission, dec.tb], ['actual', 560, 5600]);
    assert.equal(row(s, ids.quarter, 'Q4 2025').commission, 560);
    assert.equal(row(s, ids.count, '2025-12').commission, 500);
    const jan = row(s, ids.month, '2026-01');
    assert.equal(jan.actual_to_date, 560, 'attesterat hittills: 5 januari');
    assert.equal(row(s, ids.quarter, 'Q1 2026').actual_to_date, 560);
  });

  test('summering per månad där provisionen tjänas in', async () => {
    const m = Object.fromEntries((await stats()).months.map((x) => [x.month, x]));
    assert.deepEqual([m['2025-12'].actual, m['2025-12'].forecast], [1620, 0], '560 + 560 (kvartalet slutar) + 500');
    assert.deepEqual([m['2026-01'].actual, m['2026-01'].forecast], [0, 12820], '12 320 + 500');
    assert.equal(m['2026-02'].forecast, 11700);
    assert.equal(m['2026-03'].forecast, 48660, '12 320 + 500 + kvartalet 35 840');
    assert.equal(m['2026-04'].forecast, 0);
    assert.equal(Object.keys(m).length, 23, '11 månader bakåt, innevarande månad och 11 framåt');
  });

  test('nyckeltal och konsultlista', async () => {
    const s = await stats();
    assert.equal(s.kpis.forecast_total, 73180, '35 840 + 35 840 + 1 500');
    assert.deepEqual([s.kpis.consultants, s.kpis.in_assignment, s.kpis.commission_ytd], [1, 1, 0]);
    assert.equal(s.kpis.tb_last_month, 5600);
    const a = s.consultants[0];
    assert.equal(a.name, 'Anna Konsult');
    assert.deepEqual(a.relation, ['Månad 10 %', 'Kvartal 10 %']);
    assert.equal(a.employment.tenure_days, daysBetween('2020-01-01', '2026-01-12'));
    assert.deepEqual([a.assignments[0].customer_name, a.assignments[0].days_left, a.in_assignment_now], ['Acme AB', 78, true]);
    assert.deepEqual([a.last_month.tb, a.last_month.billable_hours, a.this_month.tb, a.bench_hours], [5600, 8, 5600, 0]);
    assert.equal(a.forecast_tb_3m, 358400);
  });

  test('uppdrag som tar slut visas med vad de är värda för mottagaren', async () => {
    const s = await stats();
    assert.equal(s.expiring.length, 1);
    const e = s.expiring[0];
    assert.deepEqual([e.consultant, e.customer, e.end_date, e.days_left], ['Anna Konsult', 'Acme AB', '2026-03-31', 78]);
    // Utan uppdraget blir hela prognosen 0: bänk ger negativ TB som golvas, och inga konsulter i uppdrag.
    assert.equal(e.at_risk, 73180);
  });

  test('beläggningen skalar intäkt och kostnad: 90 % ger 11 088 i januari', async () => {
    await admin.patch('/api/settings', { forecast_utilization: 90 });
    assert.equal(row(await stats(), ids.month, '2026-01').commission, 11088, '123 200 × 0,9 × 10 %');
    await admin.patch('/api/settings', { forecast_utilization: 100 });
  });

  test('vad händer om: en ny konsult på 1000 kr/tim och 400 kr/tim i kostnad från 1 februari', async () => {
    const q = 'count=1&rate=1000&cost=400&start=2026-02-01&hours_per_week=40';
    const r = (await bo.client.get(`/api/stats/scenario?${q}`)).json;
    const m = Object.fromEntries(r.months.map((x) => [x.month, x]));
    // 4800 per arbetsdag. Februari: 20 dagar → 96 000 × 10 % = 9 600, plus 500 för en konsult till.
    assert.deepEqual([m['2026-02'].baseline, m['2026-02'].scenario, m['2026-02'].delta], [11700, 21800, 10100]);
    // Mars: 22 × 4800 = 105 600 → 10 560, plus 500, plus kvartalsregeln (96 000 + 105 600) × 10 % = 20 160.
    assert.equal(m['2026-03'].delta, 31220);
    // April: Annas negativa bänk (−88 000) kvittas mot den nya konsultens +105 600 → 17 600 × 10 % = 1 760, plus 500.
    assert.equal(m['2026-04'].delta, 2260);
    assert.equal(r.delta_total, r.scenario_total - r.baseline_total);
    assert.ok(r.delta_total > 0);
  });

  test('en tänkt konsult påverkar inte månaderna före sin start', async () => {
    const r = (await bo.client.get('/api/stats/scenario?count=1&rate=1000&cost=400&start=2026-02-01')).json;
    const jan = r.months.find((x) => x.month === '2026-01');
    assert.deepEqual([jan.baseline, jan.scenario, jan.delta], [12820, 12820, 0], 'ingen bänkkostnad i januari');
  });

  test('ett scenario med slutdatum och flera konsulter', async () => {
    const q = 'count=2&rate=1000&cost=400&start=2026-02-01&length_months=1';
    const r = (await bo.client.get(`/api/stats/scenario?${q}`)).json;
    const m = Object.fromEntries(r.months.map((x) => [x.month, x]));
    assert.equal(m['2026-02'].delta, 2 * 9600 + 2 * 500, 'två konsulter, bara februari');
    assert.equal(m['2026-04'].delta, 0, 'uppdraget har tagit slut och påverkar inte april');
  });

  test('ogiltigt scenario avvisas', async () => {
    const bad = async (q, why) => assert.equal((await bo.client.get(`/api/stats/scenario?${q}`)).status, 400, why);
    await bad('count=0&rate=1000&cost=400', 'noll konsulter');
    await bad('count=1&cost=400', 'saknar pris');
    await bad('count=1&rate=1000', 'saknar kostnad');
    await bad('count=1&rate=1000&cost=400&start=2025-01-01', 'start bakåt i tiden');
    await bad('count=1&rate=1000&cost=400&months=99', 'för lång horisont');
    await bad('count=99&rate=1000&cost=400', 'för många');
  });

  test('var och en ser bara sin egen statistik, administratör kan välja', async () => {
    assert.equal((await stats(bo.client, `?earner_id=${cia.id}`)).earner.name, 'Bo AM', 'parametern ignoreras');
    const nothing = await stats(eve.client);
    assert.deepEqual([nothing.consultants.length, nothing.timeline.length, nothing.kpis.forecast_total], [0, 0, 0]);
    assert.equal((await stats(admin, `?earner_id=${bo.id}`)).kpis.forecast_total, 73180);
    assert.equal((await admin.get('/api/stats/people')).json.length, 1);
    assert.equal((await bo.client.get('/api/stats/people')).status, 403);
  });

  test('BM ser sina konsulter även utan provisionsregler', async () => {
    assert.equal((await cia.client.get('/api/auth/me')).json.user.has_stats, false);
    await admin.patch(`/api/users/${anna.id}`, { bm_id: cia.id });
    assert.equal((await cia.client.get('/api/auth/me')).json.user.has_stats, true);
    const s = await stats(cia.client);
    assert.deepEqual(s.consultants.map((c) => [c.name, c.relation]), [['Anna Konsult', ['BM']]]);
    assert.equal(s.consultants[0].forecast_tb_3m, 358400, 'prognosen finns även för konsulter utan regel');
    assert.equal(s.kpis.forecast_total, 0, 'utan regler ingen provision');
  });

  // Avtalsregistret ─────────────────────────────────────────────────────
  test('anställningar: överlapp, visstid och datum valideras', async () => {
    const post = (b) => admin.post('/api/employments', b);
    assert.equal((await post({ user_id: anna.id, start_date: '2025-06-01' })).status, 409, 'överlappar tillsvidareanställningen');
    assert.equal((await post({ user_id: eve.id, start_date: '2025-06-01', type: 'fixed_term' })).status, 400, 'visstid kräver slutdatum');
    assert.equal((await post({ user_id: eve.id, start_date: '2025-06-01', end_date: '2025-05-01' })).status, 400);
    assert.equal((await post({ user_id: 9999, start_date: '2025-06-01' })).status, 400);
    const ok = await post({ user_id: eve.id, start_date: '2025-06-01', end_date: '2026-05-31', type: 'fixed_term', notice_months: 1 });
    assert.equal(ok.status, 200);
    assert.equal((await admin.patch(`/api/employments/${ok.json.id}`, { end_date: null })).status, 400, 'visstid utan slut');
    assert.equal((await admin.del(`/api/employments/${ok.json.id}`)).status, 200);
  });

  test('uppdrag: samtidiga uppdrag får inte överstiga arbetstiden', async () => {
    const post = (b) => admin.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, hourly_rate: 900, ...b });
    assert.equal((await post({ start_date: '2026-02-01', end_date: '2026-02-28', hours_per_week: 8 })).status, 409, '40 + 8 > 40');
    assert.equal((await post({ start_date: '2026-04-01', hours_per_week: 20 })).status, 200, 'efter det första uppdraget');
    const second = await post({ start_date: '2026-04-15', end_date: '2026-06-30', hours_per_week: 20 });
    assert.equal(second.status, 200, '20 + 20 = 40 är tillåtet');
    assert.equal((await post({ start_date: '2026-05-01', end_date: '2026-05-31', hours_per_week: 1 })).status, 409);
    assert.equal((await post({ start_date: '2026-04-01', hours_per_week: 50 })).status, 409, 'mer än arbetstiden');
    assert.equal((await post({ start_date: '2026-07-01', hours_per_week: 0 })).status, 400);
    assert.equal((await post({ start_date: '2026-07-01', customer_id: 9999, hours_per_week: 10 })).status, 400);
    const other = (await admin.post('/api/customers', { name: 'Annan kund' })).json.id;
    assert.equal((await post({ start_date: '2026-07-01', customer_id: other, project_id: w.p1, hours_per_week: 10 })).status, 400, 'projektet tillhör Acme');
    assert.equal((await admin.patch(`/api/assignments/${second.json.id}`, { hours_per_week: 30 })).status, 409);
    assert.equal((await admin.del(`/api/assignments/${second.json.id}`)).status, 200);
  });

  test('luckor i registret ger varningar', async () => {
    await admin.patch(`/api/users/${eve.id}`, { bm_id: cia.id }); // Eve är konsult men saknar avtal
    const w2 = (await admin.get('/api/contracts/warnings')).json;
    const texts = w2.map((x) => x.text).join('\n');
    assert.match(texts, /Eve Utomstående har inget pågående eller kommande uppdrag/);
    assert.match(texts, /Eve Utomstående saknar anställningsavtal/);
    assert.match(texts, /Anna Konsults uppdrag hos Acme AB tar slut 2026-03-31 \(om 78 dagar\)/);
    const s = await stats(cia.client);
    assert.ok(s.warnings.some((x) => x.includes('Eve Utomstående') && x.includes('bänktid')));
  });

  test('bara administratörer når avtalsregistret', async () => {
    for (const url of ['/api/employments', '/api/assignments', '/api/contracts/warnings']) {
      assert.equal((await bo.client.get(url)).status, 403, url);
    }
    assert.equal((await bo.client.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, start_date: '2026-09-01', hourly_rate: 1, hours_per_week: 1 })).status, 403);
    assert.equal((await bo.client.patch('/api/settings', { forecast_utilization: 100 })).status, 403);
    assert.equal((await admin.patch('/api/settings', { forecast_utilization: 0 })).status, 400);
    assert.equal((await admin.patch('/api/settings', { forecast_utilization: 101 })).status, 400);
  });
});
