import { config } from './config.js';

// Tester kan fixera dagens datum. Aldrig i drift.
let todayOverride = null;
export function setTodayForTests(date) {
  todayOverride = date;
}

// Dagens datum i konfigurerad tidszon som ÅÅÅÅ-MM-DD.
export function today() {
  if (todayOverride) return todayOverride;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toUtc(s) {
  return new Date(`${s}T00:00:00Z`);
}

export function addDays(dateStr, n) {
  const d = toUtc(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Måndagen i veckan som datumet ligger i.
export function weekStart(dateStr) {
  const d = toUtc(dateStr);
  const dow = (d.getUTCDay() + 6) % 7; // mån=0 … sön=6
  return addDays(dateStr, -dow);
}

export function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isWeekend(dateStr) {
  const dow = toUtc(dateStr).getUTCDay();
  return dow === 0 || dow === 6;
}

const pad = (n) => String(n).padStart(2, '0');

export const monthStart = (d) => `${d.slice(0, 8)}01`;

export function monthEnd(d) {
  const dt = toUtc(monthStart(d));
  dt.setUTCMonth(dt.getUTCMonth() + 1, 0);
  return dt.toISOString().slice(0, 10);
}

export function quarterStart(d) {
  const month = Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1;
  return `${d.slice(0, 4)}-${pad(month)}-01`;
}

export function quarterEnd(d) {
  const dt = toUtc(quarterStart(d));
  dt.setUTCMonth(dt.getUTCMonth() + 3, 0);
  return dt.toISOString().slice(0, 10);
}

export const previousMonthEnd = (d) => addDays(monthStart(d), -1);

// Alla hela månader eller kvartal som överlappar [from, to].
export function periods(from, to, type) {
  const startOf = type === 'quarter' ? quarterStart : monthStart;
  const endOf = type === 'quarter' ? quarterEnd : monthEnd;
  const out = [];
  for (let start = startOf(from); start <= to && out.length < 400; start = addDays(endOf(start), 1)) {
    const end = endOf(start);
    const label =
      type === 'quarter' ? `Q${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1} ${start.slice(0, 4)}` : start.slice(0, 7);
    out.push({ start, end, label });
  }
  return out;
}

// Kalendermånader som överlappar [start, end], avklippta mot intervallet.
export function monthWindows(start, end) {
  const out = [];
  for (let s = monthStart(start); s <= end && out.length < 400; s = addDays(monthEnd(s), 1)) {
    const e = monthEnd(s);
    out.push({ start: s < start ? start : s, end: e > end ? end : e });
  }
  return out;
}

// Första dagen i månaden n månader efter månaden som datumet ligger i (n kan vara negativt).
export function addMonths(dateStr, n) {
  const dt = toUtc(monthStart(dateStr));
  dt.setUTCMonth(dt.getUTCMonth() + n, 1);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}
