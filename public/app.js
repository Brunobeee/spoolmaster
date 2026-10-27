const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { spools: [], allSpools: [], prints: [], planned: [], projects: [], settings: {}, rates: {}, groups: [], tab: 'inventory' };

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
const fmtKc = v => `${Math.round(v).toLocaleString('cs-CZ')} Kč`;
// Ceny z API jsou v USD (hlavní měna); koruny jen orientačně podle aktuálního kurzu ČNB.
const fmtUsd = v => `$${v.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdToCzk = v => v * (state.rates.USD ?? 0);
const czkHint = v => state.rates.USD ? `≈ ${fmtKc(usdToCzk(v))}` : '';
const CURRENCY_FMT = {
  USD: v => fmtUsd(v),
  EUR: v => `€${v.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  CZK: v => `${v.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} Kč`,
};
const fmtPrice = (v, currency) => (CURRENCY_FMT[currency] ?? CURRENCY_FMT.USD)(v);
// Kč za jednotku měny; koruny 1:1
const czkPerUnit = currency => currency === 'CZK' ? 1 : state.rates[currency];
const fmtDur = min => {
  const t = Math.round(min);
  const h = Math.floor(t / 60), m = t % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
// null = cena některé cívky neznámá; nikdy ji neukazujeme jako 0 Kč
const costText = (filament, energy) => filament == null ? 'cena neznámá' : fmtUsd(filament) + (energy ? ` + ${fmtUsd(energy)} el.` : '');
const plural = (n, one, few, many) => n === 1 ? one : n >= 2 && n <= 4 ? few : many;
const round1 = v => Math.round(v * 10) / 10;
const today = () => new Date().toLocaleDateString('sv-SE');
const spoolLabel = s => [s.brand, s.material, s.color_name].filter(Boolean).join(' · ');
const pct = s => Math.max(0, Math.min(100, (s.remaining / s.initial_weight) * 100 || 0));
const printGrams = p => p.grams ?? p.usages.reduce((a, u) => a + u.grams, 0);
const usageChip = (u, warn = false) => `
  <span class="chip${warn ? ' warn' : ''}"><span class="dot" style="--c:${esc(u.color_hex)}"></span>${esc(u.color_name || u.material)} <span class="hint">${fmtG(u.grams)}</span></span>`;
const statusTag = p => p.status === 'planned' ? '<span class="tag">naplánováno</span>'
  : p.status === 'failed' ? `<span class="tag failed">nepovedený · ${Math.round(p.percent ?? 0)} %</span>` : '';
const projectTag = p => p.project_name ? `<span class="tag project-tag">${esc(p.project_name)}</span>` : '';

// Bublina je popover, takže je v top layer nad modálními dialogy (z-index na ně nestačí).
// Při každém zobrazení se znovu otevře, aby skončila nad naposledy otevřeným dialogem.
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  if (el.matches(':popover-open')) el.hidePopover();
  el.showPopover();
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastTimer = setTimeout(() => el.hidePopover(), 200);
  }, 2800);
}

// Dialog otevřený až po bublině (např. znovu po chybě uložení) by ji jinak překryl.
new MutationObserver(() => {
  const el = $('#toast');
  if (el.matches(':popover-open')) { el.hidePopover(); el.showPopover(); }
}).observe(document.body, { subtree: true, attributeFilter: ['open'] });

// Desetinná čárka: číselná pole jsou textová s inputmode="decimal" (type=number se v Safari
// a některých lokalizacích s čárkou neshodne), takže čárku při psaní převedeme na tečku.
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.matches?.('input[inputmode="decimal"]') || !el.value.includes(',')) return;
  const pos = el.selectionStart;
  el.value = el.value.replace(/,/g, '.');
  el.setSelectionRange(pos, pos);
}, true);

for (const d of $$('dialog')) {
  // Zavření dialogu kliknutím mimo obsah
  d.addEventListener('click', e => {
    const r = d.getBoundingClientRect();
    const outside = e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    if (outside || e.target.closest('[data-close]')) d.close('cancel');
  });
  // Escape nemění returnValue — bez tohohle by po dřívějším uložení Escape uložil znovu.
  d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
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
  const all = await api('/prints');
  state.prints = all.filter(p => p.status !== 'planned');
  state.planned = all.filter(p => p.status === 'planned')
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id - b.id);
  renderPrints();
}

async function loadProjects() {
  state.projects = await api('/projects?status=all');
  renderProjects();
}

async function loadStats() {
  const s = await api('/stats');
  const m = s.month;
  $('#stats').innerHTML = `
    <div class="stat"><div class="label">Aktivních cívek</div><div class="value num">${s.spoolCount}</div></div>
    <div class="stat"><div class="label">Filamentu skladem</div><div class="value num">${fmtG(s.totalRemaining)}</div></div>
    <div class="stat${s.lowCount ? ' warn' : ''}"><div class="label">Dochází (pod ${state.settings.low_threshold} g)</div><div class="value num">${s.lowCount}</div></div>
    <div class="stat"><div class="label">Spotřeba tento měsíc · ${m.prints} ${plural(m.prints, 'tisk', 'tisky', 'tisků')}</div>
      <div class="value num">${fmtG(m.grams)}${m.cost > 0 ? ` <small>${fmtUsd(m.cost)}</small>` : ''}</div></div>`;
}

async function loadSettings() {
  [state.settings, state.rates] = await Promise.all([api('/settings'), api('/rates')]);
}

// Naplánované vykreslujeme až po načtení cívek (varování „nestačí“ potřebuje zůstatky).
const refresh = async () => {
  await Promise.all([loadSpools(), loadPrints(), loadStats(), loadProjects()]);
  renderPlanned();
};

// --- Naplánováno ---

