import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildWorld, seedApprovedWeek, addTime } from './world.js';
import { MIGRATIONS, migrate } from '../src/db.js';

// Underlag: Annas mars 2025 från seedApprovedWeek, TB 6200 (se world.js).
describe('provisionsregler', () => {
  let w, anna, dan, eve, bo, cia, carl, admin;
  const ids = {};

  before(async () => {
    w = await buildWorld();
    ({ anna, dan, eve, bo, cia, carl } = w.users);
    admin = w.admin;
    await seedApprovedWeek(w);
  });
  after(() => w.close());

  const create = async (body) => {
    const r = await admin.post('/api/commission-rules', body);
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  const report = async (from, to, extra = '', client = admin) => (await client.get(`/api/reports/commission?from=${from}&to=${to}${extra}`)).json;
  const rowsOf = (data, ruleId) => data.rows.filter((r) => r.rule_id === ruleId);

  test('procent av TB per månad: 10 % av 6200 = 620', async () => {
    ids.bo = await create({ earner_id: bo.id, name: 'Bo 10 %', kind: 'tb_percent', period: 'month', percent: 10, source_ids: [anna.id] });
    const [row, ...rest] = rowsOf(await report('2025-03-01', '2025-03-31'), ids.bo);
    assert.equal(rest.length, 0);
    assert.equal(row.period_label, '2025-03');
    assert.equal(row.tb, 6200);
    assert.equal(row.commission, 620);
    assert.equal(row.complete, true);
    assert.deepEqual(row.sources.map((s) => [s.name, s.tb, s.hours]), [['Anna Konsult', 6200, 14]]);
  });

  test('kvartalsregel räknar hela kvartalet: 5 % av 6200 = 310', async () => {
    ids.cia = await create({ earner_id: cia.id, kind: 'tb_percent', period: 'quarter', percent: 5, source_ids: [anna.id] });
    const [row] = rowsOf(await report('2025-03-01', '2025-03-31'), ids.cia);
    assert.equal(row.period_label, 'Q1 2025');
    assert.equal(row.period_start, '2025-01-01');
    assert.equal(row.period_end, '2025-03-31');
    assert.equal(row.commission, 310);

    const two = rowsOf(await report('2025-03-01', '2025-04-30'), ids.cia);
    assert.deepEqual(two.map((r) => r.period_label), ['Q1 2025', 'Q2 2025']);
    assert.equal(two[1].commission, 0);
  });

  test('en period som inte är slut markeras som pågående', async () => {
    const year = new Date().getFullYear() + 1;
    const [row] = rowsOf(await report(`${year}-01-01`, `${year}-01-31`), ids.bo);
    assert.equal(row.complete, false);
  });

  test('kvartal nettar en negativ månad, månad golvas vid noll', async () => {
    const jan = addTime(w, { user_id: anna.id, date: '2025-01-13', activity_id: w.meeting, minutes: 480 }); // kostnad 4000, ingen intäkt
    ids.boNoFloor = await create({ earner_id: bo.id, name: 'Utan golv', kind: 'tb_percent', period: 'month', percent: 10, floor_zero: false, source_ids: [anna.id] });

    const data = await report('2025-01-01', '2025-01-31');
    const floored = rowsOf(data, ids.bo)[0];
    assert.equal(floored.tb, -4000);
    assert.equal(floored.commission, 0, 'golvad');
    assert.equal(rowsOf(data, ids.boNoFloor)[0].commission, -400, 'utan golv');
    assert.equal(rowsOf(data, ids.cia)[0].tb, 2200, '6200 − 4000 över kvartalet');
    assert.equal(rowsOf(data, ids.cia)[0].commission, 110);

    w.app.db.prepare('DELETE FROM time_entries WHERE id = ?').run(jan);
    await admin.del(`/api/commission-rules/${ids.boNoFloor}`);
  });

  test('giltighetstid på regeln klipper bort poster utanför', async () => {
    const from = await create({ earner_id: dan.id, kind: 'tb_percent', period: 'month', percent: 20, valid_from: '2025-03-05', source_ids: [anna.id] });
    assert.equal(rowsOf(await report('2025-03-01', '2025-03-31'), from)[0].tb, 1600, 'bara fastprisdagen: 3600 − 2000');
    const until = await create({ earner_id: dan.id, kind: 'tb_percent', period: 'month', percent: 20, valid_to: '2025-03-04', source_ids: [anna.id] });
    const row = rowsOf(await report('2025-03-01', '2025-03-31'), until)[0];
    assert.equal(row.tb, 4600, '5600 − 1000');
    assert.equal(row.commission, 920);
    await admin.del(`/api/commission-rules/${from}`);
    await admin.del(`/api/commission-rules/${until}`);
  });

  test('belopp per konsult i uppdrag, med tröskel och kategori', async () => {
    addTime(w, { user_id: dan.id, date: '2025-03-12', activity_id: w.p1Activity, minutes: 120 }); // 2 h
    addTime(w, { user_id: eve.id, date: '2025-03-13', activity_id: w.p1Activity, minutes: 300 }); // 5 h
    // Anna har 12 debiterbara timmar i mars (8 + 4 fast pris). Frånvaro och ej debiterbar tid räknas inte.
    ids.count = await create({ earner_id: carl.id, name: 'Chefsbonus', kind: 'per_consultant', period: 'month', amount: 500 });
    let row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.count)[0];
    assert.equal(row.consultants, 3);
    assert.equal(row.commission, 1500);
    assert.deepEqual(row.months, [{ month: '2025-03', consultants: 3 }]);

    assert.equal((await admin.patch(`/api/commission-rules/${ids.count}`, { min_hours: 4 })).status, 200);
    row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.count)[0];
    assert.equal(row.consultants, 2, 'bara Anna (12 h) och Eve (5 h) når 4 timmar');
    assert.equal(row.commission, 1000);

    assert.equal((await admin.patch(`/api/commission-rules/${ids.count}`, { min_hours: 0, category_ids: [w.categories['Konsult Expert']] })).status, 200);
    row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.count)[0];
    assert.equal(row.consultants, 1, 'bara kategorin Konsult Expert');
    assert.equal(row.commission, 500);
    assert.equal(row.sources.length, 0);
    assert.equal(row.tb, null);

    await admin.patch(`/api/commission-rules/${ids.count}`, { category_ids: [] });
  });

  test('kvartal summerar konsultmånader: 0 + 1 + 3 = 4 × 500', async () => {
    addTime(w, { user_id: anna.id, date: '2025-02-10', activity_id: w.p1Activity, minutes: 60 }); // 1 h × (1200 − 500) = TB 700
    assert.equal((await admin.patch(`/api/commission-rules/${ids.count}`, { period: 'quarter' })).status, 200);
    const row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.count)[0];
    assert.deepEqual(row.months.map((m) => m.consultants), [0, 1, 3]);
    assert.equal(row.consultants, 4);
    assert.equal(row.commission, 2000);
    await admin.patch(`/api/commission-rules/${ids.count}`, { period: 'month' });
  });

  test('trappa: procent av TB väljs av antal konsulter i uppdrag', async () => {
    ids.tier = await create({
      earner_id: carl.id,
      name: 'Trappa',
      kind: 'tb_tiered',
      period: 'month',
      source_ids: [anna.id],
      tiers: [{ min: 3, percent: 8 }, { min: 0, percent: 4 }],
    });
    let row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.tier)[0];
    assert.equal(row.consultants, 3);
    assert.equal(row.percent, 8);
    assert.equal(row.commission, 496, '8 % av 6200');

    await admin.patch(`/api/commission-rules/${ids.tier}`, { min_hours: 4 });
    row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.tier)[0];
    assert.equal(row.consultants, 2);
    assert.equal(row.percent, 4);
    assert.equal(row.commission, 248);

    // Kvartal: månadsantalen 0, 1, 3 ger snittet 1,33 → 1 konsult → 4 %. TB: 6200 + 700 = 6900.
    await admin.patch(`/api/commission-rules/${ids.tier}`, { min_hours: 0, period: 'quarter' });
    row = rowsOf(await report('2025-03-01', '2025-03-31'), ids.tier)[0];
    assert.equal(row.consultants, 1);
    assert.equal(row.tb, 6900);
    assert.equal(row.commission, 276);
  });

  test('bara godkänd tid räknas, om man inte ber om allt', async () => {
    const open = addTime(w, { user_id: anna.id, date: '2025-03-10', activity_id: w.p1Activity, minutes: 60, status: 'open' });
    assert.equal(rowsOf(await report('2025-03-01', '2025-03-31'), ids.bo)[0].commission, 620);
    assert.equal(rowsOf(await report('2025-03-01', '2025-03-31', '&status=all'), ids.bo)[0].commission, 690, '(6200 + 700) × 10 %');
    w.app.db.prepare('DELETE FROM time_entries WHERE id = ?').run(open);
  });

  test('mottagare ser bara sina egna rader, ingen annans', async () => {
    const mine = await report('2025-03-01', '2025-03-31', '', bo.client);
    assert.ok(mine.rows.length >= 1);
    assert.ok(mine.rows.every((r) => r.earner_id === bo.id));
    assert.deepEqual(mine.earners.map((e) => e.name), ['Bo AM']);
    assert.equal((await report('2025-03-01', '2025-03-31', '', eve.client)).rows.length, 0);
    assert.equal((await report('2025-03-01', '2025-03-31', '', anna.client)).rows.length, 0, 'konsulten ser inte vem som får provision på hens TB');
    // Mottagaren kan inte låtsas vara någon annan via parametern.
    assert.ok((await report('2025-03-01', '2025-03-31', `&earner_id=${cia.id}`, bo.client)).rows.every((r) => r.earner_id === bo.id));
    const onlyCia = await report('2025-03-01', '2025-03-31', `&earner_id=${cia.id}`);
    assert.ok(onlyCia.rows.every((r) => r.earner_id === cia.id));
  });

  test('rutter för regler kräver administratör', async () => {
    assert.equal((await bo.client.get('/api/commission-rules')).status, 403);
    assert.equal((await bo.client.post('/api/commission-rules', { earner_id: bo.id, kind: 'per_consultant', period: 'month', amount: 99999 })).status, 403);
    assert.equal((await bo.client.patch(`/api/commission-rules/${ids.bo}`, { percent: 100 })).status, 403);
    assert.equal((await bo.client.del(`/api/commission-rules/${ids.bo}`)).status, 403);
  });

  test('ogiltiga regler avvisas', async () => {
    const bad = async (body, why) => assert.equal((await admin.post('/api/commission-rules', { earner_id: bo.id, period: 'month', ...body })).status, 400, why);
    await bad({ kind: 'tb_percent', percent: 10 }, 'saknar konsulter');
    await bad({ kind: 'tb_percent', source_ids: [anna.id] }, 'saknar procent');
    await bad({ kind: 'tb_percent', percent: 101, source_ids: [anna.id] }, 'över 100 %');
    await bad({ kind: 'per_consultant' }, 'saknar belopp');
    await bad({ kind: 'per_consultant', amount: -5 }, 'negativt belopp');
    await bad({ kind: 'nonsens', percent: 5 }, 'okänd typ');
    await bad({ kind: 'tb_percent', percent: 5, source_ids: [9999] }, 'okänd konsult');
    await bad({ kind: 'tb_percent', percent: 5, source_ids: [anna.id], valid_from: '2025-05-01', valid_to: '2025-04-01' }, 'slut före start');
    await bad({ kind: 'tb_tiered', source_ids: [anna.id] }, 'saknar trappsteg');
    await bad({ kind: 'tb_tiered', source_ids: [anna.id], tiers: [{ min: 2, percent: 5 }] }, 'första steget måste börja på 0');
    await bad({ kind: 'tb_tiered', source_ids: [anna.id], tiers: [{ min: 0, percent: 5 }, { min: 0, percent: 6 }] }, 'samma gräns två gånger');
    await bad({ kind: 'tb_tiered', source_ids: [anna.id], tiers: [{ min: 0, percent: 500 }] }, 'procent över 100');
    assert.equal((await admin.post('/api/commission-rules', { earner_id: 9999, kind: 'per_consultant', period: 'month', amount: 5 })).status, 400);
    assert.equal((await admin.patch('/api/commission-rules/9999', { percent: 5 })).status, 404);
  });

  test('byte av regeltyp rensar fält som inte längre hör dit', async () => {
    const id = await create({ earner_id: bo.id, kind: 'tb_percent', period: 'month', percent: 10, source_ids: [anna.id] });
    assert.equal((await admin.patch(`/api/commission-rules/${id}`, { kind: 'per_consultant', amount: 300 })).status, 200);
    const rule = (await admin.get('/api/commission-rules')).json.find((r) => r.id === id);
    assert.equal(rule.percent, null);
    assert.equal(rule.amount, 300);
    assert.deepEqual(rule.sources, []);
    await admin.del(`/api/commission-rules/${id}`);
    assert.equal((await admin.get('/api/commission-rules')).json.some((r) => r.id === id), false);
  });

  test('CSV-export av provision', async () => {
    const r = await admin.get('/api/reports/commission?from=2025-03-01&to=2025-03-31&format=csv');
    assert.equal(r.status, 200);
    assert.ok(r.text.startsWith('﻿Mottagare;'));
    assert.match(r.text, /Procent av TB/);
    assert.match(r.text, /Belopp per konsult/);
    assert.match(r.headers.get('content-disposition'), /provision-2025-03-01-2025-03-31\.csv/);
  });

  test('för långa intervall avvisas', async () => {
    assert.equal((await admin.get('/api/reports/commission?from=2010-01-01&to=2025-03-31')).status, 400);
  });
});

