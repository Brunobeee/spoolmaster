import { strFromU8, unzipSync } from 'fflate';

// Rozbor projektu z Bambu Studia (.3mf / .gcode.3mf). Rozbaluje se jen Metadata/*.config
// a náhledy podložek — model (3D/…) umí mít rozbalený stovky MB.

export class ThreeMfError extends Error {}

const CONFIGS = ['Metadata/model_settings.config', 'Metadata/slice_info.config', 'Metadata/project_settings.config'];
const PLATE_PNG = /^Metadata\/plate_\d+\.png$/;
const MAX_ENTRY = 64 * 1024 * 1024; // ochrana proti „zip bombě“ v metadatech

function unzip(buffer, wanted) {
  try {
    return unzipSync(buffer, { filter: f => wanted(f.name) && f.originalSize <= MAX_ENTRY });
  } catch {
    throw new ThreeMfError('Soubor není platný 3MF (ZIP)');
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ENTITIES[e] ?? m);

function attrs(tag) {
  const out = {};
  for (const [, k, v] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[k] = decode(v);
  return out;
}

// <metadata key=".." value=".."/> přímo v daném úseku XML → { key: value }
function metadata(xml) {
  const out = {};
  for (const [, a] of xml.matchAll(/<metadata\b([^>]*?)\/?>/g)) {
    const { key, value } = attrs(a);
    if (key !== undefined) out[key] = value ?? '';
  }
  return out;
}

const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g'))]
  .map(([, a, body]) => ({ attrs: attrs(a), body }));

export function normColor(c) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c ?? '').trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

const num = v => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = v => (v == null ? null : Math.round(v * 100) / 100);

// Filamenty projektu: paralelní pole v project_settings, index i = filament id i + 1.
function projectFilaments(json) {
  let s;
  try { s = JSON.parse(json); } catch { return []; }
  const arr = k => (Array.isArray(s?.[k]) ? s[k] : []);
  const n = Math.max(arr('filament_colour').length, arr('filament_type').length);
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    type: arr('filament_type')[i] ?? null,
    color: normColor(arr('filament_colour')[i]),
    vendor: arr('filament_vendor')[i] ?? null,
    settings_id: arr('filament_settings_id')[i] ?? null,
    filament_id: arr('filament_ids')[i] ?? null,
  }));
}

// Objekt → množina extruderů (filament id) jeho běžných dílů; díl bez vlastního dědí z objektu.
function objectExtruders(xml) {
  const map = new Map();
  for (const obj of blocks(xml, 'object')) {
    const own = metadata(obj.body.replace(/<part\b[\s\S]*?<\/part>/g, ''));
    const base = Number(own.extruder) || 1;
    const set = new Set();
    for (const part of blocks(obj.body, 'part')) {
      if (part.attrs.subtype && part.attrs.subtype !== 'normal_part') continue;
      set.add(Number(metadata(part.body).extruder) || base);
    }
    if (!set.size) set.add(base);
    map.set(obj.attrs.id, set);
  }
  return map;
}

function modelPlates(xml) {
  const extruders = objectExtruders(xml);
  return blocks(xml, 'plate').map(({ body }) => {
    const meta = metadata(body.replace(/<model_instance\b[\s\S]*?<\/model_instance>/g, ''));
    const ids = new Set();
    for (const inst of blocks(body, 'model_instance')) {
      for (const id of extruders.get(metadata(inst.body).object_id) ?? []) ids.add(id);
    }
    return {
      index: Number(meta.plater_id),
      name: meta.plater_name ?? '',
      thumbnail_file: meta.thumbnail_file || null,
      filament_ids: [...ids].sort((a, b) => a - b),
    };
  }).filter(p => Number.isInteger(p.index) && p.index > 0);
}

function slicedPlates(xml) {
  return blocks(xml, 'plate').map(({ body }) => {
    const meta = metadata(body);
    const filaments = [...body.matchAll(/<filament\b([^>]*?)\/?>/g)].map(([, a]) => attrs(a)).map(f => ({
      id: Number(f.id),
      type: f.type || null,
      color: normColor(f.color),
      used_g: round2(num(f.used_g)),
    })).filter(f => Number.isInteger(f.id) && f.id > 0);
    const prediction = num(meta.prediction);
    return {
      index: Number(meta.index),
      thumbnail_file: meta.thumbnail_file || null,
      duration_min: prediction == null ? null : Math.round(prediction / 60),
      weight_g: round2(num(meta.weight)),
      filaments,
    };
  }).filter(p => Number.isInteger(p.index) && p.index > 0);
}