function renderPlanned() {
  const el = $('#planned');
  el.hidden = !state.planned.length;
  if (!state.planned.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <h2 class="section-title">Naplánováno <span class="tag">${state.planned.length}</span></h2>
    <div class="planned-list">${state.planned.map(p => {
      const meta = [
        p.duration_min != null ? `≈ ${fmtDur(p.duration_min)}` : null,
        p.filament_cost == null ? 'cena neznámá' : `≈ ${costText(p.filament_cost, p.energy_cost)}`,
      ].filter(Boolean).join(' · ');
      const chips = p.usages.map(u => {
        const s = state.allSpools.find(s => s.id === u.spool_id);
        return usageChip(u, s && (s.reserved ?? 0) > s.remaining);
      }).join('');
      return `
        <article class="planned-item" data-print="${p.id}">
          <div class="planned-info">
            <div><button type="button" class="planned-name">${esc(p.name)}</button> ${projectTag(p)}</div>
            <div class="chips">${chips}</div>
            <div class="planned-meta num">${meta}</div>
          </div>
          <div class="planned-actions">
            <button type="button" class="btn ok" data-done>Hotovo</button>
            <button type="button" class="btn danger" data-fail>Selhalo</button>
          </div>
        </article>`;
    }).join('')}</div>`;
}

$('#planned').addEventListener('click', async e => {
  const item = e.target.closest('[data-print]');
  if (!item) return;
  const print = state.planned.find(p => p.id === Number(item.dataset.print));
  if (!print) return;
  if (e.target.closest('[data-fail]')) return openFail(print);
  const done = e.target.closest('[data-done]');
  if (!done) return openPrintForm(print);
  done.disabled = true;
  try {
    const p = await api(`/prints/${print.id}/complete`, { method: 'POST', body: { status: 'ok' } });
    toast(`Hotovo · odečteno ${fmtG(printGrams(p))}`);
    await refresh();
  } catch (err) { toast(err.message, true); done.disabled = false; }
});

// --- Selhalo ---

const failDialog = $('#fail-dialog');
const failForm = $('#fail-form');
let failPrint = null;

function openFail(print) {
  failPrint = print;
  failForm.reset();
  $('[data-name]', failForm).textContent = print.name;
  failForm.elements.printed_at.value = today();
  $('#fail-rows').innerHTML = print.usages.map(u => `
    <div class="fail-row">
      <span class="chip"><span class="dot" style="--c:${esc(u.color_hex)}"></span>${esc(u.color_name || u.material)}</span>
      <span class="hint num">z ${fmtG(u.grams)}</span>
      <div class="unit-input" data-unit="g"><input type="text" inputmode="decimal" pattern="\\d*[.,]?\\d*" required
        data-spool="${u.spool_id}" data-planned="${u.grams}" aria-label="Gramy, ${esc(u.color_name || u.material)}"></div>
    </div>`).join('');
  setFailPercent(50);
  failDialog.showModal();
}

function setFailPercent(value, source) {
  if (source !== 'range') failForm.elements.percent_range.value = value;
  if (source !== 'number') failForm.elements.percent.value = value;
  const p = Math.max(0, Math.min(100, Number(value) || 0));
  for (const input of $$('#fail-rows input')) {
    if (!input.dataset.manual) input.value = round1(input.dataset.planned * p / 100);
  }
  updateFailTotal();
}

function updateFailTotal() {
  const inputs = $$('#fail-rows input');
  const total = inputs.reduce((a, i) => a + (Number(i.value) || 0), 0);
  const planned = inputs.reduce((a, i) => a + Number(i.dataset.planned), 0);
  $('#fail-total').textContent = `Odečte se ${fmtG(total)} z plánovaných ${fmtG(planned)}`;
}

failForm.addEventListener('input', e => {
  const t = e.target;
  if (t.name === 'percent_range') setFailPercent(t.value, 'range');
  else if (t.name === 'percent') setFailPercent(t.value, 'number');
  else if (t.dataset.planned) { t.dataset.manual = '1'; updateFailTotal(); }
});

failDialog.addEventListener('close', async () => {
  if (failDialog.returnValue !== 'save') return;
  const body = {
    status: 'failed',
    percent: Number(failForm.elements.percent.value),
    printed_at: failForm.elements.printed_at.value,
    // Řádky s 0 g vynecháme; prázdný seznam = tisk selhal hned na začátku.
    usages: $$('#fail-rows input')
      .map(i => ({ spool_id: Number(i.dataset.spool), grams: round1(Number(i.value) || 0) }))
      .filter(u => u.grams > 0),
  };
  try {
    const p = await api(`/prints/${failPrint.id}/complete`, { method: 'POST', body });
    toast(`Zapsáno jako nepovedený · odečteno ${fmtG(printGrams(p))}`);
    await refresh();
  } catch (err) { toast(err.message, true); failDialog.showModal(); }
});

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

const reservedLine = s => (s.reserved ?? 0) > 0
  ? `z toho ${fmtG(s.reserved)} naplánováno${s.reserved > s.remaining ? ' <span class="tag warn">nestačí</span>' : ''}` : '';

// Stejné cívky (značka, materiál, barva, průměr, hmotnost) se v inventáři slučují do skupiny;
// každá fyzická cívka ale zůstává samostatná, protože má vlastní zůstatek.
const groupKey = s => [s.brand, s.material, s.color_name, s.diameter, s.initial_weight]
  .map(v => String(v ?? '').trim().toLowerCase()).join('|');
const isOpened = s => s.used > 0 || s.adjusted !== 0;
// Napřed načaté od nejmenšího zůstatku (ta se právě dotiskává), pak neotevřené, prázdné až na konec.
const sortGroup = list => [...list].sort((a, b) =>
  (a.remaining <= 0) - (b.remaining <= 0) || isOpened(b) - isOpened(a) || a.remaining - b.remaining || a.id - b.id);

function spoolCard(s) {
  const low = s.remaining < state.settings.low_threshold;
  const empty = s.remaining <= 0;
  const reserved = reservedLine(s);
  return `
      <button class="spool${low ? ' low' : ''}${empty ? ' empty' : ''}" data-spool="${s.id}" style="--spool:${esc(s.color_hex)}">
        <div class="reel" style="--p:${pct(s)}"></div>
        <div class="meta">
          <div class="title">${esc(s.color_name || 'Bez názvu')}</div>
          <div class="sub"><span class="tag">${esc(s.material)}</span> ${esc(s.brand)}${s.location ? ' · ' + esc(s.location) : ''}</div>
          <div class="weight num">${fmtG(s.remaining)} <small>z ${fmtG(s.initial_weight)}</small>
            ${empty ? '<span class="tag warn">prázdná</span>' : low ? '<span class="tag warn">dochází</span>' : ''}</div>
          ${reserved ? `<div class="reserved num">${reserved}</div>` : ''}
        </div>
      </button>`;
}

function groupCard(list, index) {
  const [active] = list;
  const total = list.reduce((a, s) => a + Math.max(s.remaining, 0), 0);
  const reservedSum = list.reduce((a, s) => a + (s.reserved || 0), 0);
  const unopened = list.filter(s => !isOpened(s)).length;
  const empty = total <= 0;
  const low = total < state.settings.low_threshold;
  return `
      <button class="spool group${low ? ' low' : ''}${empty ? ' empty' : ''}" data-group="${index}" style="--spool:${esc(active.color_hex)}">
        <div class="reel" style="--p:${pct(active)}"></div>
        <div class="meta">
          <div class="title">${esc(active.color_name || 'Bez názvu')} <span class="tag count">×${list.length}</span></div>
          <div class="sub"><span class="tag">${esc(active.material)}</span> ${esc(active.brand)}</div>
          <div class="weight num">${fmtG(total)} <small>celkem${unopened ? ` · ${unopened} ${plural(unopened, 'neotevřená', 'neotevřené', 'neotevřených')}` : ''}</small>
            ${empty ? '<span class="tag warn">prázdné</span>' : low ? '<span class="tag warn">dochází</span>' : ''}</div>
          ${reservedSum > 0 ? `<div class="reserved num">z toho ${fmtG(reservedSum)} naplánováno</div>` : ''}
        </div>
      </button>`;
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
      ? '<div class="empty-state">Žádné archivované ani dotištěné cívky.</div>'
      : `<div class="empty-state">Zatím tu nejsou žádné cívky.<br><button class="btn primary" data-new-spool>+ Přidat první cívku</button></div>`;
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty-state">Nic neodpovídá filtru.</div>'; return; }

  state.groups = [...Map.groupBy(list, groupKey).values()].map(sortGroup);
  grid.innerHTML = state.groups.map((g, i) => g.length === 1 ? spoolCard(g[0]) : groupCard(g, i)).join('');
}

$('#spool-search').addEventListener('input', renderSpools);
$('#spool-material').addEventListener('change', renderSpools);
$('#show-archived').addEventListener('change', loadSpools);
$('#new-spool').addEventListener('click', () => openSpoolForm());
$('#spool-grid').addEventListener('click', e => {
  if (e.target.closest('[data-new-spool]')) return openSpoolForm();
  const group = e.target.closest('[data-group]');
  if (group) return openGroup(state.groups[Number(group.dataset.group)]);
  const card = e.target.closest('[data-spool]');
  if (card) openDetail(Number(card.dataset.spool));
});

// --- Skupina stejných cívek ---

const groupDialog = $('#group-dialog');
let openedGroup = null;

function openGroup(list) {
  openedGroup = list;
  const [first] = list;
  const total = list.reduce((a, s) => a + Math.max(s.remaining, 0), 0);
  $('#group-body').innerHTML = `
    <div class="detail-head" style="--spool:${esc(first.color_hex)}">
      <div class="reel big" style="--p:${pct(first)}"></div>
      <div>
        <h2>${esc(first.color_name || 'Bez názvu')} <span class="tag count">×${list.length}</span></h2>
        <div class="hint"><span class="tag">${esc(first.material)}</span> ${esc(first.brand)} · ${first.diameter} mm</div>
        <div class="big-num num">${fmtG(total)} <span class="hint">celkem</span></div>
      </div>
    </div>
    <div class="group-list">${list.map(s => {
      const tags = s.remaining <= 0 ? '<span class="tag warn">prázdná</span>'
        : !isOpened(s) ? '<span class="tag">neotevřená</span>'
        : s.remaining < state.settings.low_threshold ? '<span class="tag warn">dochází</span>' : '<span class="tag">načatá</span>';
      return `
      <button class="group-row" data-spool="${s.id}" style="--spool:${esc(s.color_hex)}">
        <div class="reel small" style="--p:${pct(s)}"></div>
        <div class="num"><b>${fmtG(s.remaining)}</b> <span class="hint">z ${fmtG(s.initial_weight)}</span></div>
        <div class="group-tags">${tags}${s.location ? ` <span class="hint">${esc(s.location)}</span>` : ''}</div>
      </button>`;
    }).join('')}</div>
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button class="btn ghost" data-close>Zavřít</button>
      <button class="btn primary" data-act="duplicate">+ Přidat stejnou</button>
    </div>`;
  groupDialog.showModal();
}

groupDialog.addEventListener('click', e => {
  const row = e.target.closest('[data-spool]');
  if (row) { groupDialog.close(); return openDetail(Number(row.dataset.spool)); }
  if (e.target.closest('[data-act="duplicate"]')) { groupDialog.close(); openDuplicate(openedGroup[0]); }
});

// --- Přidat stejnou cívku ---

const dupDialog = $('#dup-dialog');
const dupForm = $('#dup-form');
let dupSource = null;

function openDuplicate(spool) {
  dupSource = spool;
  dupForm.reset();
  $('[data-dup-label]', dupDialog).textContent = spoolLabel(spool);
  dupForm.elements.count.value = 1;
  dupForm.elements.price.value = spool.price ?? '';
  dupForm.elements.currency.value = spool.currency ?? 'USD';
  dupDialog.showModal();
}

dupDialog.addEventListener('close', async () => {
  if (dupDialog.returnValue !== 'save') return;
  try {
    const created = await api(`/spools/${dupSource.id}/duplicate`, { method: 'POST', body: Object.fromEntries(new FormData(dupForm)) });
    toast(`Přidáno: ${created.length} ${plural(created.length, 'cívka', 'cívky', 'cívek')}`);
    await refresh();
  } catch (err) { toast(err.message, true); dupDialog.showModal(); }
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
  } else {
    spoolForm.elements.spool_weight.value = state.settings.default_spool_weight ?? '';
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
    ['Cena', s.price != null ? fmtPrice(s.price, s.currency) : '—'],
    ['Spotřebováno', fmtG(s.used)],
    ['Korekce', fmtG(s.adjusted)],
    ['Umístění', s.location || '—'],
  ];
  if (s.price != null && s.initial_weight) {
    props[2][1] += ` <small>(${fmtPrice(s.price / s.initial_weight * 1000, s.currency)}/kg${s.currency !== 'USD' ? `, ≈ ${fmtUsd(s.price * czkPerUnit(s.currency) / state.rates.USD)}` : ''})</small>`;
  }
  const reserved = reservedLine(s);

  $('#detail-body').innerHTML = `
    <div class="detail-head" style="--spool:${esc(s.color_hex)}">
      <div class="reel big" style="--p:${pct(s)}"></div>
      <div>
        <h2>${esc(s.color_name || 'Bez názvu')}</h2>
        <div class="hint"><span class="tag">${esc(s.material)}</span> ${esc(s.brand)}${s.archived ? ' · <span class="tag">archiv</span>' : ''}</div>
        <div class="big-num num">${fmtG(s.remaining)} <span class="hint">z ${fmtG(s.initial_weight)} · ${Math.round(pct(s))} %</span></div>
        ${reserved ? `<div class="hint num">${reserved}</div>` : ''}
      </div>
    </div>
    <div class="detail-props">${props.map(([k, v]) => `<div><span>${k}</span>${esc(v).replace(/&lt;(\/?)small&gt;/g, '<$1small>')}</div>`).join('')}</div>
    ${s.notes ? `<p class="hint" style="margin-bottom:14px">${esc(s.notes)}</p>` : ''}
    <h3 class="hint" style="margin:0 0 6px">Historie</h3>
    <ul class="history">${s.history.length ? s.history.map(h => {
      const planned = h.kind === 'print' && h.status === 'planned';
      const label = h.kind !== 'print' ? `<i>${esc(h.label || 'Korekce')}</i>`
        : planned ? `<i>${esc(h.label)}</i> <span class="tag">naplánováno</span>`
        : esc(h.label) + (h.status === 'failed' ? ' <span class="tag failed">nepovedený</span>' : '');
      return `
      <li${planned ? ' class="planned"' : ''}><div>${label}<div class="when">${fmtDate(h.at)}</div></div>
      <span class="delta num${h.delta > 0 ? ' pos' : ''}">${h.delta > 0 ? '+' : ''}${fmtG(h.delta)}</span></li>`;
    }).join('')
      : '<li class="hint">Zatím žádné tisky.</li>'}</ul>
    <div class="dialog-actions">
      <button class="btn" data-act="edit">Upravit</button>
      <button class="btn" data-act="adjust">Převážit</button>
      <button class="btn" data-act="duplicate">+ Přidat stejnou</button>
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
  if (act === 'duplicate') openDuplicate(detailSpool);
  if (act === 'print') openPrintForm(null, { spoolId: detailSpool.id });
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

// --- Projekty ---

const failedText = p => (p.failed_grams > 0 || p.failed_cost > 0)
  ? `z toho ${p.failed_cost != null ? fmtUsd(p.failed_cost) : fmtG(p.failed_grams)} nepovedené` : '';

function renderProjects() {
  const showDone = $('#show-done').checked;
  const list = state.projects.filter(p => showDone || p.status !== 'done');
  const grid = $('#project-grid');
  if (!state.projects.length) {
    grid.innerHTML = `<div class="empty-state">Zatím žádné projekty. Projekt sdruží tisky jedné věci a sečte jejich gramáž a cenu.<br>
      <button class="btn primary" data-new-project>+ Nový projekt</button></div>`;
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty-state">Všechny projekty jsou hotové. Ukáže je přepínač <b>Zobrazit hotové</b>.</div>'; return; }
  grid.innerHTML = list.map(p => {
    const counts = p.print_count || p.planned_count
      ? [`${p.print_count} ${plural(p.print_count, 'tisk', 'tisky', 'tisků')}`,
         p.planned_count ? `${p.planned_count} ${plural(p.planned_count, 'naplánovaný', 'naplánované', 'naplánovaných')}` : null]
        .filter(Boolean).join(' · ')
      : 'zatím bez tisků';
    const failed = failedText(p);
    return `
      <button class="project${p.status === 'done' ? ' done' : ''}" data-project="${p.id}">
        <div class="title">${esc(p.name)} ${p.status === 'done' ? '<span class="tag">hotový</span>' : ''}</div>
        <div class="project-nums num"><span class="weight">${fmtG(p.grams)}</span>${p.print_count ? ` <span class="cost">${costText(p.filament_cost, p.energy_cost)}</span>` : ''}</div>
        ${failed ? `<div class="failed num">${failed}</div>` : ''}
        <div class="sub">${counts}</div>
      </button>`;
  }).join('');
}

$('#show-done').addEventListener('change', renderProjects);
$('#new-project').addEventListener('click', () => openProjectForm());
$('#project-grid').addEventListener('click', e => {
  if (e.target.closest('[data-new-project]')) return openProjectForm();
  const card = e.target.closest('[data-project]');
  if (card) openProject(Number(card.dataset.project));
});

// --- Formulář projektu ---

const projectDialog = $('#project-dialog');
const projectForm = $('#project-form');
let editingProject = null;
let projectFormDone = null; // callback pro založení z formuláře tisku: dostane projekt, nebo null při zrušení

function openProjectForm(project = null, onDone = null) {
  editingProject = project;
  projectFormDone = onDone;
  projectForm.reset();
  $('[data-title]', projectForm).textContent = project ? 'Upravit projekt' : 'Nový projekt';
  projectForm.elements.name.value = project?.name ?? '';
  projectForm.elements.notes.value = project?.notes ?? '';
  projectDialog.showModal();
}

projectDialog.addEventListener('close', async () => {
  const done = projectFormDone;
  if (projectDialog.returnValue !== 'save') {
    projectFormDone = null;
    done?.(null);
    if (editingProject) openProject(editingProject.id);
    return;
  }
  const body = {
    name: projectForm.elements.name.value,
    notes: projectForm.elements.notes.value,
    status: editingProject?.status ?? 'active',
  };
  try {
    const saved = editingProject
      ? await api(`/projects/${editingProject.id}`, { method: 'PUT', body })
      : await api('/projects', { method: 'POST', body });
    projectFormDone = null;
    toast(editingProject ? 'Projekt upraven' : 'Projekt založen');
    if (editingProject) {
      await refresh(); // název projektu je i u tisků
      openProject(saved.id);
    } else {
      await loadProjects();
    }
    done?.(saved);
  } catch (err) { toast(err.message, true); projectDialog.showModal(); }
});

// --- Detail projektu ---

const projectDetail = $('#project-detail');
let detailProject = null;

async function openProject(id) {
  try { detailProject = await api(`/projects/${id}`); }
  catch (err) { return toast(err.message, true); }
  const p = detailProject;
  const prints = [...p.prints].sort((a, b) =>
    (b.status === 'planned') - (a.status === 'planned') || b.printed_at.localeCompare(a.printed_at) || b.id - a.id);
  const totalUsd = p.filament_cost == null ? null : p.filament_cost + (p.energy_cost ?? 0);
  const total = totalUsd == null ? 'cena neznámá' : `${fmtUsd(totalUsd)} <span class="hint">${czkHint(totalUsd)}</span>`;
  const props = [
    ['Gramáž', fmtG(p.grams)],
    ['Filament', p.filament_cost != null ? fmtUsd(p.filament_cost) : 'cena neznámá'],
    ['Elektřina', p.energy_cost != null ? fmtUsd(p.energy_cost) : '—'],
    ['Tisky', `${p.print_count}${p.planned_count ? ` + ${p.planned_count} naplánováno` : ''}`],
    ['Nepovedené', p.failed_grams > 0 || p.failed_cost > 0
      ? `${fmtG(p.failed_grams)} · ${p.failed_cost != null ? fmtUsd(p.failed_cost) : 'cena neznámá'}` : '—'],
    ['Založen', p.created_at ? fmtDate(p.created_at) : '—'],
  ];

  $('#project-body').innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(p.name)}</h2>
        <div class="hint">${p.status === 'done' ? '<span class="tag">hotový</span>' : '<span class="tag project-tag">rozpracovaný</span>'}</div>
        <div class="big-num num">${total} <span class="hint">celkem</span></div>
      </div>
    </div>
    <div class="detail-props">${props.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('')}</div>
    ${p.notes ? `<p class="hint" style="margin-bottom:14px">${esc(p.notes)}</p>` : ''}
    <h3 class="hint" style="margin:0 0 6px">Tisky</h3>
    <ul class="history project-prints">${prints.length ? prints.map(pr => `
      <li data-print="${pr.id}"${pr.status === 'planned' ? ' class="planned"' : ''}>
        <div>${esc(pr.name)} ${statusTag(pr)}
          <div class="when">${pr.status === 'planned' ? 'čeká na tisk' : fmtDate(pr.printed_at)}${pr.duration_min != null ? ` · ${fmtDur(pr.duration_min)}` : ''}</div></div>
        <div class="right num">${fmtG(printGrams(pr))}<div class="when">${costText(pr.filament_cost, pr.energy_cost)}</div></div>
      </li>`).join('')
      : '<li class="hint">Zatím žádné tisky.</li>'}</ul>
    <div class="dialog-actions">
      <button class="btn ghost danger" data-act="delete">Smazat</button>
      <button class="btn" data-act="edit">Upravit</button>
      <button class="btn" data-act="toggle">${p.status === 'done' ? 'Označit jako rozpracovaný' : 'Označit jako hotový'}</button>
      <div class="actions-end">
        <button class="btn ghost" data-act="close" autofocus>Zavřít</button>
        <button class="btn primary" data-act="print">+ Tisk do projektu</button>
      </div>
    </div>`;
  if (!projectDetail.open) projectDetail.showModal();
}

projectDetail.addEventListener('click', async e => {
  const p = detailProject;
  const row = e.target.closest('[data-print]');
  if (row) {
    projectDetail.close();
    return openPrintForm(p.prints.find(pr => pr.id === Number(row.dataset.print)), { returnTo: p.id });
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'toggle') {
    const status = p.status === 'done' ? 'active' : 'done';
    try {
      await api(`/projects/${p.id}`, { method: 'PUT', body: { name: p.name, notes: p.notes, status } });
      toast(status === 'done' ? 'Projekt je hotový' : 'Projekt je zase rozpracovaný');
      await Promise.all([openProject(p.id), loadProjects()]);
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Smazat projekt „${p.name}“? Tisky zůstanou, jen nebudou v žádném projektu.`)) return;
    try {
      await api(`/projects/${p.id}`, { method: 'DELETE' });
      projectDetail.close();
      toast('Projekt smazán');
      await refresh();
    } catch (err) { toast(err.message, true); }
    return;
  }
  projectDetail.close();
  if (act === 'edit') openProjectForm(p);
  if (act === 'print') openPrintForm(null, { projectId: p.id, returnTo: p.id });
});

