import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costParams, db, FILES_DIR, getSettings, PRICE_PER_G, PRINT_SELECT, rateParams, saveSettings, SETTINGS_DEFAULTS, SPOOL_SELECT, tx } from './db.js';
import { getRates, refreshRates, scheduleRateRefresh } from './rates.js';
import { parse3mf, ThreeMfError } from './threemf.js';

const root = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(root, 'public')));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Čísla mohou přijít i s desetinnou čárkou („12,5“).
const toNum = v => Number(typeof v === 'string' ? v.trim().replace(',', '.') : v);

const SPOOL_FIELDS = ['brand', 'material', 'color_name', 'color_hex', 'diameter',
  'initial_weight', 'spool_weight', 'price', 'currency', 'location', 'notes', 'archived'];
const NUMERIC = new Set(['diameter', 'initial_weight', 'spool_weight', 'price']);
const CURRENCIES = ['USD', 'EUR', 'CZK'];

function pickSpool(body) {
  const out = {};
  for (const f of SPOOL_FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (NUMERIC.has(f)) v = v === '' || v === null ? null : toNum(v);
    if (f === 'archived') v = v ? 1 : 0;
    if (f === 'currency' && !CURRENCIES.includes(v)) throw new HttpError(400, 'Neplatná měna');
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

const PRINT_STATUSES = ['planned', 'ok', 'failed'];
const today = () => new Date().toISOString().slice(0, 10);

// Naplánované podle pořadí zadání, ostatní od nejnovějšího.
const PRINT_ORDER = `ORDER BY p.status = 'planned' DESC,
  CASE WHEN p.status = 'planned' THEN p.created_at END, CASE WHEN p.status = 'planned' THEN p.id END,
  p.printed_at DESC, p.id DESC`;

// Tisky včetně usages; where/params jsou pojmenované ($...).
function loadPrints(where = '', params = {}) {
  const prints = db.prepare(`${PRINT_SELECT} ${where ? `WHERE ${where}` : ''} ${PRINT_ORDER}`)
    .all({ ...costParams(), ...params });
  if (!prints.length) return [];
  const ids = prints.map(p => p.id);
  const usages = db.prepare(`
    SELECT u.id, u.print_id, u.spool_id, u.grams, s.brand, s.material, s.color_name, s.color_hex,
      ${PRICE_PER_G} AS price_per_g
    FROM print_usages u JOIN spools s ON s.id = u.spool_id
    WHERE u.print_id IN (SELECT value FROM json_each($ids))
    ORDER BY u.id`).all({ ...rateParams(), ids: JSON.stringify(ids) });
  const byPrint = Map.groupBy(usages, u => u.print_id);
  return prints.map(p => ({
    ...p,
    usages: (byPrint.get(p.id) ?? []).map(({ print_id, ...u }) => u),
  }));
}

function getPrint(id) {
  const [print] = loadPrints('p.id = $id', { id: Number(id) });
  if (!print) throw new HttpError(404, 'Tisk nenalezen');
  return print;
}

// Prázdný seznam je povolený jen u nepovedeného tisku (selhal hned na začátku).
function validateUsages(usages, allowEmpty = false) {
  if (allowEmpty && (usages == null || (Array.isArray(usages) && usages.length === 0))) return [];
  if (!Array.isArray(usages) || usages.length === 0) throw new HttpError(400, 'Tisk musí mít alespoň jednu cívku');
  return usages.map(u => {
    const grams = toNum(u.grams);
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

// Aktivní = nearchivovaná a ještě v ní něco je (nebo na ni čeká naplánovaný tisk);
// remaining je vypočtený sloupec, proto se SPOOL_SELECT filtruje jako poddotaz.
// Dotištěné cívky se tak samy přesunou do archivu, a když se tisk smaže, samy se vrátí.
const ACTIVE_SPOOL = 's.archived = 0 AND (s.remaining > 0 OR s.reserved > 0)';

app.get('/api/spools', (req, res) => {
  const where = req.query.archived === '1' ? `NOT (${ACTIVE_SPOOL})` : ACTIVE_SPOOL;
  res.json(db.prepare(`SELECT * FROM (${SPOOL_SELECT}) s WHERE ${where} ORDER BY s.material, s.brand, s.color_name`).all());
});

app.get('/api/spools/:id', (req, res) => {
  const spool = getSpool(req.params.id);
  spool.history = db.prepare(`
    SELECT 'print' AS kind, p.id AS ref_id, p.name AS label, -u.grams AS delta, p.printed_at AS at, p.status
      FROM print_usages u JOIN prints p ON p.id = u.print_id WHERE u.spool_id = ?
    UNION ALL
    SELECT 'adjust', a.id, a.reason, a.delta, a.created_at, NULL FROM adjustments a WHERE a.spool_id = ?
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

// „Přidat stejnou“: nové plné cívky se stejnými údaji, volitelně s jinou cenou.
app.post('/api/spools/:id/duplicate', (req, res) => {
  const src = getSpool(req.params.id);
  const count = toNum(req.body.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new HttpError(400, 'Počet musí být 1–50');
  const override = pickSpool(Object.fromEntries(['price', 'currency']
    .filter(f => req.body[f] !== undefined).map(f => [f, req.body[f]])));
  const copy = ['brand', 'material', 'color_name', 'color_hex', 'diameter', 'initial_weight',
    'spool_weight', 'price', 'currency', 'location'];
  const data = Object.fromEntries(copy.map(f => [f, f in override ? override[f] : src[f]]));
  const stmt = db.prepare(`INSERT INTO spools (${copy.join(',')}) VALUES (${copy.map(() => '?').join(',')})`);
  const ids = tx(() => Array.from({ length: count }, () => stmt.run(...Object.values(data)).lastInsertRowid));
  res.status(201).json(ids.map(getSpool));
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
    target = toNum(req.body.gross) - spool.spool_weight;
  } else {
    target = toNum(req.body.remaining);
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
  const where = [];
  const params = {};
  if (req.query.status) {
    if (!PRINT_STATUSES.includes(req.query.status)) throw new HttpError(400, 'Neplatný stav tisku');
    where.push('p.status = $status');
    params.status = req.query.status;
  }
  if (req.query.project_id) {
    where.push('p.project_id = $project_id');
    params.project_id = Number(req.query.project_id);
  }
  res.json(loadPrints(where.join(' AND '), params));
});

app.get('/api/prints/:id', (req, res) => res.json(getPrint(req.params.id)));

function parsePercent(value) {
  const percent = toNum(value);
  if (value === '' || value == null || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new HttpError(400, 'Vytištěno % musí být číslo 0–100');
  }
  return percent;
}

function pickPrint(body) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Zadejte název tisku');
  const status = body.status || 'ok';
  if (!PRINT_STATUSES.includes(status)) throw new HttpError(400, 'Neplatný stav tisku');

  // Jen nepovedený tisk může mít méně než 100 %.
  const percent = status === 'failed' && body.percent !== undefined ? parsePercent(body.percent) : 100;

  let duration_min = null;
  if (body.duration_min !== '' && body.duration_min != null) {
    duration_min = toNum(body.duration_min);
    if (!Number.isFinite(duration_min) || duration_min < 0) throw new HttpError(400, 'Neplatný čas tisku');
  }

  let project_id = null;
  if (body.project_id !== '' && body.project_id != null) {
    project_id = Number(body.project_id);
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project_id)) {
      throw new HttpError(400, `Projekt #${body.project_id} neexistuje`);
    }
  }

  return {
    name,
    printed_at: body.printed_at || today(),
    status,
    percent,
    duration_min,
    project_id,
    notes: String(body.notes ?? ''),
    ...pickFileLink(body),
  };
}

// Vazba tisku na podložku nahraného 3MF; chybějící/null pole vazbu ruší (i u PUT).
function pickFileLink(body) {
  if (body.file_id === '' || body.file_id == null) return { file_id: null, plate_index: null };
  const file = getFile(body.file_id, 400);
  if (body.plate_index === '' || body.plate_index == null) throw new HttpError(400, 'Chybí číslo podložky');
  const plate_index = Number(body.plate_index);
  if (!file.meta.plates.some(p => p.index === plate_index)) {
    throw new HttpError(400, `Soubor ${file.filename} nemá podložku ${body.plate_index}`);
  }
  return { file_id: file.id, plate_index };
}

app.post('/api/prints', (req, res) => {
  const p = pickPrint(req.body);
  const usages = validateUsages(req.body.usages, p.status === 'failed');
  const id = tx(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO prints (name, printed_at, status, percent, duration_min, project_id, notes, file_id, plate_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.name, p.printed_at, p.status, p.percent, p.duration_min, p.project_id, p.notes, p.file_id, p.plate_index);
    insertUsages(lastInsertRowid, usages);
    return lastInsertRowid;
  });
  res.status(201).json(getPrint(id));
});

// Import podložek z nahraného 3MF jako naplánované tisky, volitelně do nového projektu.
app.post('/api/prints/import', (req, res) => {
  const file = getFile(req.body.file_id, 400);
  const rows = req.body.prints;
  if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, 'Vyberte alespoň jednu podložku');

  const existingProject = req.body.project_id !== '' && req.body.project_id != null;
  const newName = String(req.body.new_project_name ?? '').trim();
  const prints = rows.map(r => {
    const p = pickPrint({ ...r, status: 'planned', notes: r.notes ?? '', printed_at: today(),
      project_id: existingProject ? req.body.project_id : null, file_id: file.id });
    return { ...p, usages: validateUsages(r.usages) };
  });

  const result = tx(() => {
    let project_id = existingProject ? prints[0].project_id : null;
    if (!existingProject && newName) {
      project_id = Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run(newName).lastInsertRowid);
    }
    const stmt = db.prepare(`
      INSERT INTO prints (name, printed_at, status, percent, duration_min, project_id, notes, file_id, plate_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = prints.map(p => {
      const { lastInsertRowid } = stmt.run(p.name, p.printed_at, p.status, p.percent, p.duration_min,
        project_id, p.notes, p.file_id, p.plate_index);
      insertUsages(lastInsertRowid, p.usages);
      return Number(lastInsertRowid);
    });
    return { project_id, ids };
  });
  const byId = new Map(loadPrints('p.id IN (SELECT value FROM json_each($ids))', { ids: JSON.stringify(result.ids) })
    .map(p => [p.id, p]));
  res.status(201).json({ project_id: result.project_id, prints: result.ids.map(id => byId.get(id)) });
});

app.put('/api/prints/:id', (req, res) => {
  getPrint(req.params.id);
  const p = pickPrint(req.body);
  const usages = validateUsages(req.body.usages, p.status === 'failed');
  tx(() => {
    db.prepare(`
      UPDATE prints SET name = ?, printed_at = ?, status = ?, percent = ?, duration_min = ?,
        project_id = ?, notes = ?, file_id = ?, plate_index = ? WHERE id = ?`
    ).run(p.name, p.printed_at, p.status, p.percent, p.duration_min, p.project_id, p.notes,
      p.file_id, p.plate_index, req.params.id);
    db.prepare('DELETE FROM print_usages WHERE print_id = ?').run(req.params.id);
    insertUsages(req.params.id, usages);
  });
  res.json(getPrint(req.params.id));
});

// Potvrzení naplánovaného tisku. Bez usages se plánované gramy přepočtou podle percent.
app.post('/api/prints/:id/complete', (req, res) => {
  const print = getPrint(req.params.id);
  if (print.status !== 'planned') throw new HttpError(409, 'Tisk už není naplánovaný');
  const { status } = req.body;
  if (status !== 'ok' && status !== 'failed') throw new HttpError(400, 'Stav musí být ok nebo failed');
  if (status === 'failed' && (req.body.percent === undefined || req.body.percent === '')) {
    throw new HttpError(400, 'U nepovedeného tisku zadejte, kolik % se vytisklo');
  }
  const percent = status === 'failed' ? parsePercent(req.body.percent) : 100;
  const printed_at = req.body.printed_at || today();

  const usages = req.body.usages == null
    ? print.usages
        .map(u => ({ spool_id: u.spool_id, grams: Math.round(u.grams * percent / 10) / 10 }))
        .filter(u => u.grams > 0)
    : validateUsages(req.body.usages, status === 'failed');

  tx(() => {
    db.prepare('UPDATE prints SET status = ?, percent = ?, printed_at = ? WHERE id = ?')
      .run(status, percent, printed_at, print.id);
    db.prepare('DELETE FROM print_usages WHERE print_id = ?').run(print.id);
    insertUsages(print.id, usages);
  });
  res.json(getPrint(print.id));
});

// ?keep=1: tisk proběhl, jen se maže záznam — spotřeba zůstane odečtená jako korekce na cívkách.
app.delete('/api/prints/:id', (req, res) => {
  const print = getPrint(req.params.id);
  const keep = req.query.keep === '1' && print.status !== 'planned';
  tx(() => {
    if (keep) {
      const stmt = db.prepare('INSERT INTO adjustments (spool_id, delta, reason) VALUES (?, ?, ?)');
      for (const u of print.usages) stmt.run(u.spool_id, -u.grams, `Smazaný tisk: ${print.name}`);
    }
    db.prepare('DELETE FROM prints WHERE id = ?').run(print.id);
  });
  res.status(204).end();
});

// --- Soubory 3MF ---

const filePath = id => join(FILES_DIR, `${id}.3mf`);
const thumbPath = (id, plate) => join(FILES_DIR, `${id}-${plate}.png`);

// status: 404 u přímého dotazu na soubor, 400 když na něj odkazuje tělo požadavku.
function getFile(id, status = 404) {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(status, `Soubor #${id} neexistuje`);
  return { ...row, meta: JSON.parse(row.meta) };
}

function fileJson(file) {
  const { sha256, ...rest } = file;
  return {
    ...rest,
    meta: {
      ...file.meta,
      plates: file.meta.plates.map(p => ({ ...p, thumb_url: p.has_thumb ? `/api/files/${file.id}/plates/${p.index}.png` : null })),
    },
  };
}

// Tělo je celý soubor (ne multipart), název v hlavičce X-Filename (URI-encoded).
app.post('/api/files', express.raw({ type: '*/*', limit: '250mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Prázdný soubor');
  let filename;
  try {
    filename = decodeURIComponent(req.get('X-Filename') || '').split(/[\\/]/).pop().trim();
  } catch {
    throw new HttpError(400, 'Neplatný název souboru');
  }
  if (!filename) filename = 'projekt.3mf';

  const sha256 = createHash('sha256').update(req.body).digest('hex');
  const existing = db.prepare('SELECT id FROM files WHERE sha256 = ?').get(sha256);
  if (existing) return res.json(fileJson(getFile(existing.id)));

  let parsed;
  try {
    parsed = parse3mf(req.body, filename);
  } catch (err) {
    if (err instanceof ThreeMfError) throw new HttpError(400, err.message);
    throw err;
  }
  const { meta, thumbs } = parsed;
  // Zápis na disk uvnitř transakce: když selže, řádek se nevloží a rozepsané soubory se uklidí.
  const id = Number(tx(() => {
    const { lastInsertRowid: newId } = db.prepare('INSERT INTO files (filename, sha256, size, meta) VALUES (?, ?, ?, ?)')
      .run(filename, sha256, req.body.length, JSON.stringify(meta));
    try {
      writeFileSync(filePath(newId), req.body);
      for (const [plate, png] of thumbs) writeFileSync(thumbPath(newId, plate), png);
    } catch (err) {
      rmSync(filePath(newId), { force: true });
      for (const plate of thumbs.keys()) rmSync(thumbPath(newId, plate), { force: true });
      throw err;
    }
    return newId;
  }));
  res.status(201).json(fileJson(getFile(id)));
});

app.get('/api/files/:id', (req, res) => res.json(fileJson(getFile(req.params.id))));

app.get('/api/files/:id/download', (req, res, next) => {
  const file = getFile(req.params.id);
  if (!existsSync(filePath(file.id))) throw new HttpError(404, 'Soubor chybí na disku');
  res.download(filePath(file.id), file.filename, err => { if (err && !res.headersSent) next(err); });
});

app.get('/api/files/:id/plates/:n.png', (req, res, next) => {
  const file = getFile(req.params.id);
  const path = thumbPath(file.id, Number(req.params.n));
  if (!Number.isInteger(Number(req.params.n)) || !existsSync(path)) throw new HttpError(404, 'Náhled nenalezen');
  res.sendFile(path, { maxAge: '7d' }, err => { if (err && !res.headersSent) next(err); });
});

// --- Projekty ---

const PROJECT_STATUSES = ['active', 'done'];

// Souhrny počítají jen ok + failed; planned jen jako planned_count.
const PROJECT_SELECT = `
  WITH pc AS (${PRINT_SELECT})
  SELECT pj.*,
    COUNT(pc.id) FILTER (WHERE pc.status != 'planned') AS print_count,
    COUNT(pc.id) FILTER (WHERE pc.status = 'planned') AS planned_count,
    COALESCE(SUM(pc.grams) FILTER (WHERE pc.status != 'planned'), 0) AS grams,
    COALESCE(SUM(pc.grams) FILTER (WHERE pc.status = 'failed'), 0) AS failed_grams,
    CASE WHEN COUNT(pc.id) FILTER (WHERE pc.status != 'planned' AND pc.filament_cost IS NULL) > 0 THEN NULL
      ELSE COALESCE(SUM(pc.filament_cost) FILTER (WHERE pc.status != 'planned'), 0) END AS filament_cost,
    SUM(pc.energy_cost) FILTER (WHERE pc.status != 'planned') AS energy_cost,
    CASE WHEN COUNT(pc.id) FILTER (WHERE pc.status = 'failed' AND pc.filament_cost IS NULL) > 0 THEN NULL
      ELSE COALESCE(SUM(pc.filament_cost) FILTER (WHERE pc.status = 'failed'), 0)
         + COALESCE(SUM(pc.energy_cost) FILTER (WHERE pc.status = 'failed'), 0) END AS failed_cost
  FROM projects pj LEFT JOIN pc ON pc.project_id = pj.id
`;

function loadProjects(where = '', params = {}) {
  return db.prepare(`${PROJECT_SELECT} ${where ? `WHERE ${where}` : ''}
    GROUP BY pj.id ORDER BY pj.status = 'active' DESC, pj.created_at DESC, pj.id DESC`)
    .all({ ...costParams(), ...params });
}

function getProject(id) {
  const [project] = loadProjects('pj.id = $id', { id: Number(id) });
  if (!project) throw new HttpError(404, 'Projekt nenalezen');
  return project;
}

// partial: u PUT se mění jen poslaná pole.
function pickProject(body, partial = false) {
  const out = {};
  if (!partial || 'name' in body) {
    out.name = String(body.name ?? '').trim();
    if (!out.name) throw new HttpError(400, 'Zadejte název projektu');
  }
  if ('notes' in body) out.notes = String(body.notes ?? '');
  if ('status' in body) {
    if (!PROJECT_STATUSES.includes(body.status)) throw new HttpError(400, 'Neplatný stav projektu');
    out.status = body.status;
  }
  return out;
}

app.get('/api/projects', (req, res) => {
  const status = req.query.status || 'all';
  if (status === 'all') return res.json(loadProjects());
  if (!PROJECT_STATUSES.includes(status)) throw new HttpError(400, 'Neplatný stav projektu');
  res.json(loadProjects('pj.status = $status', { status }));
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  project.prints = loadPrints('p.project_id = $id', { id: project.id });
  res.json(project);
});

app.post('/api/projects', (req, res) => {
  const data = pickProject(req.body);
  const cols = Object.keys(data);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO projects (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...Object.values(data));
  res.status(201).json(getProject(lastInsertRowid));
});

app.put('/api/projects/:id', (req, res) => {
  getProject(req.params.id);
  const data = pickProject(req.body, true);
  const cols = Object.keys(data);
  if (cols.length) {
    db.prepare(`UPDATE projects SET ${cols.map(c => `${c} = ?`).join(',')} WHERE id = ?`)
      .run(...Object.values(data), req.params.id);
  }
  res.json(getProject(req.params.id));
});

// Tisky zůstanou, project_id se vynuluje (ON DELETE SET NULL).
app.delete('/api/projects/:id', (req, res) => {
  getProject(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- Přehled ---

app.get('/api/stats', (req, res) => {
  const spools = db.prepare(`SELECT * FROM (${SPOOL_SELECT}) s WHERE ${ACTIVE_SPOOL}`).all();
  const { low_threshold } = getSettings();
  // Cena měsíce sčítá jen známé částky.
  const month = db.prepare(`
    WITH pc AS (${PRINT_SELECT})
    SELECT COALESCE(SUM(grams), 0) AS grams, COUNT(*) AS prints,
      COALESCE(SUM(COALESCE(filament_cost, 0) + COALESCE(energy_cost, 0)), 0) AS cost
    FROM pc WHERE status != 'planned' AND printed_at >= date('now', 'start of month')`).get(costParams());
  const { plannedCount } = db.prepare(
    "SELECT COUNT(*) AS plannedCount FROM prints WHERE status = 'planned'").get();
  const byMaterial = Object.entries(Object.groupBy(spools, s => s.material))
    .map(([material, list]) => ({ material, remaining: list.reduce((a, s) => a + Math.max(s.remaining, 0), 0), count: list.length }))
    .sort((a, b) => b.remaining - a.remaining);
  res.json({
    spoolCount: spools.length,
    totalRemaining: spools.reduce((a, s) => a + Math.max(s.remaining, 0), 0),
    lowCount: spools.filter(s => s.remaining < low_threshold).length,
    month,
    plannedCount,
    byMaterial,
  });
});

// --- Nastavení a export ---

app.get('/api/settings', (req, res) => res.json(getSettings()));

app.put('/api/settings', (req, res) => {
  const values = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (!(key in req.body)) continue;
    const v = toNum(req.body[key]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Neplatná hodnota: ${key}`);
    values[key] = v;
  }
  res.json(saveSettings(values));
});

app.get('/api/rates', (req, res) => res.json(getRates()));

app.post('/api/rates/refresh', async (req, res) => {
  try {
    res.json(await refreshRates());
  } catch (err) {
    throw new HttpError(502, `Kurzy ČNB se nepodařilo stáhnout: ${err.message}`);
  }
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
scheduleRateRefresh();
app.listen(port, () => console.log(`SpoolMaster běží na http://localhost:${port}`));
