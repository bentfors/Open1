import { f, parse, optId, optDate } from './validate.js';
import { today } from './dates.js';

// Ändringsloggen. Skrivs i samma transaktion som ändringen den beskriver, så en ändring utan loggrad kan inte uppstå.
// Raderna kan inte ändras eller tas bort (triggers i databasen). Namn sparas som de hette när ändringen gjordes.

export const ENTITY_LABELS = {
  user: 'Användare',
  customer: 'Kund',
  project: 'Projekt',
  project_member: 'Projektmedlem',
  activity: 'Aktivitet',
  category: 'Kategori',
  absence_type: 'Frånvarotyp',
  commission_rule: 'Provisionsregel',
  employment: 'Anställning',
  assignment: 'Uppdrag',
  setting: 'Inställning',
  invoice: 'Fakturaunderlag',
  billing: 'Fakturering',
  approval: 'Attest',
  time: 'Tid',
  expense: 'Utlägg',
  mileage: 'Körning',
};

export const ACTION_LABELS = {
  create: 'Skapad',
  update: 'Ändrad',
  delete: 'Borttagen',
  password: 'Lösenord satt',
  approve: 'Godkänd',
  reject: 'Avslagen',
  reopen: 'Öppnad igen',
  waive: 'Avskriven',
  restore: 'Avskrivning ångrad',
  undo: 'Ångrad',
};

const FIELD_LABELS = {
  name: 'Namn',
  email: 'E-post',
  role: 'Roll',
  finance: 'Ekonomibehörighet',
  category_id: 'Kategori',
  manager_id: 'Chef',
  bm_id: 'BM',
  cost_rate: 'Timkostnad',
  default_bill_rate: 'Standardpris',
  weekly_hours: 'Arbetstid per vecka',
  active: 'Aktiv',
  org_no: 'Organisationsnummer',
  contact_name: 'Kontaktperson',
  phone: 'Telefon',
  address: 'Adress',
  invoice_ref: 'Fakturareferens',
  notes: 'Anteckningar',
  customer_id: 'Kund',
  code: 'Projektnummer',
  status: 'Status',
  billing_type: 'Debitering',
  hourly_rate: 'Timpris',
  budget_hours: 'Budget (timmar)',
  budget_amount: 'Budget (belopp)',
  start_date: 'Startdatum',
  end_date: 'Slutdatum',
  open_for_all: 'Öppet för alla',
  billable: 'Debiterbar',
  sort: 'Sortering',
  earner_id: 'Mottagare',
  kind: 'Regeltyp',
  period: 'Period',
  percent: 'Procent',
  amount: 'Belopp',
  min_hours: 'Minsta antal timmar',
  valid_from: 'Gäller från',
  valid_to: 'Gäller till',
  user_id: 'Person',
  type: 'Typ',
  notice_months: 'Uppsägningstid (månader)',
  project_id: 'Projekt',
  title: 'Benämning',
  hours_per_week: 'Timmar per vecka',
  company_name: 'Företagsnamn',
  locked_until: 'Perioden låst till och med',
  mileage_rate: 'Milersättning (kr/km)',
  tb_cost_basis: 'Kostnad i TB',
  bench_cap_hours: 'Gräns för odebiterbar tid (tim)',
  forecast_utilization: 'Beläggning i prognoser (%)',
  minutes: 'Minuter',
  note: 'Anteckning',
  date: 'Datum',
  description: 'Beskrivning',
  km: 'Kilometer',
  vat: 'Moms',
  purpose: 'Syfte',
  from_place: 'Från',
  to_place: 'Till',
};

// Samma kolumnnamn heter olika i olika sammanhang, t.ex. manager_id: "Chef" på en användare men "Projektledare" på ett projekt.
const FIELD_LABELS_BY_ENTITY = {
  project: { manager_id: 'Projektledare' },
  commission_rule: { amount: 'Belopp per konsult' },
  employment: { user_id: 'Anställd' },
  assignment: { user_id: 'Konsult' },
  expense: { billable: 'Vidarefakturera' },
  mileage: { billable: 'Vidarefakturera' },
};

const VALUE_LABELS = {
  admin: 'Administratör',
  user: 'Användare',
  active: 'Aktivt',
  closed: 'Avslutat',
  hourly: 'Löpande',
  fixed: 'Fast pris',
  internal: 'Internt',
  tb_percent: 'Procent av TB',
  per_consultant: 'Belopp per konsult',
  tb_tiered: 'Procent av TB, trappa',
  month: 'Månad',
  quarter: 'Kvartal',
  permanent: 'Tillsvidare',
  fixed_term: 'Visstid',
  probation: 'Provanställning',
  worked: 'All projekttid',
  billable: 'Bara debiterbar tid',
};