// --- Tisky ---

function renderPrints() {
  const q = $('#print-search').value.trim().toLowerCase();
  const list = state.prints.filter(p => !q || [p.name, p.notes, p.project_name].join(' ').toLowerCase().includes(q));
  const el = $('#print-list');
  if (!state.prints.length) {
    el.innerHTML = '<div class="empty-state">Zatím žádné tisky. Po dotisku klikněte na <b>+ Nový tisk</b> a gramáž se odečte z cívky.</div>';
    return;
  }
  if (!list.length) { el.innerHTML = '<div class="empty-state">Nic neodpovídá hledání.</div>'; return; }
  el.innerHTML = list.map(p => `
      <button class="print" data-print="${p.id}">
        <div><span class="name">${esc(p.name)}</span> ${statusTag(p)} ${projectTag(p)}
          <span class="date">· ${fmtDate(p.printed_at)}</span></div>
        <div class="grams num">${fmtG(printGrams(p))}<div class="cost">${costText(p.filament_cost, p.energy_cost)}</div></div>
        <div class="chips">${p.usages.map(u => usageChip(u)).join('')}</div>
      </button>`).join('');
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
const projectSelect = printForm.elements.project_id;
let editingPrint = null;
let printReturnProject = null; // po zavření formuláře se vrátit do detailu projektu

function spoolOptions(selectedId) {
  // V editaci tisku musí být k dispozici i cívka, která mezitím šla do archivu.
  // Stejné cívky pohromadě, načatá první, aby se dotiskávala dřív než nová.
  const groups = [...Map.groupBy(state.allSpools, groupKey).values()];
  const list = groups.flatMap(g => sortGroup(g).map(s => ({ ...s, inGroup: g.length > 1 })));
  if (selectedId && !list.some(s => s.id === selectedId)) {
    const u = editingPrint?.usages.find(u => u.spool_id === selectedId);
    if (u) list.push({ id: selectedId, ...u, remaining: NaN });
  }
  const label = s => esc(spoolLabel(s))
    + (Number.isFinite(s.remaining) ? ` (${fmtG(s.remaining)}${s.inGroup ? (isOpened(s) ? ', načatá' : ', neotevřená') : ''})` : '');
  return '<option value="">— vyberte cívku —</option>' + list.map(s =>
    `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>${label(s)}</option>`).join('');
}

function projectOptions(selectedId) {
  // Hotové projekty nenabízíme, kromě toho, ve kterém tisk už je.
  const list = state.projects.filter(p => p.status !== 'done' || p.id === selectedId);
  if (selectedId && !list.some(p => p.id === selectedId) && editingPrint?.project_id === selectedId) {
    list.push({ id: selectedId, name: editingPrint.project_name, status: 'active' });
  }
  return '<option value="">— žádný —</option>' + list.map(p =>
    `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}${p.status === 'done' ? ' (hotový)' : ''}</option>`).join('') +
    '<option value="new">+ Nový projekt…</option>';
}

projectSelect.addEventListener('change', () => {
  if (projectSelect.value !== 'new') { projectSelect.dataset.prev = projectSelect.value; return; }
  openProjectForm(null, created => {
    projectSelect.innerHTML = projectOptions(created ? created.id : Number(projectSelect.dataset.prev) || null);
    projectSelect.dataset.prev = projectSelect.value;
  });
});

function addUsageRow(spoolId = null, grams = '') {
  const row = document.createElement('div');
  row.className = 'usage-row';
  row.innerHTML = `
    <select name="spool_id" required>${spoolOptions(spoolId)}</select>
    <div class="grams-input"><input name="grams" type="text" inputmode="decimal" pattern="\\d*[.,]?\\d*" required placeholder="0" value="${grams}"></div>
    <button type="button" class="icon-btn" title="Odebrat" aria-label="Odebrat">×</button>
    <div class="after"></div>`;
  $('#usage-rows').append(row);
  updateUsageInfo();
  return row;
}

function durationValue() {
  const t = (Number(printForm.elements.dur_h.value) || 0) * 60 + (Number(printForm.elements.dur_m.value) || 0);
  return t > 0 ? t : null;
}

// Cena za gram v USD (stejný přepočet jako PRICE_PER_G na serveru).
function pricePerG(spoolId) {
  const s = state.allSpools.find(s => s.id === spoolId);
  if (s) {
    if (s.price == null || !s.initial_weight) return null;
    return s.price * czkPerUnit(s.currency) / state.rates.USD / s.initial_weight;
  }
  return editingPrint?.usages.find(u => u.spool_id === spoolId)?.price_per_g ?? null;
}

function updateEstimate() {
  const status = printForm.elements.status.value;
  const percent = status === 'failed' ? Number(printForm.elements.percent.value) || 0 : 100;
  const minutes = durationValue();
  const { kwh_price = 0, printer_watts = 0 } = state.settings;
  const energy = minutes != null ? minutes / 60 * printer_watts / 1000 * kwh_price / state.rates.USD * percent / 100 : null;
  let filament = 0, unknown = false, any = false;
  for (const row of $$('.usage-row', printForm)) {
    const id = Number($('select', row).value);
    const grams = Number($('input', row).value) || 0;
    if (!id || grams <= 0) continue;
    any = true;
    const ppg = pricePerG(id);
    if (ppg == null) unknown = true;
    else filament += grams * ppg;
  }
  const el = $('#print-estimate');
  el.classList.toggle('unknown', unknown);
  if (!any) { el.textContent = energy != null ? `≈ ${fmtUsd(energy)} elektřina` : ''; return; }
  const energyText = energy != null ? `${fmtUsd(energy)} elektřina` : '';
  el.textContent = unknown
    ? `Cena filamentu neznámá${energyText ? ` · ≈ ${energyText}` : ''}`
    : `≈ ${fmtUsd(filament)} filament${energyText ? ` + ${energyText}` : ''} (${czkHint(filament + (energy ?? 0))})`;
}

// Kolik gramů může tento tisk z cívky vzít, než klesne pod nulu (bez řádku `exceptRow`).
// Původní spotřeba upravovaného tisku je buď už odečtená (ok/failed), nebo v rezervaci (planned).
function availableOn(spool, exceptRow = null) {
  const rows = $$('.usage-row', printForm);
  const wasPlanned = editingPrint?.status === 'planned';
  const original = editingPrint?.usages.filter(u => u.spool_id === spool.id).reduce((a, u) => a + u.grams, 0) ?? 0;
  const otherRows = rows.filter(r => r !== exceptRow && Number($('select', r).value) === spool.id)
    .reduce((a, r) => a + (Number($('input', r).value) || 0), 0);
  const otherReserved = printForm.elements.status.value === 'planned'
    ? Math.max(0, (spool.reserved ?? 0) - (wasPlanned ? original : 0)) : 0;
  return { available: spool.remaining + (wasPlanned ? 0 : original) - otherRows - otherReserved, otherReserved };
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
    const { available, otherReserved } = availableOn(spool, row);
    const left = available - grams;
    const note = otherReserved > 0 ? ` · počítá s ${fmtG(otherReserved)} pro jiné naplánované tisky` : '';
    after.textContent = `Po tisku zbude ${fmtG(left)}${note}`;
    after.classList.toggle('neg', left < 0);
  }
  $('#usage-total').textContent = rows.length > 1 ? `Celkem ${fmtG(total)}` : '';
  updateEstimate();
}

