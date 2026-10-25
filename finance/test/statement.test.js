import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseDate, parseStatement } from '../src/statement.js';

describe('belopp', () => {
  const cases = [
    ['1 234,56', 123456],
    ['−1 234,56', -123456], // riktigt minustecken
    ['1 234,56', 123456], // hårt mellanslag
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['-1234.56', -123456],
    ['123,45-', -12345],
    ['1234', 123400],
    ['500 kr', 50000],
    ['12,5', 1250],
    ['+99,00', 9900],
    ['0,05', 5],
  ];
  for (const [input, expected] of cases) test(JSON.stringify(input), () => assert.equal(parseAmount(input), expected));
  for (const bad of ['', 'abc', '12-34', null, '1,2,3x']) test(`ogiltigt: ${JSON.stringify(bad)}`, () => assert.equal(parseAmount(bad), null));
});

describe('datum', () => {
  test('format', () => {
    assert.equal(parseDate('2025-03-04'), '2025-03-04');
    assert.equal(parseDate('2025/3/4'), '2025-03-04');
    assert.equal(parseDate('04/03/2025'), '2025-03-04');
    assert.equal(parseDate('04.03.2025'), '2025-03-04');
    assert.equal(parseDate('20250304'), '2025-03-04');
  });
  test('omöjliga datum avvisas', () => {
    assert.equal(parseDate('2025-02-30'), null);
    assert.equal(parseDate('2025-13-01'), null);
    assert.equal(parseDate('hej'), null);
  });
});

describe('kontoutdrag', () => {
  test('semikolon med rubriker och saldo', () => {
    const r = parseStatement('Bokföringsdag;Valutadag;Text;Belopp;Saldo\n2025-03-04;2025-03-04;ICA MAXI;-234,50;10 765,50\n2025-03-03;2025-03-03;LÖN ACME AB;30 000,00;11 000,00\n');
    assert.deepEqual(r.mapping, { date: 0, description: 2, amount: 3, balance: 4 });
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], { line: 2, date: '2025-03-04', description: 'ICA MAXI', amount: -23450, balance: 1076550 });
  });

  test('tabbseparerat utan rubriker, som när man markerar och kopierar från bankens webb', () => {
    const r = parseStatement('2025-03-04\tICA\t-234,50\t10 000,50\n2025-03-05\tSwish till Anna\t-100,00\t9 900,50');
    assert.deepEqual(r.mapping, { date: 0, description: 1, amount: 2, balance: 3 });
    assert.equal(r.rows[1].description, 'Swish till Anna');
    assert.equal(r.rows[1].amount, -10000);
  });

  test('utan saldokolumn', () => {
    const r = parseStatement('2025-03-04;ICA;-234,50\n2025-03-05;Hyra;-8 000,00');
    assert.equal(r.mapping.balance, null);
    assert.equal(r.rows.length, 2);
  });

  test('citattecken och semikolon i text', () => {
    const r = parseStatement('Datum;Text;Belopp\n2025-03-04;"Kafé; centrum";-45,00\n2025-03-05;"Han sa ""hej""";-10,00');
    assert.equal(r.rows[0].description, 'Kafé; centrum');
    assert.equal(r.rows[1].description, 'Han sa "hej"');
  });

  test('rader som inte går att tolka hoppas över och redovisas', () => {
    const r = parseStatement('Datum;Text;Belopp\n2025-03-04;ICA;-234,50\nSumma;;-234,50\n2025-03-05;Hyra;abc');
    assert.equal(r.rows.length, 1);
    assert.equal(r.skipped.length, 2);
    assert.match(r.skipped[0].reason, /Datum/);
    assert.match(r.skipped[1].reason, /Belopp/);
  });

  test('BOM och Windows-radslut', () => {
    const r = parseStatement('﻿Datum;Text;Belopp\r\n2025-03-04;ICA;-234,50\r\n');
    assert.equal(r.rows.length, 1);
  });

  test('manuell kolumnkoppling går före gissningen', () => {
    const r = parseStatement('2025-03-04;ICA;-234,50;10 000,50', { amount: 3, balance: null });
    assert.equal(r.rows[0].amount, 1000050);
  });

  test('tom text ger tomt resultat', () => {
    assert.deepEqual(parseStatement('   \n').rows, []);
  });
});