const USER_FIELDS = new Set(['bm_id', 'manager_id', 'earner_id', 'user_id']);
const BOOL_FIELDS = new Set(['active', 'billable', 'open_for_all']);
const FINANCE_LEVELS = ['Ingen', 'Ekonomi', 'Ekonomi-superuser'];

const norm = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

function show(db, key, value) {
  if (value === null || value === undefined || value === '') return '–';
  if (BOOL_FIELDS.has(key)) return value ? 'Ja' : 'Nej';
  const lookup = (sql) => db.prepare(sql).get(value)?.v ?? `#${value}`;
  if (USER_FIELDS.has(key)) return lookup('SELECT name AS v FROM users WHERE id = ?');
  if (key === 'category_id') return lookup('SELECT name AS v FROM categories WHERE id = ?');
  if (key === 'customer_id') return lookup('SELECT name AS v FROM customers WHERE id = ?');
  if (key === 'project_id') return lookup("SELECT code || ' ' || name AS v FROM projects WHERE id = ?");
  if (key === 'finance') return FINANCE_LEVELS[value] ?? String(value);
  if (typeof value === 'string' && Object.hasOwn(VALUE_LABELS, value)) return VALUE_LABELS[value];
  const s = String(value);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Det som skiljer `before` från `data`, bara för nycklarna i `data`. Id:n blir namn och koder blir text.
 * Lösenord ingår aldrig: de ligger inte i `data` hos någon rutt som loggar.
 */
export function changesFor(db, before, data, entity) {
  const labels = { ...FIELD_LABELS, ...FIELD_LABELS_BY_ENTITY[entity] };
  const out = [];
  for (const key of Object.keys(data)) {
    if (norm(before?.[key]) === norm(data[key])) continue;
    out.push({ field: labels[key] ?? key, from: show(db, key, before?.[key]), to: show(db, key, data[key]) });
  }
  return out;
}

/** En ändring med fritt formulerade värden, för sådant som inte är en kolumn (t.ex. en regels konsultlista). */
export const changeOf = (field, from, to) => ({ field, from: from || '–', to: to || '–' });

/**
 * Lägger en rad i loggen. Anropa inuti samma transaktion som ändringen, och före en radering,
 * så att namnen på det som berörs fortfarande går att slå upp.
 */
export function audit(db, actor, e) {
  const { entity, action, entityId = null, label = '', changes = null, note = '' } = e;
  if (!Object.hasOwn(ENTITY_LABELS, entity) || !Object.hasOwn(ACTION_LABELS, action)) throw new Error(`Okänd loggpost ${entity}/${action}`);
  // En sparning som inte ändrade något är ingen ändring.
  if (action === 'update' && !changes?.length && !note) return;

  const one = (sql, id) => (id == null ? null : (db.prepare(sql).get(id)?.v ?? null));
  const userId = e.userId ?? null;
  const projectId = e.projectId ?? null;
  const customerId = e.customerId ?? one('SELECT customer_id AS v FROM projects WHERE id = ?', projectId);

  db.prepare(
    `INSERT INTO audit_log (at, day, actor_id, actor_name, entity, action, entity_id, label,
                            user_id, user_label, customer_id, customer_label, project_id, project_label, changes, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    today(),
    actor?.id ?? null,
    actor?.name ?? 'System',
    entity,
    action,
    entityId,
    label,
    userId,
    e.userLabel ?? one('SELECT name AS v FROM users WHERE id = ?', userId),
    customerId,
    e.customerLabel ?? one('SELECT name AS v FROM customers WHERE id = ?', customerId),
    projectId,
    e.projectLabel ?? one("SELECT code || ' ' || name AS v FROM projects WHERE id = ?", projectId),
    changes?.length ? JSON.stringify(changes) : null,
    note,
  );
}

// ── Läsa loggen ─────────────────────────────────────────────────────────
const caseOf = (col, labels) => `(CASE ${col} ${Object.entries(labels).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} ELSE ${col} END)`;

// Sorteringen följer det som visas (på svenska), inte de interna nycklarna. Rader utan värde hamnar sist.
const SORTS = {
  at: 'a.id',
  actor: 'a.actor_name COLLATE NOCASE',
  action: `${caseOf('a.action', ACTION_LABELS)} COLLATE NOCASE`,
  entity: `${caseOf('a.entity', ENTITY_LABELS)} COLLATE NOCASE`,
  label: 'a.label COLLATE NOCASE',
  customer: 'a.customer_label COLLATE NOCASE',
  project: 'a.project_label COLLATE NOCASE',
  user: 'a.user_label COLLATE NOCASE',
};

const QUERY_SCHEMA = {
  limit: f.int({ min: 1, max: 100000, label: 'Antal' }),
  offset: f.int({ min: 0, max: 10_000_000, label: 'Start' }),
};

const like = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function rowOf(r) {
  return { ...r, changes: r.changes ? JSON.parse(r.changes) : [] };
}

/** Sökning, filter och sortering görs i databasen, så att loggen kan vara lång. */
export function queryAudit(db, query, { maxLimit = 200 } = {}) {
  const sort = Object.hasOwn(SORTS, query.sort) ? query.sort : 'at';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const paging = parse(
    Object.fromEntries(['limit', 'offset'].filter((k) => query[k] !== undefined && query[k] !== '').map((k) => [k, Number(query[k])])),
    QUERY_SCHEMA,
  );
  const limit = Math.min(paging.limit ?? 50, maxLimit);
  const offset = paging.offset ?? 0;

  const where = [];
  const params = {};
  const eq = (col, key, value) => {
    if (value === undefined || value === null || value === '') return;
    where.push(`${col} = :${key}`);
    params[key] = value;
  };
  eq('a.actor_id', 'actor', optId(query.actor_id, 'Utförd av'));
  eq('a.user_id', 'user', optId(query.user_id, 'Användare'));
  eq('a.customer_id', 'customer', optId(query.customer_id, 'Kund'));
  eq('a.project_id', 'project', optId(query.project_id, 'Projekt'));
  if (query.entity && Object.hasOwn(ENTITY_LABELS, query.entity)) eq('a.entity', 'entity', query.entity);
  if (query.action && Object.hasOwn(ACTION_LABELS, query.action)) eq('a.action', 'action', query.action);
  const from = optDate(query.from, 'Från');
  const to = optDate(query.to, 'Till');
  if (from) {
    where.push('a.day >= :from');
    params.from = from;
  }
  if (to) {
    where.push('a.day <= :to');
    params.to = to;
  }
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  if (q) {
    where.push(
      `(a.label LIKE :q ESCAPE '\\' OR a.actor_name LIKE :q ESCAPE '\\' OR a.note LIKE :q ESCAPE '\\' OR a.user_label LIKE :q ESCAPE '\\'
        OR a.customer_label LIKE :q ESCAPE '\\' OR a.project_label LIKE :q ESCAPE '\\' OR a.changes LIKE :q ESCAPE '\\')`,
    );
    params.q = like(q);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = `${SORTS[sort]} IS NULL, ${SORTS[sort]} ${dir}, a.id DESC`;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${clause}`).get(params).n;
  const rows = db
    .prepare(`SELECT a.* FROM audit_log a ${clause} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset })
    .map(rowOf);
  return { total, limit, offset, sort, dir: dir.toLowerCase(), rows };
}

/** Alternativen till filterlistorna: det som finns i loggen, med senaste namnet. */
export function auditFacets(db) {
  const named = (idCol, labelCol) =>
    db
      .prepare(
        `SELECT a.${idCol} AS id, (SELECT b.${labelCol} FROM audit_log b WHERE b.${idCol} = a.${idCol} ORDER BY b.id DESC LIMIT 1) AS name
         FROM audit_log a WHERE a.${idCol} IS NOT NULL GROUP BY a.${idCol} ORDER BY name COLLATE NOCASE`,
      )
      .all();
  const keys = (col) => db.prepare(`SELECT DISTINCT ${col} AS k FROM audit_log`).all().map((r) => r.k);
  return {
    actors: named('actor_id', 'actor_name'),
    users: named('user_id', 'user_label'),
    customers: named('customer_id', 'customer_label'),
    projects: named('project_id', 'project_label'),
    entities: keys('entity').map((k) => ({ value: k, label: ENTITY_LABELS[k] ?? k })).sort((x, y) => x.label.localeCompare(y.label, 'sv')),
    actions: keys('action').map((k) => ({ value: k, label: ACTION_LABELS[k] ?? k })).sort((x, y) => x.label.localeCompare(y.label, 'sv')),
  };
}