// Když se tisk na cívku nevejde a existují další stejné cívky, zbytek se přesune na ně
// (napřed načaté, pak neotevřené), aby se nemuselo počítat ručně.
function autoSplit(row) {
  const spool = state.allSpools.find(s => s.id === Number($('select', row).value));
  const grams = Number($('input', row).value) || 0;
  if (!spool || grams <= 0) return false;
  const available = round1(Math.max(0, availableOn(spool, row).available));
  if (grams <= available) return false;

  const taken = new Set($$('.usage-row select', printForm).map(sel => Number(sel.value)));
  const next = sortGroup(state.allSpools.filter(s =>
    s.id !== spool.id && !taken.has(s.id) && groupKey(s) === groupKey(spool)));
  if (!next.length) return false;

  const parts = [];
  const describe = (s, g) => `${fmtG(g)} z ${s.id === spool.id || isOpened(s) ? 'načaté' : 'neotevřené'} cívky`;
  let rest = grams;
  let reuseRow = row;
  if (available > 0) {
    $('input', row).value = available;
    parts.push(describe(spool, available));
    rest = round1(rest - available);
    reuseRow = null;
  }
  for (const [i, s] of next.entries()) {
    if (rest <= 0) break;
    const g = i === next.length - 1 ? rest : round1(Math.min(rest, Math.max(0, availableOn(s).available)));
    if (g <= 0) continue;
    if (reuseRow) {
      // Na původní cívce nezbylo nic, řádek se jen přepne na další.
      $('select', reuseRow).value = s.id;
      $('input', reuseRow).value = g;
      reuseRow = null;
    } else {
      addUsageRow(s.id, g);
    }
    parts.push(describe(s, g));
    rest = round1(rest - g);
  }
  updateUsageInfo();
  toast(parts.length > 1 ? `Rozděleno: ${parts.join(' + ')}`
    : `Na vybrané cívce nic nezbývá, použito ${parts[0]}`);
  return true;
}

