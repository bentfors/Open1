// CSV för svensk Excel: semikolon som avgränsare, decimalkomma, BOM för teckenkodningen.
function cell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value).replace('.', ',') : String(value);
  // Skydd mot formelinjektion när filen öppnas i Excel.
  if (/^[=+\-@\t\r]/.test(s) && typeof value !== 'number') s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.label)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
