const LOW_THRESHOLD = 150;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { spools: [], allSpools: [], prints: [], tab: 'inventory' };

// --- Pomocné ---

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Chyba ${res.status}`);
  return data;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtG = g => {
  const v = Math.round(g * 10) / 10;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} kg` : `${v.toLocaleString('cs-CZ')} g`;
};
const fmtDate = d => new Date(d.length <= 10 ? d + 'T00:00' : d.replace(' ', 'T') + 'Z')
  .toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
const today = () => new Date().toLocaleDateString('sv-SE');
const spoolLabel = s => [s.brand, s.material, s.color_name].filter(Boolean).join(' · ');
const pct = s => Math.max(0, Math.min(100, (s.remaining / s.initial_weight) * 100 || 0));

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// Zavření dialogu kliknutím mimo obsah
for (const d of $$('dialog')) {
  d.addEventListener('click', e => {
    const r = d.getBoundingClientRect();
    const outside = e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    if (outside || e.target.closest('[data-close]')) d.close('cancel');
  });
}

// --- Načítání dat ---

async function loadSpools() {
  const archived = $('#show-archived').checked ? 1 : 0;
  const [visible, active] = await Promise.all([
    api(`/spools?archived=${archived}`),
    archived ? api('/spools?archived=0') : null,
  ]);
  state.spools = visible;
  state.allSpools = active ?? visible;
  fillFilters();
  renderSpools();
}

async function loadPrints() {
  state.prints = await api('/prints');
  renderPrints();
}

async function loadStats() {
  const s = await api('/stats');
  $('#stats').innerHTML = `
    <div class="stat"><div class="label">Aktivních cívek</div><div class="value num">${s.spoolCount}</div></div>
    <div class="stat"><div class="label">Filamentu skladem</div><div class="value num">${fmtG(s.totalRemaining)}</div></div>
    <div class="stat${s.lowCount ? ' warn' : ''}"><div class="label">Dochází (pod ${LOW_THRESHOLD} g)</div><div class="value num">${s.lowCount}</div></div>
    <div class="stat"><div class="label">Spotřeba tento měsíc · ${s.month.prints} ${s.month.prints === 1 ? 'tisk' : s.month.prints >= 2 && s.month.prints <= 4 ? 'tisky' : 'tisků'}</div><div class="value num">${fmtG(s.month.grams)}</div></div>`;
}

const refresh = () => Promise.all([loadSpools(), loadPrints(), loadStats()]);

// --- Inventář ---