function updatePrintMode() {
  const status = printForm.elements.status.value;
  $$('[data-when]', printForm).forEach(el => el.hidden = el.dataset.when !== status);
  $$('[data-unless]', printForm).forEach(el => el.hidden = el.dataset.unless === status);
  printForm.elements.percent.required = status === 'failed';
  $('#usage-legend').textContent = status === 'planned' ? 'Plánovaná spotřeba filamentu' : 'Spotřeba filamentu';
  $('button[value="save"]', printForm).textContent = editingPrint ? 'Uložit' : status === 'planned' ? 'Naplánovat' : 'Uložit a odečíst';
  updateUsageInfo();
}

$('#usage-rows').addEventListener('input', updateUsageInfo);
$('#usage-rows').addEventListener('change', e => {
  const row = e.target.closest('.usage-row');
  if (row) autoSplit(row);
});
// Enter v poli gramů odešle formulář dřív, než stihne proběhnout change.
printForm.addEventListener('submit', () => $$('.usage-row', printForm).forEach(autoSplit));
$('#usage-rows').addEventListener('click', e => {
  if (e.target.closest('.icon-btn')) { e.target.closest('.usage-row').remove(); updateUsageInfo(); }
});
$('#add-usage').addEventListener('click', () => $('select', addUsageRow()).focus());
printForm.addEventListener('change', e => { if (e.target.name === 'status') updatePrintMode(); });
printForm.addEventListener('input', e => { if (['dur_h', 'dur_m', 'percent'].includes(e.target.name)) updateEstimate(); });

