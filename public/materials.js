// Katalog materiálů. Cívka má jen textový `material` (konkrétní varianta, např. „PLA-Matte“);
// druh se z názvu odvozuje, takže vlastní varianty nepotřebují v DB nic dalšího.
export const OTHER = 'Jiný';
export const FAMILIES = [
  { name: 'PLA', common: true, variants: ['PLA', 'PLA+', 'PLA-Matte', 'PLA-Silk', 'PLA-Silk+', 'PLA-Marble', 'PLA-Metal', 'PLA-Sparkle', 'PLA-Galaxy', 'PLA-Glow', 'PLA-Translucent', 'PLA-Tough', 'PLA-Tough+', 'PLA-Wood', 'PLA-CF', 'PLA-Aero'] },
  { name: 'PETG', common: true, variants: ['PETG', 'PETG-HF', 'PETG-Translucent', 'PETG-CF', 'PETG-GF'] },
  { name: 'ABS', common: true, variants: ['ABS', 'ABS-GF'] },
  { name: 'ASA', common: true, variants: ['ASA', 'ASA-Aero', 'ASA-CF'] },
  { name: 'TPU', common: true, variants: ['TPU', 'TPU 95A', 'TPU 90A', 'TPU-AMS'] },
  { name: 'PA', common: true, variants: ['PA', 'PA6-CF', 'PA6-GF', 'PA12-CF', 'PAHT-CF'] },
  { name: 'PC', common: true, variants: ['PC', 'PC-CF', 'PC-FR'] },
  { name: 'Support', common: true, variants: ['Support W', 'Support G', 'PLA-S', 'PA-S', 'ABS-S', 'PVA'] },
  { name: 'PC-ABS', variants: ['PC-ABS'] },
  { name: 'PET', variants: ['PET', 'PET-CF'] },
  { name: 'PPA', variants: ['PPA-CF', 'PPA-GF'] },
  { name: 'PPS', variants: ['PPS', 'PPS-CF'] },
  { name: 'PP', variants: ['PP', 'PP-CF', 'PP-GF'] },
  { name: 'PEI', variants: ['PEI'] },
  { name: 'HIPS', variants: ['HIPS'] },
  { name: 'PVB', variants: ['PVB'] },
  { name: OTHER, variants: [] },
];

// Porovnává se bez velikosti písmen a pomlček; „PLA Basic“ je obyčejné PLA.
const norm = m => String(m ?? '').trim().toUpperCase().replace(/[-_\s]+/g, ' ').replace(/ BASIC\b/, '');
const contains = (text, part) => ` ${text} `.includes(` ${part} `);

const CATALOG = new Map(FAMILIES.flatMap(f => f.variants.map(v => [norm(v), { name: v, family: f.name }])));
const VARIANTS = [...CATALOG.keys()].sort((a, b) => b.length - a.length);
const FAMILY_NAMES = FAMILIES.map(f => f.name).filter(n => n !== OTHER).sort((a, b) => b.length - a.length);

export function familyOf(material) {
  const n = norm(material);
  return CATALOG.get(n)?.family ?? FAMILY_NAMES.find(f => contains(n, norm(f))) ?? OTHER;
}

const isPlain = m => norm(m) === norm(familyOf(m));

// Vlastní varianta se pojmenuje stejně jako katalog: „Shore 70“ v TPU = „TPU-Shore 70“.
export function customName(family, text) {
  const name = text.trim();
  return !name || family === OTHER || familyOf(name) === family ? name : `${family}-${name}`;
}

// Bambu Studio píše do filament_type jen „PLA“; variantu prozradí profil („Bambu PLA Matte @BBL X1C“).
export function filamentMaterial(fil) {
  const profile = norm(String(fil.settings_id ?? '').split('@')[0]);
  const hit = VARIANTS.find(v => contains(profile, v));
  if (!hit || (fil.type && isPlain(hit))) return fil.type ?? '';
  return CATALOG.get(hit).name;
}

// Výztuž a podpory mění vlastnosti materiálu, proto PLA-CF nebo PLA-S nejsou náhradou za PLA.
function materialClass(m) {
  const family = familyOf(m), n = norm(m);
  if (family === OTHER || family === 'Support') return n;
  return [norm(family), n.match(/\b(CF|GF|S|AERO)\b/)?.[0]].filter(Boolean).join(' ');
}

// 3 = stejná varianta, 2 = jedna strana variantu neuvádí (PLA × PLA-Matte), 1 = jiná varianta téhož
// materiálu (PLA-Silk × PLA-Matte, ukáže se upozornění), 0 = jiný materiál.
export function materialMatch(a, b) {
  if (norm(a) && norm(a) === norm(b)) return 3;
  if (!norm(a) || materialClass(a) !== materialClass(b)) return 0;
  return isPlain(a) || isPlain(b) ? 2 : 1;
}