function fillFilters() {
  const sel = $('#spool-material');
  const current = sel.value;
  const materials = [...new Set(state.spools.map(s => s.material))].sort();
  sel.innerHTML = '<option value="">Všechny materiály</option>' +
    materials.map(m => `<option${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('');
  const brands = [...new Set(state.allSpools.map(s => s.brand).filter(Boolean))].sort();
  $('#brand-list').innerHTML = brands.map(b => `<option>${esc(b)}</option>`).join('');
}

function renderSpools() {
  const q = $('#spool-search').value.trim().toLowerCase();
  const mat = $('#spool-material').value;
  const list = state.spools.filter(s =>
    (!mat || s.material === mat) &&
    (!q || [s.brand, s.material, s.color_name, s.location, s.notes].join(' ').toLowerCase().includes(q)));

  const grid = $('#spool-grid');
  if (!state.spools.length) {
    grid.innerHTML = $('#show-archived').checked
      ? '<div class="empty-state">Archiv je prázdný.</div>'
      : `<div class="empty-state">Zatím tu nejsou žádné cívky.<br><button class="btn primary" data-new-spool>+ Přidat první cívku</button></div>`;
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty-state">Nic neodpovídá filtru.</div>'; return; }

  grid.innerHTML = list.map(s => {
    const low = s.remaining < LOW_THRESHOLD;
    const empty = s.remaining <= 0;
    return `
      <button class="spool${low ? ' low' : ''}${empty ? ' empty' : ''}" data-spool="${s.id}" style="--spool:${esc(s.color_hex)}">
        <div class="reel" style="--p:${pct(s)}"></div>
        <div class="meta">
          <div class="title">${esc(s.color_name || 'Bez názvu')}</div>
          <div class="sub"><span class="tag">${esc(s.material)}</span> ${esc(s.brand)}${s.location ? ' · ' + esc(s.location) : ''}</div>
          <div class="weight num">${fmtG(s.remaining)} <small>z ${fmtG(s.initial_weight)}</small>
            ${empty ? '<span class="tag warn">prázdná</span>' : low ? '<span class="tag warn">dochází</span>' : ''}</div>
        </div>
      </button>`;
  }).join('');
}

$('#spool-search').addEventListener('input', renderSpools);
$('#spool-material').addEventListener('change', renderSpools);
$('#show-archived').addEventListener('change', loadSpools);
$('#new-spool').addEventListener('click', () => openSpoolForm());
$('#spool-grid').addEventListener('click', e => {
  if (e.target.closest('[data-new-spool]')) return openSpoolForm();
  const card = e.target.closest('[data-spool]');
  if (card) openDetail(Number(card.dataset.spool));
});

// --- Formulář cívky ---

const spoolDialog = $('#spool-dialog');
const spoolForm = $('#spool-form');
let editingSpool = null;

function openSpoolForm(spool = null) {
  editingSpool = spool;
  spoolForm.reset();
  $('[data-title]', spoolForm).textContent = spool ? 'Upravit cívku' : 'Nová cívka';
  $$('[data-edit-only]', spoolForm).forEach(el => el.hidden = !spool);
  if (spool) {
    for (const el of spoolForm.elements) {
      if (el.name && el.name in spool) el.value = spool[el.name] ?? '';
    }
    $('[data-action="archive"]', spoolForm).textContent = spool.archived ? 'Obnovit z archivu' : 'Archivovat';
  }
  spoolDialog.showModal();
}

spoolDialog.addEventListener('close', async () => {
  if (spoolDialog.returnValue !== 'save') return;
  const body = Object.fromEntries(new FormData(spoolForm));
  try {
    if (editingSpool) await api(`/spools/${editingSpool.id}`, { method: 'PUT', body });
    else await api('/spools', { method: 'POST', body });
    toast(editingSpool ? 'Cívka upravena' : 'Cívka přidána');
    await refresh();
  } catch (err) { toast(err.message, true); spoolDialog.showModal(); }
});

$('[data-action="archive"]', spoolForm).addEventListener('click', async () => {
  try {
    await api(`/spools/${editingSpool.id}`, { method: 'PUT', body: { archived: !editingSpool.archived } });
    spoolDialog.close('done');
    toast(editingSpool.archived ? 'Cívka obnovena' : 'Cívka archivována');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('[data-action="delete"]', spoolForm).addEventListener('click', async () => {
  if (!confirm(`Opravdu smazat cívku „${spoolLabel(editingSpool)}“?`)) return;
  try {
    await api(`/spools/${editingSpool.id}`, { method: 'DELETE' });
    spoolDialog.close('done');
    toast('Cívka smazána');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

// --- Detail cívky ---

const detailDialog = $('#detail-dialog');
let detailSpool = null;

async function openDetail(id) {
  try { detailSpool = await api(`/spools/${id}`); }
  catch (err) { return toast(err.message, true); }
  const s = detailSpool;
  const props = [
    ['Průměr', `${s.diameter} mm`],
    ['Prázdná cívka', s.spool_weight != null ? fmtG(s.spool_weight) : '—'],
    ['Cena', s.price != null ? `${s.price.toLocaleString('cs-CZ')} Kč` : '—'],
    ['Spotřebováno', fmtG(s.used)],
    ['Korekce', fmtG(s.adjusted)],
    ['Umístění', s.location || '—'],
  ];
  if (s.price != null && s.initial_weight) props[2][1] += ` <small>(${(s.price / s.initial_weight * 1000).toFixed(0)} Kč/kg)</small>`;

  $('#detail-body').innerHTML = `
    <div class="detail-head" style="--spool:${esc(s.color_hex)}">
      <div class="reel big" style="--p:${pct(s)}"></div>
      <div>
        <h2>${esc(s.color_name || 'Bez názvu')}</h2>
        <div class="hint"><span class="tag">${esc(s.material)}</span> ${esc(s.brand)}${s.archived ? ' · <span class="tag">archiv</span>' : ''}</div>
        <div class="big-num num">${fmtG(s.remaining)} <span class="hint">z ${fmtG(s.initial_weight)} · ${Math.round(pct(s))} %</span></div>
      </div>
    </div>
    <div class="detail-props">${props.map(([k, v]) => `<div><span>${k}</span>${esc(v).replace(/&lt;(\/?)small&gt;/g, '<$1small>')}</div>`).join('')}</div>
    ${s.notes ? `<p class="hint" style="margin-bottom:14px">${esc(s.notes)}</p>` : ''}
    <h3 class="hint" style="margin:0 0 6px">Historie</h3>
    <ul class="history">${s.history.length ? s.history.map(h => `
      <li><div>${h.kind === 'print' ? esc(h.label) : `<i>${esc(h.label || 'Korekce')}</i>`}<div class="when">${fmtDate(h.at)}</div></div>
      <span class="delta num${h.delta > 0 ? ' pos' : ''}">${h.delta > 0 ? '+' : ''}${fmtG(h.delta)}</span></li>`).join('')
      : '<li class="hint">Zatím žádné tisky.</li>'}</ul>
    <div class="dialog-actions">
      <button class="btn" data-act="edit">Upravit</button>
      <button class="btn" data-act="adjust">Převážit</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="close">Zavřít</button>
      <button class="btn primary" data-act="print">+ Tisk z této cívky</button>
    </div>`;
  if (!detailDialog.open) detailDialog.showModal();
}

detailDialog.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  detailDialog.close();
  if (act === 'edit') openSpoolForm(detailSpool);
  if (act === 'adjust') openAdjust(detailSpool);
  if (act === 'print') openPrintForm(null, detailSpool.id);
});

// --- Převážení ---

const adjustDialog = $('#adjust-dialog');
const adjustForm = $('#adjust-form');
let adjustSpool = null;

function openAdjust(spool) {
  adjustSpool = spool;
  adjustForm.reset();
  const hasTare = spool.spool_weight != null;
  $('input[value="gross"]', adjustForm).disabled = !hasTare;
  $(`input[value="${hasTare ? 'gross' : 'remaining'}"]`, adjustForm).checked = true;
  $('[data-hint]', adjustForm).textContent = hasTare
    ? `Položte cívku na váhu. Odečte se ${fmtG(spool.spool_weight)} za prázdnou cívku. Aktuálně evidováno ${fmtG(spool.remaining)}.`
    : `Aktuálně evidováno ${fmtG(spool.remaining)}. Pro vážení i s cívkou vyplňte v úpravě hmotnost prázdné cívky.`;
  adjustDialog.showModal();
}

adjustDialog.addEventListener('close', async () => {
  if (adjustDialog.returnValue !== 'save') return;
  const fd = new FormData(adjustForm);
  try {
    const updated = await api(`/spools/${adjustSpool.id}/adjust`, { method: 'POST', body: { [fd.get('mode')]: fd.get('value') } });
    toast(`Zůstatek: ${fmtG(updated.remaining)}`);
    await refresh();
    openDetail(adjustSpool.id);
  } catch (err) { toast(err.message, true); }
});

// --- Tisky ---

function renderPrints() {
  const q = $('#print-search').value.trim().toLowerCase();
  const list = state.prints.filter(p => !q || (p.name + ' ' + p.notes).toLowerCase().includes(q));
  const el = $('#print-list');
  if (!state.prints.length) {
    el.innerHTML = '<div class="empty-state">Zatím žádné tisky. Po dotisku klikněte na <b>+ Nový tisk</b> a gramáž se odečte z cívky.</div>';
    return;
  }
  if (!list.length) { el.innerHTML = '<div class="empty-state">Nic neodpovídá hledání.</div>'; return; }
  el.innerHTML = list.map(p => {
    const total = p.usages.reduce((a, u) => a + u.grams, 0);
    return `
      <button class="print" data-print="${p.id}">
        <div><span class="name">${esc(p.name)}</span> ${p.status === 'failed' ? '<span class="tag failed">nepovedený</span>' : ''}
          <span class="date">· ${fmtDate(p.printed_at)}</span></div>
        <div class="grams num">${fmtG(total)}</div>
        <div class="chips">${p.usages.map(u => `
          <span class="chip"><span class="dot" style="--c:${esc(u.color_hex)}"></span>${esc(u.color_name || u.material)} <span class="hint">${fmtG(u.grams)}</span></span>`).join('')}</div>
      </button>`;
  }).join('');
}

$('#print-search').addEventListener('input', renderPrints);
$('#print-list').addEventListener('click', e => {
  const row = e.target.closest('[data-print]');
  if (row) openPrintForm(state.prints.find(p => p.id === Number(row.dataset.print)));
});
$('#new-print').addEventListener('click', () => openPrintForm());

// --- Formulář tisku ---

const printDialog = $('#print-dialog');
const printForm = $('#print-form');
let editingPrint = null;

function spoolOptions(selectedId) {
  // V editaci tisku musí být k dispozici i cívka, která mezitím šla do archivu.
  const list = [...state.allSpools];
  if (selectedId && !list.some(s => s.id === selectedId)) {
    const u = editingPrint?.usages.find(u => u.spool_id === selectedId);
    if (u) list.push({ id: selectedId, ...u, remaining: NaN });
  }
  return '<option value="">— vyberte cívku —</option>' + list.map(s =>
    `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>${esc(spoolLabel(s))}${Number.isFinite(s.remaining) ? ` (${fmtG(s.remaining)})` : ''}</option>`).join('');
}

function addUsageRow(spoolId = null, grams = '') {
  const row = document.createElement('div');
  row.className = 'usage-row';
  row.innerHTML = `
    <select name="spool_id" required>${spoolOptions(spoolId)}</select>
    <div class="grams-input"><input name="grams" type="number" step="0.1" min="0.1" required placeholder="0" value="${grams}"></div>
    <button type="button" class="icon-btn" title="Odebrat" aria-label="Odebrat">×</button>
    <div class="after"></div>`;
  $('#usage-rows').append(row);
  updateUsageInfo();
  return row;
}

function updateUsageInfo() {
  const rows = $$('.usage-row', printForm);
  let total = 0;
  for (const row of rows) {
    $('.icon-btn', row).hidden = rows.length === 1;
    const id = Number($('select', row).value);
    const grams = Number($('input', row).value) || 0;
    total += grams;
    const spool = state.allSpools.find(s => s.id === id);
    const after = $('.after', row);
    if (!spool) { after.textContent = ''; continue; }
    // Při editaci se původní spotřeba tohoto tisku už v zůstatku projevila — vrátíme ji zpět.
    const original = editingPrint?.usages.filter(u => u.spool_id === id).reduce((a, u) => a + u.grams, 0) ?? 0;
    const sameSpoolOther = rows.filter(r => r !== row && Number($('select', r).value) === id)
      .reduce((a, r) => a + (Number($('input', r).value) || 0), 0);
    const left = spool.remaining + original - grams - sameSpoolOther;
    after.textContent = `Po tisku zbude ${fmtG(left)}`;
    after.classList.toggle('neg', left < 0);
  }
  $('#usage-total').textContent = rows.length > 1 ? `Celkem ${fmtG(total)}` : '';
}

$('#usage-rows').addEventListener('input', updateUsageInfo);
$('#usage-rows').addEventListener('click', e => {
  if (e.target.closest('.icon-btn')) { e.target.closest('.usage-row').remove(); updateUsageInfo(); }
});
$('#add-usage').addEventListener('click', () => $('select', addUsageRow()).focus());

function openPrintForm(print = null, presetSpoolId = null) {
  if (!state.allSpools.length) {
    toast('Nejdřív přidejte alespoň jednu cívku', true);
    return openSpoolForm();
  }
  editingPrint = print;
  printForm.reset();
  $('#usage-rows').innerHTML = '';
  $('[data-title]', printForm).textContent = print ? 'Upravit tisk' : 'Nový tisk';
  $$('[data-edit-only]', printForm).forEach(el => el.hidden = !print);
  $('button[value="save"]', printForm).textContent = print ? 'Uložit' : 'Uložit a odečíst';
  printForm.elements.name.value = print?.name ?? '';
  printForm.elements.printed_at.value = print?.printed_at ?? today();
  printForm.elements.status.value = print?.status ?? 'ok';
  printForm.elements.notes.value = print?.notes ?? '';
  if (print) print.usages.forEach(u => addUsageRow(u.spool_id, u.grams));
  else addUsageRow(presetSpoolId ?? (state.allSpools.length === 1 ? state.allSpools[0].id : null));
  printDialog.showModal();
}

printDialog.addEventListener('close', async () => {
  if (printDialog.returnValue !== 'save') return;
  const body = {
    name: printForm.elements.name.value,
    printed_at: printForm.elements.printed_at.value,
    status: printForm.elements.status.value,
    notes: printForm.elements.notes.value,
    usages: $$('.usage-row', printForm).map(r => ({ spool_id: $('select', r).value, grams: $('input', r).value })),
  };
  try {
    if (editingPrint) await api(`/prints/${editingPrint.id}`, { method: 'PUT', body });
    else await api('/prints', { method: 'POST', body });
    const total = body.usages.reduce((a, u) => a + Number(u.grams), 0);
    toast(editingPrint ? 'Tisk upraven' : `Odečteno ${fmtG(total)}`);
    await refresh();
  } catch (err) { toast(err.message, true); printDialog.showModal(); }
});

$('[data-action="delete"]', printForm).addEventListener('click', async () => {
  if (!confirm(`Smazat tisk „${editingPrint.name}“? Gramáž se vrátí na cívky.`)) return;
  try {
    await api(`/prints/${editingPrint.id}`, { method: 'DELETE' });
    printDialog.close('done');
    toast('Tisk smazán, gramáž vrácena');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

// --- Záložky ---

function setTab(tab) {
  state.tab = tab;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#tab-inventory').hidden = tab !== 'inventory';
  $('#tab-prints').hidden = tab !== 'prints';
  history.replaceState(null, '', `#${tab}`);
}
$('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
const tabFromHash = () => setTab(location.hash === '#prints' ? 'prints' : 'inventory');
addEventListener('hashchange', tabFromHash);
tabFromHash();

refresh().catch(err => toast(err.message, true));