function openPrintForm(print = null, { spoolId = null, projectId = null, returnTo = null } = {}) {
  if (!state.allSpools.length) {
    toast('Nejdřív přidejte alespoň jednu cívku', true);
    return openSpoolForm();
  }
  editingPrint = print;
  printReturnProject = returnTo;
  printForm.reset();
  $('#usage-rows').innerHTML = '';
  $('[data-title]', printForm).textContent = !print ? 'Nový tisk' : print.status === 'planned' ? 'Upravit naplánovaný tisk' : 'Upravit tisk';
  $$('[data-edit-only]', printForm).forEach(el => el.hidden = !print);
  printForm.elements.name.value = print?.name ?? '';
  printForm.elements.printed_at.value = print?.printed_at ?? today();
  printForm.elements.status.value = print?.status ?? 'ok';
  printForm.elements.percent.value = print?.status === 'failed' ? print.percent : 50;
  projectSelect.innerHTML = projectOptions(print ? print.project_id : projectId);
  projectSelect.dataset.prev = projectSelect.value;
  if (print?.duration_min != null) {
    const t = Math.round(print.duration_min);
    printForm.elements.dur_h.value = Math.floor(t / 60) || '';
    printForm.elements.dur_m.value = t % 60 || '';
  }
  printForm.elements.notes.value = print?.notes ?? '';
  if (print) print.usages.forEach(u => addUsageRow(u.spool_id, u.grams));
  else addUsageRow(spoolId ?? (state.allSpools.length === 1 ? state.allSpools[0].id : null));
  updatePrintMode();
  printDialog.showModal();
}

