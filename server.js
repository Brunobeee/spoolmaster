import express from 'express';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, saveSettings, SETTINGS_DEFAULTS, SPOOL_SELECT, tx } from './db.js';

const root = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(root, 'public')));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SPOOL_FIELDS = ['brand', 'material', 'color_name', 'color_hex', 'diameter',
  'initial_weight', 'spool_weight', 'price', 'location', 'notes', 'archived'];
const NUMERIC = new Set(['diameter', 'initial_weight', 'spool_weight', 'price']);

function pickSpool(body) {
  const out = {};
  for (const f of SPOOL_FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (NUMERIC.has(f)) v = v === '' || v === null ? null : Number(v);
    if (f === 'archived') v = v ? 1 : 0;
    if (NUMERIC.has(f) && v !== null && !Number.isFinite(v)) throw new HttpError(400, `Neplatná hodnota: ${f}`);
    out[f] = v;
  }
  for (const f of ['diameter', 'initial_weight']) {
    if (f in out && out[f] === null) delete out[f];
  }
  return out;
}

function getSpool(id) {
  const spool = db.prepare(`${SPOOL_SELECT} WHERE s.id = ?`).get(id);
  if (!spool) throw new HttpError(404, 'Cívka nenalezena');
  return spool;
}

function getPrint(id) {
  const print = db.prepare('SELECT * FROM prints WHERE id = ?').get(id);
  if (!print) throw new HttpError(404, 'Tisk nenalezen');
  print.usages = db.prepare(`
    SELECT u.id, u.spool_id, u.grams, s.brand, s.material, s.color_name, s.color_hex
    FROM print_usages u JOIN spools s ON s.id = u.spool_id
    WHERE u.print_id = ?`).all(id);
  return print;
}

function validateUsages(usages) {
  if (!Array.isArray(usages) || usages.length === 0) throw new HttpError(400, 'Tisk musí mít alespoň jednu cívku');
  return usages.map(u => {
    const grams = Number(u.grams);
    const spool_id = Number(u.spool_id);
    if (!Number.isFinite(grams) || grams <= 0) throw new HttpError(400, 'Gramáž musí být kladné číslo');
    if (!db.prepare('SELECT 1 FROM spools WHERE id = ?').get(spool_id)) throw new HttpError(400, `Cívka #${spool_id} neexistuje`);
    return { spool_id, grams };
  });
}

function insertUsages(printId, usages) {
  const stmt = db.prepare('INSERT INTO print_usages (print_id, spool_id, grams) VALUES (?, ?, ?)');
  for (const u of usages) stmt.run(printId, u.spool_id, u.grams);
}

// --- Cívky ---

app.get('/api/spools', (req, res) => {
  const archived = req.query.archived === '1' ? 1 : 0;
  res.json(db.prepare(`${SPOOL_SELECT} WHERE s.archived = ? ORDER BY s.material, s.brand, s.color_name`).all(archived));
});

app.get('/api/spools/:id', (req, res) => {
  const spool = getSpool(req.params.id);
  spool.history = db.prepare(`
    SELECT 'print' AS kind, p.id AS ref_id, p.name AS label, -u.grams AS delta, p.printed_at AS at
      FROM print_usages u JOIN prints p ON p.id = u.print_id WHERE u.spool_id = ?
    UNION ALL
    SELECT 'adjust', a.id, a.reason, a.delta, a.created_at FROM adjustments a WHERE a.spool_id = ?
    ORDER BY at DESC`).all(spool.id, spool.id);
  res.json(spool);
});

