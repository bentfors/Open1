import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { easterSunday, holidaysOfYear, holidayName, isWorkday, workdaysBetween, normMinutes, holidaysBetween } from '../src/holidays.js';
import { buildWorld } from './world.js';
import { createUser } from './helpers.js';

describe('svenska helgdagar', () => {
  test('påskdagen', () => {
    const known = { 2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16', 2038: '2038-04-25' };
    for (const [year, date] of Object.entries(known)) assert.equal(easterSunday(Number(year)), date, year);
  });

  test('alla helgdagar 2026, med rörliga dagar på rätt veckodag', () => {
    const list = Object.fromEntries(holidaysOfYear(2026).map((x) => [x.name, x.date]));
    assert.deepEqual(list, {
      Nyårsdagen: '2026-01-01',
      'Trettondedag jul': '2026-01-06',
      Långfredagen: '2026-04-03',
      Påskafton: '2026-04-04',
      Påskdagen: '2026-04-05',
      'Annandag påsk': '2026-04-06',
      'Första maj': '2026-05-01',
      'Kristi himmelsfärdsdag': '2026-05-14',
      Pingstdagen: '2026-05-24',
      'Sveriges nationaldag': '2026-06-06',
      Midsommarafton: '2026-06-19',
      Midsommardagen: '2026-06-20',
      'Alla helgons dag': '2026-10-31',
      Julafton: '2026-12-24',
      Juldagen: '2026-12-25',
      'Annandag jul': '2026-12-26',
      Nyårsafton: '2026-12-31',
    });
    // Midsommarafton är alltid en fredag, alla helgons dag en lördag mellan 31 okt och 6 nov.
    assert.deepEqual([holidayName('2027-06-25'), holidayName('2027-11-06'), holidayName('2025-11-01')], ['Midsommarafton', 'Alla helgons dag', 'Alla helgons dag']);
  });

  test('aftnarna räknas bara som lediga när inställningen säger så', () => {
    assert.equal(holidayName('2026-12-24'), 'Julafton');
    assert.equal(holidayName('2026-12-24', { eves: false }), null);
    assert.equal(holidayName('2026-12-25', { eves: false }), 'Juldagen');
    assert.equal(isWorkday('2026-06-19'), false);
    assert.equal(isWorkday('2026-06-19', { eves: false }), true);
    assert.equal(isWorkday('2026-06-18'), true);
    assert.equal(isWorkday('2026-06-20'), false, 'lördag');
  });

  test('arbetsdagar per månad 2026', () => {
    const days = (from, to, opts) => workdaysBetween(from, to, opts);
    assert.deepEqual(
      [days('2026-01-01', '2026-01-31'), days('2026-02-01', '2026-02-28'), days('2026-04-01', '2026-04-30'), days('2026-05-01', '2026-05-31'), days('2026-06-01', '2026-06-30'), days('2026-12-01', '2026-12-31')],
      [20, 20, 20, 19, 21, 20],
    );
    assert.equal(days('2026-12-01', '2026-12-31', { eves: false }), 22, 'jul- och nyårsafton blir arbetsdagar');
    // 2026: 52 hela veckor plus en torsdag = 261 vardagar. Tio helgdagar och aftnar på vardagar ger 251.
    assert.equal(days('2026-01-01', '2026-12-31'), 251);
  });

  test('normtid: helgdagar och dagar utanför anställningen räknas bort', () => {
    const anna = { weekly_hours: 40 };
    assert.equal(normMinutes(anna, '2026-05-11', '2026-05-17'), 4 * 480, 'Kristi himmelsfärd på torsdagen');
    assert.equal(normMinutes({ weekly_hours: 20 }, '2026-05-11', '2026-05-17'), 4 * 240, 'deltid, 4 tim per dag');
    assert.equal(normMinutes({ weekly_hours: 37.5 }, '2026-02-02', '2026-02-08'), 5 * 450);
    const startsWednesday = { weekly_hours: 40, employments: [{ start_date: '2026-05-13', end_date: null }] };
    assert.equal(normMinutes(startsWednesday, '2026-05-11', '2026-05-17'), 2 * 480, 'onsdag och fredag');
    const ended = { weekly_hours: 40, employments: [{ start_date: '2020-01-01', end_date: '2026-05-12' }] };
    assert.equal(normMinutes(ended, '2026-05-11', '2026-05-17'), 2 * 480, 'måndag och tisdag');
    assert.equal(normMinutes({ weekly_hours: 0 }, '2026-05-11', '2026-05-17'), 0);
  });

  test('helgdagar mellan två datum, över årsskiftet', () => {
    assert.deepEqual(
      holidaysBetween('2026-12-24', '2027-01-06').map((x) => x.date),
      ['2026-12-24', '2026-12-25', '2026-12-26', '2026-12-31', '2027-01-01', '2027-01-06'],
    );
    assert.deepEqual(holidaysBetween('2026-12-24', '2026-12-31', { eves: false }).map((x) => x.name), ['Juldagen', 'Annandag jul']);
  });
});

describe('veckovyn och helgdagar', () => {
  let w, admin, anna;
  before(async () => {
    w = await buildWorld();
    admin = w.admin;
    anna = w.users.anna;
  });
  after(() => w.close());

  test('veckan visar helgdagarna och rätt normtid', async () => {
    const week = (await anna.client.get('/api/time/week?start=2026-05-11')).json;
    assert.deepEqual(week.holidays, { '2026-05-14': 'Kristi himmelsfärdsdag' });
    assert.equal(week.norm_minutes, 32 * 60);
    const easter = (await anna.client.get('/api/time/week?start=2026-04-06')).json;
    assert.equal(easter.norm_minutes, 32 * 60, 'annandag påsk');
    const plain = (await anna.client.get('/api/time/week?start=2026-02-02')).json;
    assert.deepEqual([plain.holidays, plain.norm_minutes], [{}, 40 * 60]);
  });

  test('inställningen för aftnar slår igenom, och bara administratörer ändrar den', async () => {
    const midsummer = async () => (await anna.client.get('/api/time/week?start=2026-06-15')).json;
    assert.deepEqual([(await midsummer()).norm_minutes, (await midsummer()).holidays['2026-06-19']], [32 * 60, 'Midsommarafton']);
    assert.equal((await admin.patch('/api/settings', { holiday_eves_off: false })).status, 200);
    assert.equal((await admin.get('/api/settings')).json.holiday_eves_off, false);
    assert.deepEqual([(await midsummer()).norm_minutes, (await midsummer()).holidays['2026-06-19']], [40 * 60, undefined]);
    assert.equal((await midsummer()).holidays['2026-06-20'], 'Midsommardagen', 'helgdagar på helgen visas ändå');

    const sup = await createUser(w.app, admin, { email: 'sup@t.se', name: 'Sup', finance: 2 });
    assert.equal((await sup.client.patch('/api/settings', { holiday_eves_off: true })).status, 403);
    assert.equal((await anna.client.patch('/api/settings', { holiday_eves_off: true })).status, 403);
    assert.equal((await admin.patch('/api/settings', { holiday_eves_off: 'ja' })).status, 400);
    assert.equal((await admin.patch('/api/settings', { holiday_eves_off: true })).status, 200);
    const log = (await admin.get('/api/audit?entity=setting')).json.rows;
    assert.deepEqual(log[0].changes, [{ field: 'Midsommar-, jul- och nyårsafton lediga', from: 'Nej', to: 'Ja' }]);
  });

  test('normtiden följer anställningen', async () => {
    await admin.post('/api/employments', { user_id: anna.id, start_date: '2026-05-13' });
    assert.equal((await anna.client.get('/api/time/week?start=2026-05-11')).json.norm_minutes, 2 * 480);
    assert.equal((await anna.client.get('/api/time/week?start=2026-05-04')).json.norm_minutes, 0, 'innan anställningen');
  });
});