export function titleFromFilename(filename) {
  const base = String(filename ?? '').split(/[\\/]/).pop();
  return base.replace(/(\.gcode)?\.3mf$/i, '') || 'Projekt';
}

/**
 * → { meta, thumbs } — meta = { title, sliced, filaments, plates }, thumbs = Map(index → PNG).
 * Naslicovaná data (slice_info) mají přednost, název a náhled podložky se doplní z model_settings.
 * Projekt (.3mf) ukáže všechny podložky, .gcode.3mf jen ty naslicované. Podložka má navíc `sliced`.
 */
export function parse3mf(buffer, filename) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = unzip(bytes, name => CONFIGS.includes(name) || PLATE_PNG.test(name));
  const text = name => (files[name] ? strFromU8(files[name]) : null);

  const model = text('Metadata/model_settings.config');
  const mPlates = model ? modelPlates(model) : [];
  const sPlates = slicedPlates(text('Metadata/slice_info.config') ?? '');
  if (!mPlates.length && !sPlates.length) throw new ThreeMfError('Není to projekt Bambu Studia');

  let filaments = projectFilaments(text('Metadata/project_settings.config') ?? '');
  const byId = new Map(filaments.map(f => [f.id, f]));
  // Bez project_settings aspoň filamenty ze slicování.
  for (const f of sPlates.flatMap(p => p.filaments)) {
    if (!byId.has(f.id)) {
      const pf = { id: f.id, type: f.type, color: f.color, vendor: null, settings_id: null, filament_id: null };
      byId.set(f.id, pf);
      filaments.push(pf);
    }
  }
  filaments = filaments.sort((a, b) => a.id - b.id);

  const isGcode = /\.gcode\.3mf$/i.test(String(filename ?? ''));
  const indexes = new Set(sPlates.map(p => p.index));
  if (!isGcode || !indexes.size) for (const p of mPlates) indexes.add(p.index);

  const thumbs = new Map();
  const plates = [...indexes].sort((a, b) => a - b).map(index => {
    const m = mPlates.find(p => p.index === index);
    const s = sPlates.find(p => p.index === index);
    const pf = id => byId.get(id) ?? {};
    const plateFilaments = s
      ? s.filaments.map(f => ({ id: f.id, type: f.type ?? pf(f.id).type ?? null, color: f.color ?? pf(f.id).color ?? null,
          vendor: pf(f.id).vendor ?? null, settings_id: pf(f.id).settings_id ?? null, used_g: f.used_g }))
      : (m?.filament_ids ?? []).map(id => ({ id, type: pf(id).type ?? null, color: pf(id).color ?? null,
          vendor: pf(id).vendor ?? null, settings_id: pf(id).settings_id ?? null, used_g: null }));

    const thumbName = [m?.thumbnail_file, s?.thumbnail_file, `Metadata/plate_${index}.png`].find(n => n && files[n]);
    if (thumbName) thumbs.set(index, files[thumbName]);
    return {
      index,
      name: m?.name ?? '',
      has_thumb: Boolean(thumbName),
      sliced: Boolean(s),
      duration_min: s?.duration_min ?? null,
      weight_g: s?.weight_g ?? null,
      filaments: plateFilaments,
    };
  });

  // Náhled s nestandardní cestou (thumbnail_file mimo plate_N.png) se dotáhne druhým průchodem.
  const missing = plates.filter(p => !p.has_thumb)
    .map(p => [p.index, mPlates.find(m => m.index === p.index)?.thumbnail_file ?? sPlates.find(s => s.index === p.index)?.thumbnail_file])
    .filter(([, name]) => name && /\.png$/i.test(name));
  if (missing.length) {
    const extra = unzip(bytes, name => missing.some(([, n]) => n === name));
    for (const [index, name] of missing) {
      if (!extra[name]) continue;
      thumbs.set(index, extra[name]);
      plates.find(p => p.index === index).has_thumb = true;
    }
  }

  return {
    meta: { title: titleFromFilename(filename), sliced: plates.every(p => p.sliced), filaments, plates },
    thumbs,
  };
}