app.post('/api/spools', (req, res) => {
  const data = pickSpool(req.body);
  const cols = Object.keys(data);
  const sql = cols.length
    ? `INSERT INTO spools (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    : 'INSERT INTO spools DEFAULT VALUES';
  const { lastInsertRowid } = db.prepare(sql).run(...Object.values(data));
  res.status(201).json(getSpool(lastInsertRowid));
});

app.put('/api/spools/:id', (req, res) => {
  getSpool(req.params.id);
  const data = pickSpool(req.body);
  const cols = Object.keys(data);
  if (cols.length) {
    db.prepare(`UPDATE spools SET ${cols.map(c => `${c} = ?`).join(',')} WHERE id = ?`)
      .run(...Object.values(data), req.params.id);
  }
  res.json(getSpool(req.params.id));
});

app.delete('/api/spools/:id', (req, res) => {
  getSpool(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM print_usages WHERE spool_id = ?').get(req.params.id).n;
  if (used > 0) throw new HttpError(409, 'Cívka je použitá v tiscích — místo smazání ji archivujte');
  db.prepare('DELETE FROM spools WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Korekce zůstatku: buď převážením (brutto s cívkou), nebo přímým zadáním zbytku.
app.post('/api/spools/:id/adjust', (req, res) => {
  const spool = getSpool(req.params.id);
  let target;
  if (req.body.gross !== undefined && req.body.gross !== '') {
    if (spool.spool_weight == null) throw new HttpError(400, 'Cívka nemá vyplněnou hmotnost prázdné cívky');
    target = Number(req.body.gross) - spool.spool_weight;
  } else {
    target = Number(req.body.remaining);
  }
  if (!Number.isFinite(target)) throw new HttpError(400, 'Neplatná hmotnost');
  const delta = Math.round((target - spool.remaining) * 10) / 10;
  if (delta !== 0) {
    db.prepare('INSERT INTO adjustments (spool_id, delta, reason) VALUES (?, ?, ?)')
      .run(spool.id, delta, req.body.reason || 'Převážení');
  }
  res.json(getSpool(spool.id));
});

// --- Tisky ---

app.get('/api/prints', (req, res) => {
  const prints = db.prepare('SELECT * FROM prints ORDER BY printed_at DESC, id DESC').all();
  const usages = db.prepare(`
    SELECT u.print_id, u.spool_id, u.grams, s.brand, s.material, s.color_name, s.color_hex
    FROM print_usages u JOIN spools s ON s.id = u.spool_id`).all();
  const byPrint = Map.groupBy(usages, u => u.print_id);
  res.json(prints.map(p => ({ ...p, usages: byPrint.get(p.id) ?? [] })));
});

app.get('/api/prints/:id', (req, res) => res.json(getPrint(req.params.id)));

function pickPrint(body) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Zadejte název tisku');
  return {
    name,
    printed_at: body.printed_at || new Date().toISOString().slice(0, 10),
    status: body.status === 'failed' ? 'failed' : 'ok',
    notes: String(body.notes ?? ''),
  };
}

app.post('/api/prints', (req, res) => {
  const p = pickPrint(req.body);
  const usages = validateUsages(req.body.usages);
  const id = tx(() => {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO prints (name, printed_at, status, notes) VALUES (?, ?, ?, ?)'
    ).run(p.name, p.printed_at, p.status, p.notes);
    insertUsages(lastInsertRowid, usages);
    return lastInsertRowid;
  });
  res.status(201).json(getPrint(id));
});

app.put('/api/prints/:id', (req, res) => {
  getPrint(req.params.id);
  const p = pickPrint(req.body);
  const usages = validateUsages(req.body.usages);
  tx(() => {
    db.prepare('UPDATE prints SET name = ?, printed_at = ?, status = ?, notes = ? WHERE id = ?')
      .run(p.name, p.printed_at, p.status, p.notes, req.params.id);
    db.prepare('DELETE FROM print_usages WHERE print_id = ?').run(req.params.id);
    insertUsages(req.params.id, usages);
  });
  res.json(getPrint(req.params.id));
});

app.delete('/api/prints/:id', (req, res) => {
  getPrint(req.params.id);
  db.prepare('DELETE FROM prints WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- Přehled ---

app.get('/api/stats', (req, res) => {
  const spools = db.prepare(`${SPOOL_SELECT} WHERE s.archived = 0`).all();
  const { low_threshold } = getSettings();
  const month = db.prepare(`
    SELECT COALESCE(SUM(u.grams), 0) AS grams, COUNT(DISTINCT p.id) AS prints
    FROM prints p LEFT JOIN print_usages u ON u.print_id = p.id
    WHERE p.printed_at >= date('now', 'start of month')`).get();
  const byMaterial = Object.entries(Object.groupBy(spools, s => s.material))
    .map(([material, list]) => ({ material, remaining: list.reduce((a, s) => a + Math.max(s.remaining, 0), 0), count: list.length }))
    .sort((a, b) => b.remaining - a.remaining);
  res.json({
    spoolCount: spools.length,
    totalRemaining: spools.reduce((a, s) => a + Math.max(s.remaining, 0), 0),
    lowCount: spools.filter(s => s.remaining < low_threshold).length,
    month,
    byMaterial,
  });
});

// --- Nastavení a export ---

app.get('/api/settings', (req, res) => res.json(getSettings()));

app.put('/api/settings', (req, res) => {
  const values = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (!(key in req.body)) continue;
    const v = Number(req.body[key]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Neplatná hodnota: ${key}`);
    values[key] = v;
  }
  res.json(saveSettings(values));
});

// VACUUM INTO vytvoří konzistentní kopii i za běhu (včetně dat ještě ve WAL).
app.get('/api/export', (req, res, next) => {
  const file = join(tmpdir(), `spoolmaster-export-${Date.now()}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  const name = `spoolmaster-${new Date().toISOString().slice(0, 10)}.db`;
  res.download(file, name, err => {
    rmSync(file, { force: true });
    if (err && !res.headersSent) next(err);
  });
});

app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Nenalezeno' }));

app.use((err, req, res, next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Chyba serveru' });
});

const port = Number(process.env.PORT) || 3420;
app.listen(port, () => console.log(`SpoolMaster běží na http://localhost:${port}`));
