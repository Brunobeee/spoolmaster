import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SPOOLMASTER_DB || join(root, 'data', 'spoolmaster.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// Schéma se mění jen přidáním nové migrace na konec seznamu — nikdy neupravovat ty stávající.
// Verze se drží v PRAGMA user_version. Migrace 1 používá IF NOT EXISTS, aby navázala
// i na databáze z doby před migracemi (user_version = 0).
//
// Zůstatek cívky se nikde neukládá — vždy se počítá z počáteční hmotnosti,
// spotřeby v tiscích a ručních korekcí (vážení). Smazání tisku tak gramy vrátí.
const MIGRATIONS = [
  `
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
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Projekty a fronta. SQLite neumí změnit CHECK, takže se prints přestaví (cizí klíče
  // jsou během migrací vypnuté, jinak by DROP smazal print_usages).
  `
  CREATE TABLE projects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE prints_new (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    printed_at     TEXT NOT NULL DEFAULT (date('now')),
    status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('planned', 'ok', 'failed')),
    percent        REAL NOT NULL DEFAULT 100 CHECK (percent >= 0 AND percent <= 100),
    duration_min   REAL,
    project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    notes          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO prints_new (id, name, printed_at, status, percent, duration_min, project_id, notes, created_at)
    SELECT id, name, printed_at, status, 100, NULL, NULL, notes, created_at FROM prints;
  DROP TABLE prints;
  ALTER TABLE prints_new RENAME TO prints;

  CREATE INDEX idx_prints_project ON prints(project_id);
  CREATE INDEX idx_prints_status ON prints(status);
  `,
  // Měna ceny cívky (hlavní je USD). Ceny zadané před touto migrací byly v Kč.
  `
  ALTER TABLE spools ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'EUR', 'CZK'));
  UPDATE spools SET currency = 'CZK' WHERE price IS NOT NULL;

  CREATE TABLE exchange_rates (
    currency     TEXT PRIMARY KEY,
    czk_per_unit REAL NOT NULL,
    rate_date    TEXT NOT NULL,
    fetched_at   TEXT NOT NULL
  );
  `,
];

// Cizí klíče se vypínají před transakcí (uvnitř je pragma bez účinku), aby šly přestavět
// tabulky; integrita se ověří foreign_key_check ještě před COMMITem.
function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= MIGRATIONS.length) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      tx(() => {
        db.exec(MIGRATIONS[v]);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migrace ${v + 1} porušila cizí klíče: ${JSON.stringify(broken)}`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
      console.log(`Databáze migrována na verzi ${v + 1}`);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`Databáze porušuje cizí klíče: ${JSON.stringify(broken)}`);
}

// Naplánované tisky zůstatek nemění, jen rezervují (reserved).
export const SPOOL_SELECT = `
  SELECT s.*, s.initial_weight - s.used + s.adjusted AS remaining
  FROM (
    SELECT sp.*,
      COALESCE((SELECT SUM(u.grams) FROM print_usages u JOIN prints p ON p.id = u.print_id
                WHERE u.spool_id = sp.id AND p.status != 'planned'), 0) AS used,
      COALESCE((SELECT SUM(u.grams) FROM print_usages u JOIN prints p ON p.id = u.print_id
                WHERE u.spool_id = sp.id AND p.status = 'planned'), 0) AS reserved,
      COALESCE((SELECT SUM(delta) FROM adjustments WHERE spool_id = sp.id), 0) AS adjusted
    FROM spools sp
  ) s
`;

// Cena za gram v USD (přepočet kurzem ČNB); NULL, když cívka nemá cenu.
// Parametry $rate_usd a $rate_eur = Kč za jednotku, viz rateParams().
export const PRICE_PER_G = `CASE WHEN s.price IS NULL OR s.initial_weight <= 0 THEN NULL
  ELSE s.price * (CASE s.currency WHEN 'USD' THEN 1.0 WHEN 'EUR' THEN $rate_eur / $rate_usd ELSE 1.0 / $rate_usd END)
    / s.initial_weight END`;

// Tisk s gramáží a cenou v USD. Cena filamentu je NULL, když některá cívka nemá cenu;
// elektřina (cena kWh je v Kč) NULL bez duration_min. Parametry viz costParams().
export const PRINT_SELECT = `
  SELECT p.*, pj.name AS project_name,
    COALESCE(c.grams, 0) AS grams,
    CASE WHEN c.unknown > 0 THEN NULL ELSE COALESCE(c.cost, 0) END AS filament_cost,
    p.duration_min / 60.0 * $printer_watts / 1000.0 * $kwh_price / $rate_usd * p.percent / 100.0 AS energy_cost
  FROM prints p
  LEFT JOIN projects pj ON pj.id = p.project_id
  LEFT JOIN (
    SELECT u.print_id, SUM(u.grams) AS grams, SUM(u.grams * ${PRICE_PER_G}) AS cost,
      SUM(${PRICE_PER_G} IS NULL) AS unknown
    FROM print_usages u JOIN spools s ON s.id = u.spool_id
    GROUP BY u.print_id
  ) c ON c.print_id = p.id
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

migrate();

// --- Nastavení ---

export const RATE_FALLBACK = { USD: 22, EUR: 25 };

export const SETTINGS_DEFAULTS = {
  kwh_price: 6,              // Kč za kWh
  printer_watts: 150,        // průměrný příkon tiskárny ve W
  low_threshold: 150,        // pod kolik gramů cívka „dochází“
  default_spool_weight: 250, // hmotnost prázdné cívky pro nové cívky (g)
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map(r => [r.key, Number(r.value)]));
  return { ...SETTINGS_DEFAULTS, ...stored };
}

// Pojmenované parametry pro PRICE_PER_G a PRINT_SELECT (čtou se živě z nastavení a kurzů).
// Kurzy se čtou přímo z tabulky, aby db.js nezávisel na rates.js (ten importuje db).
export function rateParams() {
  const rows = db.prepare('SELECT currency, czk_per_unit FROM exchange_rates').all();
  const r = Object.fromEntries(rows.map(x => [x.currency, x.czk_per_unit]));
  return { rate_usd: r.USD ?? RATE_FALLBACK.USD, rate_eur: r.EUR ?? RATE_FALLBACK.EUR };
}

export function costParams() {
  const { kwh_price, printer_watts } = getSettings();
  return { kwh_price, printer_watts, ...rateParams() };
}

export function saveSettings(values) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const [key, value] of Object.entries(values)) stmt.run(key, String(value));
  });
  return getSettings();
}
