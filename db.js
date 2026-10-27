import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SPOOLMASTER_DB || join(root, 'data', 'spoolmaster.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// Zůstatek cívky se nikde neukládá — vždy se počítá z počáteční hmotnosti,
// spotřeby v tiscích a ručních korekcí (vážení). Smazání tisku tak gramy vrátí.
db.exec(`
  CREATE TABLE IF NOT EXISTS spools (
    id             INTEGER PRIMARY KEY,
    brand          TEXT NOT NULL DEFAULT '',
    material       TEXT NOT NULL DEFAULT 'PLA',
    color_name     TEXT NOT NULL DEFAULT '',
    color_hex      TEXT NOT NULL DEFAULT '#888888',
    diameter       REAL NOT NULL DEFAULT 1.75,
    initial_weight REAL NOT NULL DEFAULT 1000,
    spool_weight   REAL,
    price          REAL,
    location       TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prints (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    printed_at TEXT NOT NULL DEFAULT (date('now')),
    status     TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS print_usages (
    id       INTEGER PRIMARY KEY,
    print_id INTEGER NOT NULL REFERENCES prints(id) ON DELETE CASCADE,
    spool_id INTEGER NOT NULL REFERENCES spools(id),
    grams    REAL NOT NULL CHECK (grams > 0)
  );

  CREATE TABLE IF NOT EXISTS adjustments (
    id         INTEGER PRIMARY KEY,
    spool_id   INTEGER NOT NULL REFERENCES spools(id) ON DELETE CASCADE,
    delta      REAL NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_usages_print ON print_usages(print_id);
  CREATE INDEX IF NOT EXISTS idx_usages_spool ON print_usages(spool_id);
  CREATE INDEX IF NOT EXISTS idx_adj_spool ON adjustments(spool_id);
`);

export const SPOOL_SELECT = `
  SELECT s.*,
    COALESCE((SELECT SUM(grams) FROM print_usages WHERE spool_id = s.id), 0) AS used,
    COALESCE((SELECT SUM(delta) FROM adjustments WHERE spool_id = s.id), 0) AS adjusted,
    s.initial_weight
      - COALESCE((SELECT SUM(grams) FROM print_usages WHERE spool_id = s.id), 0)
      + COALESCE((SELECT SUM(delta) FROM adjustments WHERE spool_id = s.id), 0) AS remaining
  FROM spools s
`;

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
