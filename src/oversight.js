import { addDays, isoWeek, monthWindows, today, weekStart } from './dates.js';
import { getSettings, holidayOptions, isFinance, round2 } from './domain.js';
import { normMinutes } from './holidays.js';

/**
 * Uppföljning av personer: vem som rapporterat och skickat in, och hur mycket av tiden som är debiterbar.
 * Ekonomi och administratörer ser alla. BM och chef ser de de är BM eller chef för. Alla ser sig själva.
 */

const PEOPLE_SQL = `
  SELECT u.id, u.name, u.weekly_hours, u.category_id, c.name AS category, u.bm_id, bm.name AS bm_name, u.manager_id,
         u.cost_center_id, cc.code || ' ' || cc.name AS kst_name
  FROM users u
  LEFT JOIN categories c ON c.id = u.category_id
  LEFT JOIN users bm ON bm.id = u.bm_id
  LEFT JOIN cost_centers cc ON cc.id = u.cost_center_id
  WHERE u.active = 1`;

export function scopePeople(db, user) {
  if (isFinance(user)) return db.prepare(`${PEOPLE_SQL} ORDER BY u.name`).all();
  return db.prepare(`${PEOPLE_SQL} AND (u.id = :me OR u.bm_id = :me OR u.manager_id = :me) ORDER BY u.name`).all({ me: user.id });
}

export function employmentsByUser(db) {
  const map = new Map();
  for (const e of db.prepare('SELECT user_id, start_date, end_date FROM employments').all()) {
    if (!map.has(e.user_id)) map.set(e.user_id, []);
    map.get(e.user_id).push(e);
  }
  return map;
}

const hours = (minutes) => round2(minutes / 60);

// ── Inrapportering ──────────────────────────────────────────────────────
/**
 * Status per person och vecka för de senaste veckorna.
 * Med i listan är de som förväntas rapportera: arbetstid över noll och antingen en BM, ett anställningsavtal
 * eller rapporterad tid det senaste halvåret. Så hamnar inte administratörskonton som aldrig rapporterar i listan.
 *
 * Status: missing (inget rapporterat trots normtid), draft (utkast kvar), rejected (avslaget att rätta),
 * submitted (inskickat, väntar på attest), approved (allt attesterat), off (ingen normtid och inget rapporterat).
 */