printDialog.addEventListener('close', async () => {
  if (printDialog.returnValue === 'save') {
    const status = printForm.elements.status.value;
    const project = projectSelect.value;
    const body = {
      name: printForm.elements.name.value,
      printed_at: printForm.elements.printed_at.value,
      status,
      percent: status === 'failed' ? Number(printForm.elements.percent.value) : 100,
      duration_min: durationValue(),
      project_id: project && project !== 'new' ? Number(project) : null,
      notes: printForm.elements.notes.value,
      usages: $$('.usage-row', printForm).map(r => ({ spool_id: $('select', r).value, grams: $('input', r).value })),
    };
    try {
      if (editingPrint) await api(`/prints/${editingPrint.id}`, { method: 'PUT', body });
      else await api('/prints', { method: 'POST', body });
      const total = body.usages.reduce((a, u) => a + Number(u.grams), 0);
      toast(editingPrint ? 'Tisk upraven' : status === 'planned' ? 'Tisk naplánován' : `Odečteno ${fmtG(total)}`);
      await refresh();
    } catch (err) { toast(err.message, true); printDialog.showModal(); return; }
  }
  if (printReturnProject) {
    const id = printReturnProject;
    printReturnProject = null;
    openProject(id);
  }
});

$('[data-action="delete"]', printForm).addEventListener('click', async () => {
  const msg = editingPrint.status === 'planned'
    ? `Smazat naplánovaný tisk „${editingPrint.name}“? Rezervace filamentu se zruší.`
    : `Smazat tisk „${editingPrint.name}“? Gramáž se vrátí na cívky.`;
  if (!confirm(msg)) return;
  try {
    await api(`/prints/${editingPrint.id}`, { method: 'DELETE' });
    printDialog.close('done');
    toast(editingPrint.status === 'planned' ? 'Naplánovaný tisk smazán' : 'Tisk smazán, gramáž vrácena');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

// --- Nastavení ---

const settingsDialog = $('#settings-dialog');
const settingsForm = $('#settings-form');

function renderRates() {
  const r = state.rates;
  const fmt = v => v.toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
  $('#rates-info').innerHTML = r.source === 'cnb'
    ? `Kurz ČNB k ${fmtDate(r.date)}: 1 USD = ${fmt(r.USD)} Kč, 1 EUR = ${fmt(r.EUR)} Kč`
    : `Kurz ČNB se zatím nepodařilo stáhnout, počítá se orientačně (1 USD = ${fmt(r.USD)} Kč, 1 EUR = ${fmt(r.EUR)} Kč).`;
}

$('#open-settings').addEventListener('click', () => {
  for (const [key, value] of Object.entries(state.settings)) {
    if (settingsForm.elements[key]) settingsForm.elements[key].value = value;
  }
  renderRates();
  settingsDialog.showModal();
});

$('#refresh-rates').addEventListener('click', async () => {
  try {
    state.rates = await api('/rates/refresh', { method: 'POST' });
    renderRates();
    toast('Kurzy aktualizovány');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

settingsDialog.addEventListener('close', async () => {
  if (settingsDialog.returnValue !== 'save') return;
  try {
    state.settings = await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(settingsForm)) });
    toast('Nastavení uloženo');
    await refresh();
  } catch (err) { toast(err.message, true); settingsDialog.showModal(); }
});

// --- Záložky ---

const TABS = ['inventory', 'projects', 'prints'];

function setTab(tab) {
  state.tab = tab;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  history.replaceState(null, '', `#${tab}`);
}
$('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
const tabFromHash = () => { const t = location.hash.slice(1); setTab(TABS.includes(t) ? t : 'inventory'); };
addEventListener('hashchange', tabFromHash);
tabFromHash();

loadSettings().then(refresh).catch(err => toast(err.message, true));