describe('migrering av gamla provisionskopplingar', () => {
  test('en koppling blir en månadsregel med samma procent, utan golv', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(MIGRATIONS[0]);
    db.exec('PRAGMA user_version = 1');
    db.exec(`INSERT INTO users (email, name, password_hash) VALUES ('a@t.se','Anna','x'), ('b@t.se','Bo','x')`);
    db.exec(`INSERT INTO commission_links (earner_id, source_id, percent, valid_from, valid_to) VALUES (2, 1, 7.5, '2025-01-01', NULL)`);
    db.exec(`INSERT INTO customers (name) VALUES ('Acme')`);
    db.exec(`INSERT INTO invoices (customer_id, period_from, period_to, total_amount, created_at)
             VALUES (1, '2025-01-01', '2025-01-31', 100, '2025-02-03 10:00:00')`);

    migrate(db);

    // Befintliga underlag får fakturadatum från skapandedatum, så att upplupet räknar dem som fakturerade.
    assert.equal(db.prepare('SELECT invoice_date FROM invoices').get().invoice_date, '2025-02-03');
    assert.equal(db.prepare('SELECT waived_at FROM time_entries LIMIT 1').get(), undefined);

    const rules = db.prepare('SELECT * FROM commission_rules').all();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].kind, 'tb_percent');
    assert.equal(rules[0].period, 'month');
    assert.equal(rules[0].percent, 7.5);
    assert.equal(rules[0].floor_zero, 0);
    assert.equal(rules[0].earner_id, 2);
    assert.equal(rules[0].valid_from, '2025-01-01');
    assert.deepEqual(db.prepare('SELECT user_id FROM commission_rule_sources WHERE rule_id = ?').all(rules[0].id).map((r) => r.user_id), [1]);
    assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'commission_links'`).get(), undefined);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  });
});