export function submissionStatus(db, user, { to = today(), weeks = 6 } = {}) {
  const opts = holidayOptions(getSettings(db));
  const current = weekStart(today());
  const last = weekStart(to);
  const starts = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
  const from = starts[0];
  const end = addDays(last, 6);

  const emps = employmentsByUser(db);
  const recent = new Set(db.prepare('SELECT DISTINCT user_id FROM time_entries WHERE work_date >= ?').all(addDays(from, -180)).map((r) => r.user_id));
  const people = scopePeople(db, user).filter((p) => p.weekly_hours > 0 && (p.bm_id || emps.has(p.id) || recent.has(p.id)));

  const byKey = new Map();
  for (const e of db.prepare('SELECT user_id, work_date, minutes, status, absence_type_id FROM time_entries WHERE work_date BETWEEN ? AND ?').all(from, end)) {
    const key = `${e.user_id}|${weekStart(e.work_date)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  const counts = { missing: 0, draft: 0, rejected: 0, submitted: 0 };
  const out = people.map((p) => {
    const person = { weekly_hours: p.weekly_hours, employments: emps.get(p.id) };
    const cells = starts.map((start) => {
      const list = byKey.get(`${p.id}|${start}`) ?? [];
      const norm = normMinutes(person, start, addDays(start, 6), opts);
      const reported = list.reduce((s, e) => s + e.minutes, 0);
      const n = (status) => list.filter((e) => e.status === status).length;
      let status;
      if (!list.length) status = norm > 0 ? 'missing' : 'off';
      else if (n('rejected')) status = 'rejected';
      else if (n('open')) status = 'draft';
      else if (n('submitted')) status = 'submitted';
      else status = 'approved';
      // Innevarande vecka räknas inte som försenad: den skickas in när den är slut.
      if (start < current && Object.hasOwn(counts, status)) counts[status]++;
      return { start, status, norm_hours: hours(norm), reported_hours: hours(reported), short_hours: hours(Math.max(0, norm - reported)) };
    });
    return { id: p.id, name: p.name, category: p.category, bm_id: p.bm_id, bm_name: p.bm_name, weeks: cells };
  });

  return {
    to,
    weeks: starts.map((s) => ({ start: s, end: addDays(s, 6), week: isoWeek(s), current: s === current, future: s > current })),
    people: out,
    counts,
  };
}

// ── Debiteringsgrad ─────────────────────────────────────────────────────
export const UTILIZATION_GROUPS = {
  person: 'Person',
  bm: 'BM',
  category: 'Kategori',
  kst: 'Kostnadsställe',
  month: 'Månad',
};

/**
 * Debiteringsgrad = debiterbar tid / tillgänglig tid, där tillgänglig tid = normtid − frånvaro.
 * Normtiden räknar bort helgdagar och dagar utanför anställningen.
 * consultantsOnly: bara de som har en BM, ett uppdrag i perioden eller debiterbar tid, så att administration
 * och ledning inte drar ner bolagets siffra.
 */
export function utilization(db, user, { from, to, groupBy = 'person', approvedOnly = false, consultantsOnly = true, categoryId = null, bmId = null }) {
  const opts = holidayOptions(getSettings(db));
  const money = isFinance(user);
  const emps = employmentsByUser(db);
  const windows = groupBy === 'month' ? monthWindows(from, to) : [{ start: from, end: to }];

  const sums = new Map(); // "user|fönster" → summor
  const rows = db
    .prepare(
      `SELECT te.user_id, te.work_date,
              CASE WHEN te.absence_type_id IS NOT NULL THEN te.minutes ELSE 0 END AS absence,
              CASE WHEN te.activity_id IS NOT NULL THEN te.minutes ELSE 0 END AS worked,
              CASE WHEN te.activity_id IS NOT NULL AND te.billable = 1 THEN te.minutes ELSE 0 END AS billable,
              CASE WHEN te.billable = 1 THEN te.minutes * te.bill_rate / 60.0 ELSE 0 END AS revenue
       FROM time_entries te
       WHERE te.work_date BETWEEN :from AND :to AND te.status <> 'rejected' AND (:approved = 0 OR te.status = 'approved')`,
    )
    .all({ from, to, approved: approvedOnly ? 1 : 0 });
  for (const r of rows) {
    const w = windows.findIndex((x) => r.work_date >= x.start && r.work_date <= x.end);
    const key = `${r.user_id}|${w}`;
    const s = sums.get(key) ?? { absence: 0, worked: 0, billable: 0, revenue: 0 };
    s.absence += r.absence;
    s.worked += r.worked;
    s.billable += r.billable;
    s.revenue += r.revenue;
    sums.set(key, s);
  }

  const inAssignment = new Set(
    db.prepare('SELECT DISTINCT user_id FROM assignments WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)').all(to, from).map((r) => r.user_id),
  );
  const billedSomething = new Set([...sums.entries()].filter(([, s]) => s.billable > 0).map(([k]) => Number(k.split('|')[0])));
  let people = scopePeople(db, user);
  if (categoryId) people = people.filter((p) => p.category_id === categoryId);
  if (bmId) people = people.filter((p) => p.bm_id === bmId);
  if (consultantsOnly) people = people.filter((p) => p.bm_id || inAssignment.has(p.id) || billedSomething.has(p.id));

  // En rad per person och fönster, i minuter.
  const base = [];
  for (const p of people) {
    const person = { weekly_hours: p.weekly_hours, employments: emps.get(p.id) };
    windows.forEach((w, i) => {
      const s = sums.get(`${p.id}|${i}`) ?? { absence: 0, worked: 0, billable: 0, revenue: 0 };
      base.push({ person: p, window: w, norm: normMinutes(person, w.start, w.end, opts), ...s });
    });
  }

  const keyOf = {
    person: (b) => [b.person.id, b.person.name, { category: b.person.category, bm_name: b.person.bm_name }],
    bm: (b) => [b.person.bm_id ?? 0, b.person.bm_name ?? '(ingen BM)', {}],
    category: (b) => [b.person.category_id ?? 0, b.person.category ?? '(ingen kategori)', {}],
    kst: (b) => [b.person.cost_center_id ?? 0, b.person.kst_name ?? '(inget kostnadsställe)', {}],
    month: (b) => [b.window.start.slice(0, 7), b.window.start.slice(0, 7), {}],
  }[groupBy];

  const groups = new Map();
  for (const b of base) {
    const [key, label, extra] = keyOf(b);
    const g = groups.get(key) ?? { key, label, ...extra, people: new Set(), norm: 0, absence: 0, worked: 0, billable: 0, revenue: 0 };
    g.people.add(b.person.id);
    for (const k of ['norm', 'absence', 'worked', 'billable', 'revenue']) g[k] += b[k];
    groups.set(key, g);
  }

  const present = (g) => {
    const available = Math.max(0, g.norm - g.absence);
    return {
      key: g.key,
      label: g.label,
      ...(g.category !== undefined ? { category: g.category, bm_name: g.bm_name } : {}),
      people: g.people.size,
      norm_hours: hours(g.norm),
      absence_hours: hours(g.absence),
      available_hours: hours(available),
      worked_hours: hours(g.worked),
      billable_hours: hours(g.billable),
      internal_hours: hours(g.worked - g.billable),
      utilization: available ? round2((g.billable / available) * 100) : null,
      of_norm: g.norm ? round2((g.billable / g.norm) * 100) : null,
      ...(money ? { revenue: round2(g.revenue), avg_rate: g.billable ? round2(g.revenue / (g.billable / 60)) : null } : {}),
    };
  };

  const list = [...groups.values()].map(present);
  if (groupBy === 'month') list.sort((a, b) => a.label.localeCompare(b.label));
  else list.sort((a, b) => a.label.localeCompare(b.label, 'sv'));
  const all = { key: 'total', label: 'Totalt', people: new Set(people.map((p) => p.id)), norm: 0, absence: 0, worked: 0, billable: 0, revenue: 0 };
  for (const b of base) for (const k of ['norm', 'absence', 'worked', 'billable', 'revenue']) all[k] += b[k];

  return { from, to, group_by: groupBy, group_title: UTILIZATION_GROUPS[groupBy], approved_only: approvedOnly, consultants_only: consultantsOnly, rows: list, total: present(all) };
}
