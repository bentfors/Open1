import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Varje migration körs en gång, i ordning. PRAGMA user_version håller reda på nivån.
export const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE categories (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                 TEXT NOT NULL,
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    role                 TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    category_id          INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    manager_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cost_rate            REAL NOT NULL DEFAULT 0 CHECK (cost_rate >= 0),
    default_bill_rate    REAL NOT NULL DEFAULT 0 CHECK (default_bill_rate >= 0),
    weekly_hours         REAL NOT NULL DEFAULT 40 CHECK (weekly_hours >= 0 AND weekly_hours <= 80),
    active               INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- earner får procent av source:s TB.
  CREATE TABLE commission_links (
    id         INTEGER PRIMARY KEY,
    earner_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    percent    REAL NOT NULL CHECK (percent >= 0 AND percent <= 100),
    valid_from TEXT,
    valid_to   TEXT,
    CHECK (earner_id <> source_id)
  );
  CREATE INDEX commission_source ON commission_links(source_id);
  CREATE INDEX commission_earner ON commission_links(earner_id);

  CREATE TABLE customers (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    org_no       TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    phone        TEXT NOT NULL DEFAULT '',
    address      TEXT NOT NULL DEFAULT '',
    invoice_ref  TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE projects (
    id            INTEGER PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers(id),
    code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    billing_type  TEXT NOT NULL DEFAULT 'hourly' CHECK (billing_type IN ('hourly','fixed','internal')),
    hourly_rate   REAL NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
    budget_hours  REAL CHECK (budget_hours IS NULL OR budget_hours >= 0),
    budget_amount REAL CHECK (budget_amount IS NULL OR budget_amount >= 0),
    start_date    TEXT,
    end_date      TEXT,
    open_for_all  INTEGER NOT NULL DEFAULT 0,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX projects_customer ON projects(customer_id);

  CREATE TABLE activities (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE,
    billable    INTEGER NOT NULL DEFAULT 1,
    hourly_rate REAL CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
    active      INTEGER NOT NULL DEFAULT 1,
    UNIQUE (project_id, name)
  );

  CREATE TABLE project_members (
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hourly_rate REAL CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE absence_types (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE invoices (
    id           INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    period_from  TEXT NOT NULL,
    period_to    TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    total_amount REAL NOT NULL,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE time_entries (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    work_date      TEXT NOT NULL,
    activity_id    INTEGER REFERENCES activities(id),
    absence_type_id INTEGER REFERENCES absence_types(id),
    minutes        INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
    note           TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','approved','rejected')),
    reject_note    TEXT,
    approved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at    TEXT,
    billable       INTEGER NOT NULL DEFAULT 0,
    bill_rate      REAL NOT NULL DEFAULT 0,
    cost_rate      REAL NOT NULL DEFAULT 0,
    invoice_id     INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((activity_id IS NULL) <> (absence_type_id IS NULL))
  );
  CREATE UNIQUE INDEX time_unique_activity ON time_entries(user_id, work_date, activity_id) WHERE activity_id IS NOT NULL;
  CREATE UNIQUE INDEX time_unique_absence  ON time_entries(user_id, work_date, absence_type_id) WHERE absence_type_id IS NOT NULL;
  CREATE INDEX time_date ON time_entries(work_date);
  CREATE INDEX time_status ON time_entries(status);
  CREATE INDEX time_invoice ON time_entries(invoice_id);

  CREATE TABLE expenses (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    expense_date TEXT NOT NULL,
    project_id   INTEGER REFERENCES projects(id),
    description  TEXT NOT NULL,
    amount       REAL NOT NULL CHECK (amount > 0),
    vat          REAL NOT NULL DEFAULT 0 CHECK (vat >= 0),
    billable     INTEGER NOT NULL DEFAULT 0,
    receipt_file TEXT,
    receipt_name TEXT,
    receipt_type TEXT,
    status       TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
    reject_note  TEXT,
    approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at  TEXT,
    invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX expenses_user_date ON expenses(user_id, expense_date);

  CREATE TABLE mileage (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    trip_date   TEXT NOT NULL,
    project_id  INTEGER REFERENCES projects(id),
    from_place  TEXT NOT NULL DEFAULT '',
    to_place    TEXT NOT NULL DEFAULT '',
    purpose     TEXT NOT NULL,
    km          REAL NOT NULL CHECK (km > 0),
    rate_per_km REAL NOT NULL CHECK (rate_per_km >= 0),
    billable    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
    reject_note TEXT,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at TEXT,
    invoice_id  INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX mileage_user_date ON mileage(user_id, trip_date);
  `,

  // 2: fakturering med radval och avskrivning, samt provisionsregler.
  (db) => {
    db.exec(`
      ALTER TABLE invoices ADD COLUMN invoice_date TEXT;
      UPDATE invoices SET invoice_date = substr(created_at, 1, 10);

      ALTER TABLE time_entries ADD COLUMN waived_at TEXT;
      ALTER TABLE time_entries ADD COLUMN waived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE time_entries ADD COLUMN waived_note TEXT;
      ALTER TABLE expenses ADD COLUMN waived_at TEXT;
      ALTER TABLE expenses ADD COLUMN waived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE expenses ADD COLUMN waived_note TEXT;
      ALTER TABLE mileage ADD COLUMN waived_at TEXT;
      ALTER TABLE mileage ADD COLUMN waived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE mileage ADD COLUMN waived_note TEXT;

      CREATE TABLE commission_rules (
        id         INTEGER PRIMARY KEY,
        earner_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL DEFAULT '',
        kind       TEXT NOT NULL CHECK (kind IN ('tb_percent','per_consultant','tb_tiered')),
        period     TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('month','quarter')),
        percent    REAL CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
        amount     REAL CHECK (amount IS NULL OR amount >= 0),
        tiers      TEXT,
        min_hours  REAL NOT NULL DEFAULT 0 CHECK (min_hours >= 0),
        floor_zero INTEGER NOT NULL DEFAULT 1,
        valid_from TEXT,
        valid_to   TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX commission_rules_earner ON commission_rules(earner_id);

      CREATE TABLE commission_rule_sources (
        rule_id INTEGER NOT NULL REFERENCES commission_rules(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (rule_id, user_id)
      );
      CREATE INDEX commission_sources_user ON commission_rule_sources(user_id);

      CREATE TABLE commission_rule_categories (
        rule_id     INTEGER NOT NULL REFERENCES commission_rules(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        PRIMARY KEY (rule_id, category_id)
      );
    `);

    // Gamla kopplingar blir månadsregler med samma procent och period, utan golvning,
    // så att redan presenterade siffror inte ändras.
    const links = db.prepare('SELECT * FROM commission_links').all();
    const insertRule = db.prepare(
      `INSERT INTO commission_rules (earner_id, name, kind, period, percent, floor_zero, valid_from, valid_to)
       VALUES (?, ?, 'tb_percent', 'month', ?, 0, ?, ?)`,
    );
    const insertSource = db.prepare('INSERT INTO commission_rule_sources (rule_id, user_id) VALUES (?, ?)');
    const nameOf = db.prepare('SELECT name FROM users WHERE id = ?');
    for (const l of links) {
      const id = insertRule.run(l.earner_id, `TB-provision ${nameOf.get(l.source_id)?.name ?? ''}`.trim(), l.percent, l.valid_from, l.valid_to).lastInsertRowid;
      insertSource.run(id, l.source_id);
    }
    db.exec('DROP TABLE commission_links');
  },

  // 3: BM som attesterar alla en konsults tid.
  `ALTER TABLE users ADD COLUMN bm_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
   CREATE INDEX users_bm ON users(bm_id);`,

  // 4: avtalsregister. Anställningar och uppdrag, som underlag för prognoser.
  `CREATE TABLE employments (
     id           INTEGER PRIMARY KEY,
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     type         TEXT NOT NULL DEFAULT 'permanent' CHECK (type IN ('permanent','fixed_term','probation')),
     start_date   TEXT NOT NULL,
     end_date     TEXT,
     notice_months INTEGER NOT NULL DEFAULT 0 CHECK (notice_months >= 0 AND notice_months <= 24),
     notes        TEXT NOT NULL DEFAULT '',
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     CHECK (end_date IS NULL OR end_date >= start_date)
   );
   CREATE INDEX employments_user ON employments(user_id);

   CREATE TABLE assignments (
     id             INTEGER PRIMARY KEY,
     user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     customer_id    INTEGER NOT NULL REFERENCES customers(id),
     project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
     title          TEXT NOT NULL DEFAULT '',
     start_date     TEXT NOT NULL,
     end_date       TEXT,
     hourly_rate    REAL NOT NULL CHECK (hourly_rate >= 0),
     hours_per_week REAL NOT NULL CHECK (hours_per_week > 0 AND hours_per_week <= 80),
     notes          TEXT NOT NULL DEFAULT '',
     created_at     TEXT NOT NULL DEFAULT (datetime('now')),
     CHECK (end_date IS NULL OR end_date >= start_date)
   );
   CREATE INDEX assignments_user ON assignments(user_id);
   CREATE INDEX assignments_customer ON assignments(customer_id);`,

  // 5: ekonomiadministratör. Hanterar fakturering och ekonomirapporter utan att vara administratör.
  `ALTER TABLE users ADD COLUMN finance INTEGER NOT NULL DEFAULT 0;`,

  // 6: två ekonominivåer. finance: 0 ingen, 1 ekonomi, 2 ekonomi-superuser.
  // De som redan hade behörigheten kunde allt som ekonomi kan, så de blir superuser och ingen tappar något.
  `UPDATE users SET finance = 2 WHERE finance = 1;`,

  // 7: ändringslogg. Bara tillägg: triggers stoppar ändring och radering, och namnen sparas som de hette då,
  // så att loggen läses rätt även när någon byter namn eller tas bort.
  `CREATE TABLE audit_log (
     id             INTEGER PRIMARY KEY,
     at             TEXT NOT NULL,
     day            TEXT NOT NULL,
     actor_id       INTEGER,
     actor_name     TEXT NOT NULL,
     entity         TEXT NOT NULL,
     action         TEXT NOT NULL,
     entity_id      INTEGER,
     label          TEXT NOT NULL DEFAULT '',
     user_id        INTEGER,
     user_label     TEXT,
     customer_id    INTEGER,
     customer_label TEXT,
     project_id     INTEGER,
     project_label  TEXT,
     changes        TEXT,
     note           TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX audit_day ON audit_log(day);
   CREATE INDEX audit_actor ON audit_log(actor_id);
   CREATE INDEX audit_user ON audit_log(user_id);
   CREATE INDEX audit_customer ON audit_log(customer_id);
   CREATE INDEX audit_project ON audit_log(project_id);
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'Ändringsloggen kan inte ändras.'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'Ändringsloggen kan inte raderas.'); END;`,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      const step = MIGRATIONS[v];
      if (typeof step === 'function') step(db);
      else db.exec(step);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// node:sqlite saknar transaction()-hjälpare. Synkront API, så BEGIN IMMEDIATE räcker.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Bygger UPDATE av nycklar som kommer från validerade scheman, aldrig från rå indata.
export function updateRow(db, table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => data[k]), id);
}

export function insertRow(db, table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return db.prepare(sql).run(...keys.map((k) => data[k])).lastInsertRowid;
}

export function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}
