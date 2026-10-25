// Tolkar ett inklistrat kontoutdrag (text från bankens webb eller en CSV-fil) till transaktioner.
// Bankerna skiljer sig åt, så tolkningen gissar kolumnroller och användaren bekräftar i förhandsvisningen.

const MINUS = /[−–‒]/g; // − – ‒
const SPACES = /[\s  ]/g;

export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(MINUS, '-').replace(/\b(SEK|kr)\b\.?/gi, '').replace(SPACES, '');
  if (!s) return null;
  let negative = false;
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep = null;
  if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.';
  else if (lastComma >= 0) decimalSep = /,\d{1,2}$/.test(s) && s.indexOf(',') === lastComma ? ',' : null;
  else if (lastDot >= 0) decimalSep = /\.\d{1,2}$/.test(s) && s.indexOf('.') === lastDot ? '.' : null;
  let intPart = s;
  let frac = '';
  if (decimalSep) {
    const i = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, i);
    frac = s.slice(i + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart) || (frac && !/^\d+$/.test(frac))) return null;
  const ore = Number(intPart) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(ore)) return null;
  return negative ? -ore : ore;
}

export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [, d, mo, y] = m;
  else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [, y, mo, d] = m;
  else return null;
  y = Number(y);
  mo = Number(mo);
  d = Number(d);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > last) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function splitLine(line, delim) {
  if (delim === '2sp') return line.trim().split(/ {2,}/);
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === '') quoted = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// Väljer den avgränsare som ger flest kolumner jämnt över raderna.
function detectDelimiter(lines) {
  const sample = lines.slice(0, 30);
  let best = { delim: '\t', score: 0 };
  for (const delim of ['\t', ';', '|', ',', '2sp']) {
    const counts = sample.map((l) => splitLine(l, delim).length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode < 3) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    // Komma är sist i prioritet eftersom det också är decimaltecken.
    const score = consistent * 100 + mode - ['\t', ';', '|', ',', '2sp'].indexOf(delim);
    if (consistent >= 0.6 && score > best.score) best = { delim, score };
  }
  return best.delim;
}

const HEADER_ROLES = {
  date: /^(datum|bokf[öo]ringsdag(en)?|bokf\.?\s*datum|transaktionsdag(en)?|transaktionsdatum|valutadag|date|booking date)$/i,
  description: /^(text|beskrivning|transaktion|mottagare|avs[äa]ndare|rubrik|referens|meddelande|specifikation|description|name|namn)$/i,
  amount: /^(belopp|amount|summa|transaktionsbelopp|belopp\s*\(?sek\)?)$/i,
  balance: /^(saldo|balance|bokf[öo]rt saldo|behållning)$/i,
};

function guessMapping(rows, headers) {
  const cols = Math.max(...rows.map((r) => r.length));
  const mapping = { date: null, description: null, amount: null, balance: null };
  if (headers) {
    headers.forEach((hdr, i) => {
      const name = hdr.trim();
      for (const [role, re] of Object.entries(HEADER_ROLES)) {
        // Första träffen vinner: "Bokföringsdag" före "Valutadag".
        if (mapping[role] === null && re.test(name)) mapping[role] = i;
      }
    });
  }
  const sample = rows.slice(0, 50);
  const frac = (i, test) => sample.filter((r) => test(r[i] ?? '')).length / sample.length;
  if (mapping.date === null) {
    for (let i = 0; i < cols; i++) if (frac(i, (v) => parseDate(v) !== null) >= 0.8) { mapping.date = i; break; }
  }
  const numeric = [];
  for (let i = 0; i < cols; i++) {
    if (i === mapping.date) continue;
    if (frac(i, (v) => parseAmount(v) !== null && /\d/.test(v)) >= 0.8) numeric.push(i);
  }
  if (mapping.amount === null && mapping.balance === null) {
    // Utan rubriker: första numeriska kolumnen är belopp, nästa är saldo.
    if (numeric[0] !== undefined) mapping.amount = numeric[0];
    if (numeric[1] !== undefined) mapping.balance = numeric[1];
  } else if (mapping.amount === null) {
    mapping.amount = numeric.find((i) => i !== mapping.balance) ?? null;
  }
  if (mapping.description === null) {
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < cols; i++) {
      if ([mapping.date, mapping.amount, mapping.balance].includes(i)) continue;
      const avg = sample.reduce((n, r) => n + (r[i] ?? '').length, 0) / sample.length;
      if (avg > bestLen) {
        best = i;
        bestLen = avg;
      }
    }
    if (best >= 0) mapping.description = best;
  }
  return mapping;
}

/**
 * @returns {{ delimiter, headers: string[]|null, columns: number, mapping, rows: {line, date, description, amount, balance}[],
 *             skipped: {line, text, reason}[], preview: string[][] }}
 */
export function parseStatement(text, overrideMapping) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((l) => l.text.trim() !== '');
  if (!lines.length) return { delimiter: null, headers: null, columns: 0, mapping: {}, rows: [], skipped: [], preview: [] };

  const delim = detectDelimiter(lines.map((l) => l.text));
  const split = lines.map((l) => ({ line: l.line, text: l.text, cells: splitLine(l.text, delim).map((c) => c.trim()) }));

  // Rubrikrad: första raden saknar datum men har minst en känd rubrik.
  const first = split[0].cells;
  const looksHeader =
    !first.some((c) => parseDate(c)) && first.some((c) => Object.values(HEADER_ROLES).some((re) => re.test(c.trim())));
  const headers = looksHeader ? first : null;
  const body = looksHeader ? split.slice(1) : split;
  const columns = Math.max(...split.map((r) => r.cells.length));
  const mapping = { ...guessMapping(body.map((r) => r.cells), headers), ...(overrideMapping || {}) };

  const rows = [];
  const skipped = [];
  for (const r of body) {
    const date = mapping.date === null ? null : parseDate(r.cells[mapping.date]);
    const amount = mapping.amount === null ? null : parseAmount(r.cells[mapping.amount]);
    if (!date || amount === null) {
      skipped.push({ line: r.line, text: r.text.slice(0, 160), reason: !date ? 'Datum saknas eller kan inte tolkas' : 'Belopp saknas eller kan inte tolkas' });
      continue;
    }
    const description = (mapping.description === null ? '' : r.cells[mapping.description] || '').replace(/\s+/g, ' ').trim();
    const balance = mapping.balance === null ? null : parseAmount(r.cells[mapping.balance]);
    rows.push({ line: r.line, date, description: description || '(ingen text)', amount, balance });
  }
  return { delimiter: delim === '\t' ? 'tab' : delim, headers, columns, mapping, rows, skipped, preview: split.slice(0, 5).map((r) => r.cells) };
}
