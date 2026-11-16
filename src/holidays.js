import { addDays, isWeekend } from './dates.js';

/**
 * Svenska helgdagar och normtid.
 *
 * Helgdagarna är de allmänna helgdagarna enligt lag. Midsommar-, jul- och nyårsafton är inte helgdagar i lagens mening
 * men lediga enligt de flesta avtal; de räknas som lediga när `eves` är sant (inställning, standard på).
 * Påskafton ligger alltid på en lördag och påverkar därför aldrig normtiden.
 */

const pad = (n) => String(n).padStart(2, '0');

// Påskdagen enligt den gregorianska algoritmen (Meeus/Jones/Butcher).
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Första dagen med veckodagen `dow` (0 = söndag … 6 = lördag) från och med datumet.
function firstWeekday(date, dow) {
  for (let i = 0; i < 7; i++) {
    const d = addDays(date, i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === dow) return d;
  }
  return date;
}

const yearCache = new Map();

/** Årets helgdagar som [{ date, name, eve }], i datumordning. `eve` markerar aftnarna. */
export function holidaysOfYear(year) {
  if (yearCache.has(year)) return yearCache.get(year);
  const easter = easterSunday(year);
  const list = [
    { date: `${year}-01-01`, name: 'Nyårsdagen' },
    { date: `${year}-01-06`, name: 'Trettondedag jul' },
    { date: addDays(easter, -2), name: 'Långfredagen' },
    { date: addDays(easter, -1), name: 'Påskafton', eve: true },
    { date: easter, name: 'Påskdagen' },
    { date: addDays(easter, 1), name: 'Annandag påsk' },
    { date: `${year}-05-01`, name: 'Första maj' },
    { date: addDays(easter, 39), name: 'Kristi himmelsfärdsdag' },
    { date: addDays(easter, 49), name: 'Pingstdagen' },
    { date: `${year}-06-06`, name: 'Sveriges nationaldag' },
    { date: firstWeekday(`${year}-06-19`, 5), name: 'Midsommarafton', eve: true },
    { date: firstWeekday(`${year}-06-20`, 6), name: 'Midsommardagen' },
    { date: firstWeekday(`${year}-10-31`, 6), name: 'Alla helgons dag' },
    { date: `${year}-12-24`, name: 'Julafton', eve: true },
    { date: `${year}-12-25`, name: 'Juldagen' },
    { date: `${year}-12-26`, name: 'Annandag jul' },
    { date: `${year}-12-31`, name: 'Nyårsafton', eve: true },
  ]
    .map((x) => ({ ...x, eve: !!x.eve }))
    .sort((a, b) => a.date.localeCompare(b.date));
  yearCache.set(year, list);
  return list;
}

/** Namnet på helgdagen, eller null. Aftnarna räknas bara när `eves` är sant. */
export function holidayName(date, { eves = true } = {}) {
  const hit = holidaysOfYear(Number(date.slice(0, 4))).find((x) => x.date === date);
  return hit && (eves || !hit.eve) ? hit.name : null;
}

/** Helgdagar i [from, to], även de som infaller på en helg (för visning). */
export function holidaysBetween(from, to, { eves = true } = {}) {
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const x of holidaysOfYear(y)) if (x.date >= from && x.date <= to && (eves || !x.eve)) out.push(x);
  }
  return out;
}

/** Arbetsdag: måndag–fredag som inte är helgdag. */
export const isWorkday = (date, opts) => !isWeekend(date) && !holidayName(date, opts);

export function workdaysBetween(from, to, opts) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(d, opts)) n++;
  return n;
}

const FAR = '9999-12-31';

/** Anställd den dagen? Utan anställningsavtal räknas personen som anställd tills vidare, som i prognosen. */
export const employedOn = (employments, day) =>
  !employments?.length || employments.some((e) => e.start_date <= day && day <= (e.end_date ?? FAR));

/**
 * Normtid i minuter per dag: arbetstiden per vecka delad på fem, på arbetsdagar under anställning.
 * person: { weekly_hours, employments?: [{ start_date, end_date }] }
 */
export function normByDay(person, from, to, opts) {
  const daily = Math.round(((person.weekly_hours ?? 0) * 60) / 5);
  const out = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.set(d, isWorkday(d, opts) && employedOn(person.employments, d) ? daily : 0);
  }
  return out;
}

export function normMinutes(person, from, to, opts) {
  let sum = 0;
  for (const m of normByDay(person, from, to, opts).values()) sum += m;
  return sum;
}
