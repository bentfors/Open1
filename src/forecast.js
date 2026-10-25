import { addDays, addMonths, isWeekend, monthEnd, quarterEnd, quarterStart, today } from './dates.js';
import { actualProvider, computeCommissions, listRules } from './commission.js';
import { getSettings } from './domain.js';

/**
 * Prognos för provision, byggd på avtalsregistret. Varje konsult simuleras dag för dag:
 *  - Arbetsdagar är måndag–fredag. Röda dagar räknas inte, beläggningen (inställning) tar höjd för semester, sjukdom och helgdagar.
 *  - En dag med uppdrag ger intäkt = timmar × pris. Kostnaden följer inställningen för TB (all arbetad tid, eller bara debiterbar).
 *  - En dag utan uppdrag men under anställning är bänk: odebiterbar tid som räknas som negativ enligt bänkgränsen,
 *    med räknaren som den står enligt attesterad tid vid periodens början.
 *  - Utan anställningsavtal antas personen vara anställd tillsvidare.
 * Provisionen räknas sedan av samma motor som utfallet, så trappa, golv och bänkgräns beter sig likadant.
 */

const FAR = '9999-12-31';

function loadPeople(db, extraIds) {
  const ids = [...new Set(extraIds)];
  const marks = ids.map(() => '?').join(',');
  const users = db
    .prepare(
      `SELECT id, name, weekly_hours, cost_rate, category_id FROM users
       WHERE active = 1 AND (id IN (SELECT user_id FROM assignments)${ids.length ? ` OR id IN (${marks})` : ''})`,
    )
    .all(...ids);
  const employments = db.prepare('SELECT user_id, start_date, end_date FROM employments').all();
  const assignments = db
    .prepare('SELECT id, user_id, customer_id, start_date, end_date, hourly_rate, hours_per_week FROM assignments')
    .all();
  return users.map((u) => ({
    ...u,
    employments: employments.filter((e) => e.user_id === u.id),
    assignments: assignments.filter((a) => a.user_id === u.id),
  }));
}

const employed = (person, day) =>
  !person.employments.length || person.employments.some((e) => e.start_date <= day && day <= (e.end_date ?? FAR));

function simulatePerson(person, { from, to, utilization, worked, capMinutes, carryMinutes, excluded }) {
  const days = new Map();
  let counter = carryMinutes;
  const daily = (person.weekly_hours / 5) * utilization;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWeekend(d) || !employed(person, d)) continue;
    const active = person.assignments.filter((a) => !excluded.has(a.id) && a.start_date <= d && d <= (a.end_date ?? FAR));
    if (active.length) {
      const assigned = active.reduce((s, a) => s + a.hours_per_week / 5, 0) * utilization;
      const revenue = active.reduce((s, a) => s + (a.hours_per_week / 5) * a.hourly_rate, 0) * utilization;
      const cost = (worked ? daily : assigned) * person.cost_rate;
      counter = 0; // i uppdrag: bänkräknaren börjar om
      days.set(d, { billH: assigned, projH: daily, tb: revenue - cost, actual: revenue - cost, cappedH: 0 });
    } else {
      const minutes = daily * 60;
      const cost = worked ? daily * person.cost_rate : 0;
      const counted = capMinutes === null ? minutes : Math.max(0, Math.min(minutes, capMinutes - counter));
      counter += minutes;
      days.set(d, { billH: 0, projH: daily, tb: minutes ? -cost * (counted / minutes) : 0, actual: -cost, cappedH: (minutes - counted) / 60 });
    }
  }
  return days;
}

function sumWindow(days, start, end) {
  const out = { tb: 0, actual: 0, minutes: 0, billMin: 0, cappedMin: 0 };
  if (!days) return out;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const x = days.get(d);
    if (!x) continue;
    out.tb += x.tb;
    out.actual += x.actual;
    out.minutes += x.projH * 60;
    out.billMin += x.billH * 60;
    out.cappedMin += x.cappedH * 60;
  }
  return out;
}

/**
 * Räknar fram provisionsrader för perioder från idag och `months` månader framåt.
 * virtual: tänkta konsulter { name, rate, cost, hours_per_week, start, end } som läggs till som källor i mottagarens TB-regler.
 * excludeAssignmentIds: uppdrag som tas bort ur beräkningen, för att se vad ett uppdrag är värt.
 */
export function forecast(db, { earnerId, months = 12, virtual = [], excludeAssignmentIds = [], includeIds = [] }) {
  const t = today();
  const settings = getSettings(db);
  const utilization = settings.forecast_utilization / 100;
  const worked = settings.tb_cost_basis === 'billable' ? 0 : 1;
  const capMinutes = settings.bench_cap_hours === null ? null : settings.bench_cap_hours * 60;
  const simFrom = quarterStart(t);
  const horizonEnd = monthEnd(addMonths(t, months - 1));
  const simTo = quarterEnd(horizonEnd);

  const rules = listRules(db, { earnerId });
  const sourceIds = rules.filter((r) => r.kind !== 'per_consultant').flatMap((r) => r.sources.map((s) => s.id));
  const people = loadPeople(db, [...sourceIds, ...includeIds]);
  const actual = actualProvider(db);
  const excluded = new Set(excludeAssignmentIds);

  const virtualPeople = virtual.map((v, i) => ({
    id: -(i + 1),
    name: v.name ?? `Ny konsult ${i + 1}`,
    weekly_hours: v.hours_per_week,
    cost_rate: v.cost,
    category_id: null,
    virtual: true,
    // Tänkta konsulter räknas bara under själva uppdraget, så att varken tiden före eller efter ger bänkkostnad.
    employments: [{ start_date: v.start, end_date: v.end ?? null }],
    assignments: [{ id: -(i + 1), start_date: v.start, end_date: v.end ?? null, hourly_rate: v.rate, hours_per_week: v.hours_per_week }],
  }));

  const sim = new Map();
  for (const person of [...people, ...virtualPeople]) {
    sim.set(
      person.id,
      simulatePerson(person, {
        from: simFrom,
        to: simTo,
        utilization,
        worked,
        capMinutes,
        carryMinutes: person.virtual ? 0 : actual.carry(person.id, simFrom),
        excluded,
      }),
    );
  }

  const categoryOf = new Map(people.map((p) => [p.id, p.category_id]));
  const provider = {
    sources: (rule) => (rule.kind === 'per_consultant' ? [] : [...rule.sources, ...virtualPeople.map((p) => ({ id: p.id, name: p.name }))]),
    sourceBasis: (id, start, end) => sumWindow(sim.get(id), start, end),
    consultantCount(rule, start, end) {
      const allowed = new Set(rule.categories.map((c) => c.id));
      let n = 0;
      for (const [id, days] of sim) {
        const cat = categoryOf.get(id);
        if (allowed.size && id > 0 && !allowed.has(cat)) continue; // tänkta konsulter räknas alltid med
        if (sumWindow(days, start, end).billMin > rule.min_hours * 60) n++;
      }
      return n;
    },
  };

  const rows = computeCommissions(db, { from: t, to: horizonEnd, earnerId, provider });
  return { rows, sim, people, horizonEnd };
}

// Provision per månad där perioden slutar, alltså när den tjänats in.
export function byPayoutMonth(rows, from, to) {
  const out = new Map();
  for (let m = from; m <= to; m = addMonths(m, 1)) out.set(m.slice(0, 7), 0);
  for (const r of rows) {
    const key = r.period_end.slice(0, 7);
    if (out.has(key)) out.set(key, Math.round((out.get(key) + r.commission) * 100) / 100);
  }
  return out;
}

export { sumWindow };
