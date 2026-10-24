import { config } from './config.js';

// Dagens datum i konfigurerad tidszon som ÅÅÅÅ-MM-DD.
export function today() {
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
