import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Belopp lagras som heltal i öre (signerade). Kurser och antal är REAL. Datum är ISO (YYYY-MM-DD).
// Varje migration körs en gång, i ordning. PRAGMA user_version håller reda på nivån.
export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- kind 'transfer' = flyttar pengar mellan egna konton eller mellan kassa och tillgångar (sparande,
  -- amortering). Räknas inte in i resultatet, men syns i balansen.
  CREATE TABLE categories (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL COLLATE NOCASE,
    kind    TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
    UNIQUE (user_id, name)
  );

  -- Skuldkonton (lån, kreditkort) har negativt saldo.
  CREATE TABLE accounts (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL COLLATE NOCASE,
    kind            TEXT NOT NULL CHECK (kind IN ('checking','savings','isk','depot','pension','other_asset','loan','credit')),
    opening_balance INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, name)
  );

  CREATE TABLE transactions (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    description TEXT NOT NULL,
    -- Versaler, för sökning. SQLites UPPER() hanterar bara ASCII, så åäö normaliseras i JS.
    search      TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    balance     INTEGER,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    auto        TEXT CHECK (auto IN ('rule','transfer')),
    fingerprint TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, fingerprint)
  );
  CREATE INDEX tx_user_date ON transactions(user_id, date);
  CREATE INDEX tx_account ON transactions(account_id);

  CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern     TEXT NOT NULL COLLATE NOCASE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    UNIQUE (user_id, pattern)
  );

  -- price_mode 'auto' hämtar kurs via symbolen, 'manual' använder manual_price (fonder som saknar börssymbol).
  CREATE TABLE holdings (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    symbol       TEXT NOT NULL DEFAULT '',
    quantity     REAL NOT NULL CHECK (quantity >= 0),
    currency     TEXT NOT NULL DEFAULT 'SEK',
    price_mode   TEXT NOT NULL DEFAULT 'auto' CHECK (price_mode IN ('auto','manual')),
    manual_price REAL,
    manual_price_date TEXT,
    cost_basis   INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX holdings_user ON holdings(user_id);

  -- Delad kurscache. Nyckel är symbolen (valutakurser som "USDSEK=X").
  CREATE TABLE prices (
    symbol     TEXT PRIMARY KEY,
    price      REAL NOT NULL,
    currency   TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE net_worth_snapshots (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    assets      INTEGER NOT NULL,
    liabilities INTEGER NOT NULL,
    PRIMARY KEY (user_id, date)
  );
  `,
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
  return Number(db.prepare(sql).run(...keys.map((k) => data[k])).lastInsertRowid);
}
