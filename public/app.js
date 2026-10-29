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
// placeholder = prázdné místo stejné velikosti, aby řádky se seznamem náhledů lícovaly
const thumbImg = (url, cls = '', placeholder = false) => url
  ? `<img class="thumb${cls ? ' ' + cls : ''}" src="${esc(url)}" alt="" loading="lazy">`
  : placeholder ? `<span class="thumb empty${cls ? ' ' + cls : ''}" aria-hidden="true"></span>` : '';
const fmtSize = b => b >= 1e6 ? `${(b / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;

// Bublina je popover, takže je v top layer nad modálními dialogy (z-index na ně nestačí).
// Při každém zobrazení se znovu otevře, aby skončila nad naposledy otevřeným dialogem.
let toastTimer;
// action = { label, run }: tlačítko v bublině (např. Zpět); bublina pak vydrží déle a jde na ni klepnout.
function toast(msg, isError = false, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { hideToast(); action.run(); }, { once: true });
    el.append(btn);
  }
  if (el.matches(':popover-open')) el.hidePopover();
  el.showPopover();
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 2800);
}

function hideToast() {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.classList.remove('show');
  toastTimer = setTimeout(() => el.hidePopover(), 200);
}

// Náhled modelu jde rozkliknout. Zachytává se už ve fázi capture, aby klik neotevřel i řádek
// nebo kartu, ve které náhled je (a v importu nepřepnul zaškrtnutí podložky).
// Zvětšení vyrůstá z místa malého náhledu a při zavření se do něj vrací.
const imageDialog = $('#image-dialog');
const bigImage = $('img', imageDialog);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let zoomedThumb = null;

// Transformace, která velký obrázek posune a zmenší přesně na místo malého náhledu.
function thumbTransform(thumb) {
  const from = thumb.getBoundingClientRect();
  const to = bigImage.getBoundingClientRect();
  if (!from.width || !to.width) return null;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${from.width / to.width})`;
}

function openZoom(thumb) {
  zoomedThumb = thumb;
  bigImage.src = thumb.src;
  imageDialog.classList.remove('closing');
  imageDialog.showModal();
  const start = thumbTransform(thumb);
  if (!start || reduceMotion.matches) return;
  thumb.style.visibility = 'hidden';
  bigImage.animate([{ transform: start, borderRadius: '40px' }, { transform: 'none' }],
    { duration: 380, easing: 'cubic-bezier(.2, .8, .2, 1)' });
}

function closeZoom() {
  if (!imageDialog.open || imageDialog.classList.contains('closing')) return;
  const thumb = zoomedThumb;
  const end = thumb?.isConnected ? thumbTransform(thumb) : null;
  let anim = null;
  const done = () => {
    if (!imageDialog.classList.contains('closing')) return;
    anim?.cancel();
    imageDialog.close();
    imageDialog.classList.remove('closing');
    if (thumb) thumb.style.visibility = '';
  };
  imageDialog.classList.add('closing');
  if (reduceMotion.matches) return done();
  // Když náhled mezitím zmizel (překreslení seznamu), obrázek jen zmizí na místě.
  anim = bigImage.animate(end
    ? [{ transform: 'none' }, { transform: end, borderRadius: '40px' }]
    : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.92)' }],
  { duration: 280, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
  anim.finished.then(done, () => {});
  // Pojistka: ve skryté záložce animace neběží a .finished by nikdy nenastalo.
  setTimeout(done, 320);
}

document.addEventListener('click', e => {
  const img = e.target.closest?.('img.thumb');
  if (!img) return;
  e.preventDefault();
  e.stopPropagation();
  openZoom(img);
}, true);
imageDialog.addEventListener('click', closeZoom);
imageDialog.addEventListener('cancel', e => { e.preventDefault(); closeZoom(); });
imageDialog.addEventListener('close', () => { if (zoomedThumb) zoomedThumb.style.visibility = ''; });

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
  // Zvětšený náhled se zavírá vlastní animací (closeZoom).
  if (d === imageDialog) continue;
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
          <div class="planned-main">
            ${thumbImg(p.thumb_url)}
            <div class="planned-info">
              <div><button type="button" class="planned-name">${esc(p.name)}</button> ${projectTag(p)}</div>
              <div class="chips">${chips}</div>
              <div class="planned-meta num">${meta}</div>
            </div>
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
    // Hotovo je jedno klepnutí vedle Selhalo — omyl jde chvíli vrátit zpět do fronty.
    toast(`Hotovo · odečteno ${fmtG(printGrams(p))}`, false, { label: 'Zpět', run: () => undoDone(print) });
    await refresh();
  } catch (err) { toast(err.message, true); done.disabled = false; }
});

async function undoDone(print) {
  try {
    await api(`/prints/${print.id}`, { method: 'PUT', body: {
      name: print.name, printed_at: print.printed_at, status: 'planned', percent: 100,
      duration_min: print.duration_min, project_id: print.project_id, notes: print.notes,
      file_id: print.file_id, plate_index: print.plate_index,
      usages: print.usages.map(u => ({ spool_id: u.spool_id, grams: u.grams })),
    } });
    toast('Vráceno do fronty');
    await refresh();
  } catch (err) { toast(err.message, true); }
}

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
let spoolSaved = null; // callback z importu: dostane uloženou cívku

function openSpoolForm(spool = null, { prefill = null, onSaved = null } = {}) {
  editingSpool = spool;
  spoolSaved = onSaved;
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
    for (const [key, value] of Object.entries(prefill ?? {})) spoolForm.elements[key].value = value;
  }
  spoolDialog.showModal();
}

spoolDialog.addEventListener('close', async () => {
  if (spoolDialog.returnValue !== 'save') { spoolSaved = null; return; }
  const body = Object.fromEntries(new FormData(spoolForm));
  try {
    const saved = editingSpool
      ? await api(`/spools/${editingSpool.id}`, { method: 'PUT', body })
      : await api('/spools', { method: 'POST', body });
    toast(editingSpool ? 'Cívka upravena' : 'Cívka přidána');
    await refresh();
    const done = spoolSaved;
    spoolSaved = null;
    done?.(saved);
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

  const anyThumb = prints.some(pr => pr.thumb_url);
  const files = [...new Map(p.prints.filter(pr => pr.file_id).map(pr => [pr.file_id, pr.file_name])).entries()];

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
        <div class="row-main">${thumbImg(pr.thumb_url, '', anyThumb)}<div>${esc(pr.name)} ${statusTag(pr)}
          <div class="when">${pr.status === 'planned' ? 'čeká na tisk' : fmtDate(pr.printed_at)}${pr.duration_min != null ? ` · ${fmtDur(pr.duration_min)}` : ''}</div></div></div>
        <div class="row-end">
          ${pr.status !== 'planned' ? '<button type="button" class="btn small" data-reprint title="Vytisknout znovu">↻ Znovu</button>' : ''}
          <div class="right num">${fmtG(printGrams(pr))}<div class="when">${costText(pr.filament_cost, pr.energy_cost)}</div></div>
        </div>
      </li>`).join('')
      : '<li class="hint">Zatím žádné tisky.</li>'}</ul>
    ${files.length ? `<h3 class="hint" style="margin:0 0 6px">Soubory</h3>
    <ul class="file-list">${files.map(([id, name]) => `
      <li><a href="/api/files/${id}/download" download>${esc(name || `soubor-${id}.3mf`)}</a></li>`).join('')}</ul>` : ''}
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
    const print = p.prints.find(pr => pr.id === Number(row.dataset.print));
    projectDetail.close();
    if (e.target.closest('[data-reprint]')) return reprint(print);
    return openPrintForm(print, { returnTo: p.id });
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
  const anyThumb = list.some(p => p.thumb_url);
  el.innerHTML = list.map(p => `
      <button class="print${anyThumb ? ' has-thumb' : ''}" data-print="${p.id}">
        ${thumbImg(p.thumb_url, '', anyThumb)}
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
    // u.id je id řádku spotřeby, ne cívky — proto id až za spread.
    if (u) list.push({ ...u, id: selectedId, remaining: NaN });
  }
  // Barva první: na úzkém displeji je vidět jen začátek textu a podle barvy se cívky rozlišují.
  const label = s => esc([s.color_name, s.material, s.brand].filter(Boolean).join(' · '))
    + (Number.isFinite(s.remaining) ? ` (${fmtG(s.remaining)}${s.inGroup ? (isOpened(s) ? ', načatá' : ', neotevřená') : ''})`
      : ' (dotištěná / v archivu)');
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

// Rozdělí gramy na cívku a podle potřeby na další stejné cívky (napřed načaté, pak neotevřené).
// availableFn(spool) = kolik gramů z cívky ještě jde vzít; poslední cívka skupiny dostane zbytek,
// i když se na ni nevejde. Cívky z `exclude` se jako další nepoužijí. Vrací [{ spool, grams }].
function allocate(spool, grams, availableFn, exclude = new Set()) {
  const available = round1(Math.max(0, availableFn(spool)));
  if (grams <= available) return [{ spool, grams }];
  const next = sortGroup(state.allSpools.filter(s =>
    s.id !== spool.id && !exclude.has(s.id) && groupKey(s) === groupKey(spool)));
  if (!next.length) return [{ spool, grams }];

  const parts = [];
  let rest = grams;
  if (available > 0) {
    parts.push({ spool, grams: available });
    rest = round1(rest - available);
  }
  for (const [i, s] of next.entries()) {
    if (rest <= 0) break;
    const g = i === next.length - 1 ? rest : round1(Math.min(rest, Math.max(0, availableFn(s))));
    if (g <= 0) continue;
    parts.push({ spool: s, grams: g });
    rest = round1(rest - g);
  }
  return parts;
}

// Když se tisk na cívku nevejde a existují další stejné cívky, zbytek se přesune na ně,
// aby se nemuselo počítat ručně.
function autoSplit(row) {
  const spool = state.allSpools.find(s => s.id === Number($('select', row).value));
  const grams = Number($('input', row).value) || 0;
  if (!spool || grams <= 0) return false;
  const taken = new Set($$('.usage-row select', printForm).map(sel => Number(sel.value)));
  const parts = allocate(spool, grams, s => availableOn(s, s === spool ? row : null).available, taken);
  if (parts.length === 1 && parts[0].spool === spool) return false;

  // První část zůstane v řádku (na původní cívce nezbylo nic → řádek se jen přepne na další).
  const [first, ...rest] = parts;
  $('select', row).value = first.spool.id;
  $('input', row).value = first.grams;
  for (const p of rest) addUsageRow(p.spool.id, p.grams);
  updateUsageInfo();
  const describe = p => `${fmtG(p.grams)} z ${p.spool === spool || isOpened(p.spool) ? 'načaté' : 'neotevřené'} cívky`;
  toast(parts.length > 1 ? `Rozděleno: ${parts.map(describe).join(' + ')}`
    : `Na vybrané cívce nic nezbývá, použito ${describe(first)}`);
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

// copyOf = „Vytisknout znovu“ bez souboru: nový naplánovaný tisk se stejným názvem, projektem,
// časem a cívkami; u nepovedeného tisku se gramy přepočtou na celý tisk.
function openPrintForm(print = null, { spoolId = null, projectId = null, returnTo = null, copyOf = null } = {}) {
  if (!state.allSpools.length) {
    toast('Nejdřív přidejte alespoň jednu cívku', true);
    return openSpoolForm();
  }
  editingPrint = print;
  printReturnProject = returnTo;
  const src = print ?? copyOf;
  printForm.reset();
  $('#usage-rows').innerHTML = '';
  $('[data-title]', printForm).textContent = copyOf ? 'Vytisknout znovu'
    : !print ? 'Nový tisk' : print.status === 'planned' ? 'Upravit naplánovaný tisk' : 'Upravit tisk';
  $$('[data-edit-only]', printForm).forEach(el => el.hidden = !print);
  $$('[data-new-only]', printForm).forEach(el => el.hidden = !!src);
  $('[data-action="reprint"]', printForm).hidden = !print || print.status === 'planned';
  printForm.elements.name.value = src?.name ?? '';
  printForm.elements.printed_at.value = print?.printed_at ?? today();
  printForm.elements.status.value = print?.status ?? (copyOf ? 'planned' : 'ok');
  printForm.elements.percent.value = print?.status === 'failed' ? print.percent : 50;
  projectSelect.innerHTML = projectOptions(print ? print.project_id : copyOf ? copyOf.project_id : projectId);
  projectSelect.dataset.prev = projectSelect.value;
  if (src?.duration_min != null) {
    const t = Math.round(src.duration_min);
    printForm.elements.dur_h.value = Math.floor(t / 60) || '';
    printForm.elements.dur_m.value = t % 60 || '';
  }
  printForm.elements.notes.value = print?.notes ?? '';
  renderPrintFile(print);
  if (print) print.usages.forEach(u => addUsageRow(u.spool_id, u.grams));
  else if (copyOf?.usages.length) {
    const factor = copyOf.status === 'failed' && copyOf.percent > 0 ? 100 / copyOf.percent : 1;
    // Cívka, která mezitím šla z aktivního inventáře, se musí vybrat znovu.
    copyOf.usages.forEach(u => addUsageRow(state.allSpools.some(s => s.id === u.spool_id) ? u.spool_id : null, round1(u.grams * factor)));
  } else addUsageRow(spoolId ?? (state.allSpools.length === 1 ? state.allSpools[0].id : null));
  updatePrintMode();
  if (copyOf) $$('.usage-row', printForm).forEach(autoSplit);
  printDialog.showModal();
  // Jinak by fokus dostal první odkaz (Stáhnout 3MF); stav tisku je přirozený začátek formuláře.
  $('input[name="status"]:checked', printForm)?.focus();
}

// Upravovaný tisk ze 3MF: větší náhled podložky a stažení souboru.
function renderPrintFile(print) {
  const el = $('#print-file');
  el.hidden = !print?.file_id;
  if (el.hidden) { el.innerHTML = ''; return; }
  el.innerHTML = `
    ${thumbImg(print.thumb_url, 'big')}
    <div class="print-file-info">
      <span class="hint">Soubor${print.plate_index ? ` · podložka ${print.plate_index}` : ''}</span>
      <b>${esc(print.file_name || `soubor-${print.file_id}.3mf`)}</b>
      <a class="btn small" href="/api/files/${print.file_id}/download" download>Stáhnout 3MF</a>
    </div>`;
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
      file_id: editingPrint?.file_id ?? null,
      plate_index: editingPrint?.plate_index ?? null,
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

$('[data-action="reprint"]', printForm).addEventListener('click', () => {
  const print = editingPrint;
  printReturnProject = null;
  printDialog.close('cancel');
  reprint(print);
});

// Smazání tisku: u proběhlého tisku se ptáme, jestli šlo o chybný záznam (gramy vrátit),
// nebo jen o úklid (spotřeba zůstane odečtená).
const deletePrintDialog = $('#delete-print-dialog');

$('[data-action="delete"]', printForm).addEventListener('click', () => {
  const planned = editingPrint.status === 'planned';
  $('[data-delete-text]', deletePrintDialog).textContent = planned
    ? `Smazat naplánovaný tisk „${editingPrint.name}“? Rezervace filamentu se zruší.`
    : `Smazat tisk „${editingPrint.name}“ (${fmtG(printGrams(editingPrint))})? Co se má stát s filamentem?`;
  $$('[data-when-done]', deletePrintDialog).forEach(el => el.hidden = planned);
  $('[data-when-planned]', deletePrintDialog).hidden = !planned;
  deletePrintDialog.showModal();
});

deletePrintDialog.addEventListener('close', async () => {
  const choice = deletePrintDialog.returnValue;
  if (!['return', 'keep'].includes(choice)) return;
  try {
    await api(`/prints/${editingPrint.id}${choice === 'keep' ? '?keep=1' : ''}`, { method: 'DELETE' });
    printDialog.close('done');
    toast(editingPrint.status === 'planned' ? 'Naplánovaný tisk smazán'
      : choice === 'keep' ? 'Tisk smazán, spotřeba zůstala odečtená' : 'Tisk smazán, gramáž vrácena');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

// --- Import 3MF ---

// Párování filamentu z Bambu Studia s cívkou. Materiál: „PLA Basic/Matte…“ = PLA (shoda podle
// prvního slova), „PLA+“ / „PLA Pro“ ≈ PLA jen jako slabší shoda; „PLA-CF“ je jiný materiál.
function materialKey(m) {
  const [first = '', second = ''] = String(m ?? '').trim().toUpperCase().split(/\s+/);
  return { base: first.replace(/\+$/, ''), plus: first.endsWith('+') || second === 'PRO' || second === '+' };
}
function materialMatch(a, b) {
  const x = materialKey(a), y = materialKey(b);
  if (!x.base || x.base !== y.base) return 0;
  return x.plus === y.plus ? 2 : 1;
}
const hexRgb = hex => {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex ?? ''));
  return m ? [0, 8, 16].map(sh => (parseInt(m[1], 16) >> (16 - sh)) & 255) : null;
};
function colorDistance(a, b) {
  const x = hexRgb(a), y = hexRgb(b);
  return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : Infinity;
}
const COLOR_MATCH = 60; // RGB vzdálenost, do které barvu cívky bereme jako shodnou

// Skupiny stejných cívek, které sedí na filament; nejlepší první (materiál, pak bližší barva).
function matchGroups(fil) {
  const scored = state.allSpools
    .map(s => ({ s, mat: materialMatch(s.material, fil.type), dist: colorDistance(s.color_hex, fil.color) }))
    .filter(x => x.mat > 0 && x.dist <= COLOR_MATCH);
  return [...Map.groupBy(scored, x => groupKey(x.s)).values()]
    .map(list => ({ spools: sortGroup(list.map(x => x.s)), mat: Math.max(...list.map(x => x.mat)), dist: Math.min(...list.map(x => x.dist)) }))
    .sort((a, b) => b.mat - a.mat || a.dist - b.dist);
}

// Návrh cívky: přednost mají cívky původního tisku (Vytisknout znovu), pokud stačí. Jinak z nejlepší
// skupiny načatá s nejmenším zůstatkem, na kterou se tisk vejde; když žádná, ta s největším zůstatkem
// (zbytek rozdělí allocate na další stejné cívky).
function suggestSpool(fil, need, avail, preferred = []) {
  const pref = preferred.map(id => state.allSpools.find(s => s.id === id)).find(s => s && avail(s) >= need);
  if (pref) return { spool: pref, weak: false };
  const groups = matchGroups(fil);
  if (!groups.length) return null;
  const total = g => g.spools.reduce((a, s) => a + Math.max(0, avail(s)), 0);
  // Mezi skoro stejně dobrými skupinami (jiná značka téže barvy) vyhraje ta, na kterou se tisk vejde.
  const best = groups.find(g => g.mat === groups[0].mat && g.dist <= groups[0].dist + 10 && total(g) >= need) ?? groups[0];
  const fits = best.spools.filter(s => avail(s) >= need);
  const spool = fits.find(isOpened) ?? fits[0] ?? best.spools.reduce((a, s) => avail(s) > avail(a) ? s : a);
  return { spool, weak: best.mat === 1 };
}

const importDialog = $('#import-dialog');
const importForm = $('#import-form');
const importFileInput = $('#import-file');
let imp = null;          // rozpracovaný import: { file, plates, assign, preferred, names, rowsKey }
let importXhr = null;
let importOptions = {};  // projekt předvybraný při otevření z formuláře tisku

const plateLabel = p => p.name || `Podložka ${p.index}`;
const filLabel = f => esc(f.type || '?');
// „Generic · Generic PLA“ → jen „Generic PLA“
// „Bambu PLA Basic @BBL X1C-1(projekt.3mf)“ → „Bambu PLA Basic“ (zbytek je jen profil tiskárny).
const profileName = id => (id || '').replace(/\s*@.*$/, '');
const filVendor = f => {
  const name = profileName(f.settings_id);
  return name && f.vendor && name.startsWith(f.vendor) ? name : [f.vendor, name].filter(Boolean).join(' · ');
};

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = importXhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      importXhr = null;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* chyba bez JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Chyba ${xhr.status}`));
    };
    xhr.onerror = () => { importXhr = null; reject(new Error('Nahrání se nepovedlo')); };
    xhr.onabort = () => { importXhr = null; reject(new DOMException('Zrušeno', 'AbortError')); };
    xhr.send(file);
  });
}

function openImportShell(info) {
  imp = null;
  importForm.reset();
  $('#import-info').textContent = info;
  $('#import-body').hidden = true;
  $('#import-progress').hidden = false;
  $('#import-submit').disabled = true;
  $('#import-submit').textContent = 'Naplánovat';
  if (!importDialog.open) importDialog.showModal();
}

function setUploadProgress(loaded, total) {
  const done = total ? loaded / total : 0;
  $('#import-progress progress').value = Math.round(done * 100);
  $('#import-progress [data-progress-text]').textContent = done >= 1
    ? `Čtu projekt… (${fmtSize(total)})` : `Nahrávám… ${fmtSize(loaded)} z ${fmtSize(total)}`;
}

async function startImport(file, options = importOptions) {
  importOptions = {};
  if (!/\.3mf$/i.test(file.name)) return toast('Vyberte projekt z Bambu Studia (.3mf)', true);
  openImportShell(`${file.name} · ${fmtSize(file.size)}`);
  setUploadProgress(0, file.size);
  try {
    const data = await uploadFile(file, setUploadProgress);
    if (importDialog.open) showImport(data, options);
  } catch (err) {
    if (err.name === 'AbortError') return;
    importDialog.close('cancel');
    toast(err.message, true);
  }
}

// options: projectId (předvybraný projekt), reprint (původní tisk → jen jeho podložka,
// gramy z tisku, když je soubor nemá, a přednostně jeho cívky).
function showImport(file, { projectId = null, reprint = null } = {}) {
  const meta = file.meta;
  // Typ/barva/vendor filamentu můžou chybět; indexy podložek nemusí začínat od 1 (.gcode.3mf).
  const plates = meta.plates.map(p => ({
    ...p,
    thumb_url: p.thumb_url ?? null,
    filaments: (p.filaments ?? []).map(f => ({ ...f, color: hexRgb(f.color) ? f.color : '#888888' })),
  }));
  imp = { file, plates, assign: new Map(), preferred: new Map(), names: new Map(), rowsKey: '' };
  const grams = new Map(); // `${plate}:${fil}` → předvyplněné gramy
  const durations = new Map(plates.map(p => [p.index, p.duration_min]));

  if (reprint) {
    const plate = plates.find(p => p.index === reprint.plate_index);
    imp.names.set(plate.index, reprint.name);
    if (durations.get(plate.index) == null) durations.set(plate.index, reprint.duration_min);
    // Spotřebu původního tisku přiřadíme k filamentům podložky podle materiálu a barvy.
    const factor = reprint.status === 'failed' && reprint.percent > 0 ? 100 / reprint.percent : 1;
    const fromPrint = new Map();
    for (const u of reprint.usages) {
      const fil = plate.filaments.length === 1 ? plate.filaments[0] : [...plate.filaments].sort((a, b) =>
        (materialMatch(u.material, b.type) > 0) - (materialMatch(u.material, a.type) > 0)
        || colorDistance(u.color_hex, a.color) - colorDistance(u.color_hex, b.color))[0];
      if (!fil) continue;
      imp.preferred.set(fil.id, [...(imp.preferred.get(fil.id) ?? []), u.spool_id]);
      fromPrint.set(fil.id, (fromPrint.get(fil.id) ?? 0) + u.grams * factor);
    }
    for (const f of plate.filaments) {
      const g = f.used_g ?? fromPrint.get(f.id);
      if (g != null) grams.set(`${plate.index}:${f.id}`, round1(g));
    }
  } else {
    for (const p of plates) for (const f of p.filaments) if (f.used_g != null) grams.set(`${p.index}:${f.id}`, round1(f.used_g));
  }

  $('#import-info').textContent = `${file.filename} · ${fmtSize(file.size)}`;
  const unsliced = plates.filter(p => p.sliced === false).length;
  $('#import-unsliced').hidden = !unsliced;
  $('#import-unsliced').textContent = unsliced === plates.length
    ? 'Projekt není uložený po slicování – gramy doplň ručně (příště stačí v Bambu Studiu po slicování uložit projekt).'
    : 'Některé podložky nejsou naslicované – u nich doplň gramy ručně.';
  $('#import-plates').innerHTML = plates.map(p => {
    const checked = (reprint ? p.index === reprint.plate_index : true) && p.filaments.length > 0;
    const dur = durations.get(p.index);
    const t = dur != null ? Math.round(dur) : null;
    return `
    <article class="plate${checked ? '' : ' off'}" data-plate="${p.index}">
      <div class="plate-thumb">${thumbImg(p.thumb_url, 'big', true)}</div>
      <div class="plate-body">
        <label class="check plate-title"><input type="checkbox" data-plate-check${checked ? ' checked' : ''}${p.filaments.length ? '' : ' disabled'}>
          <b>${esc(plateLabel(p))}</b>${p.weight_g != null ? ` <span class="hint num">${fmtG(p.weight_g)}</span>` : ''}
          ${p.sliced === false && plates.some(x => x.sliced !== false) ? '<span class="tag warn">gramy ručně</span>' : ''}</label>
        ${p.filaments.length ? p.filaments.map(f => `
        <div class="plate-fil">
          <span class="chip"><span class="dot" style="--c:${esc(f.color)}"></span>${filLabel(f)}</span>
          <span class="hint fil-vendor">${esc(profileName(f.settings_id) || f.vendor || '')}</span>
          <div class="unit-input" data-unit="g"><input type="text" inputmode="decimal" pattern="\\d*[.,]?\\d*" placeholder="0"
            data-g data-fil="${f.id}" value="${grams.get(`${p.index}:${f.id}`) ?? ''}" aria-label="Gramy, ${esc(plateLabel(p))}, ${filLabel(f)}"></div>
        </div>`).join('') : '<p class="hint">Na podložce nic není.</p>'}
        <div class="plate-fil plate-time">
          <span class="hint">Čas tisku</span>
          <div class="duration">
            <div class="unit-input" data-unit="h"><input type="text" inputmode="numeric" pattern="\\d*" placeholder="0" data-dur-h value="${t != null ? Math.floor(t / 60) || '' : ''}" aria-label="Hodiny, ${esc(plateLabel(p))}"></div>
            <div class="unit-input" data-unit="min"><input type="text" inputmode="numeric" pattern="\\d*" placeholder="0" data-dur-m value="${t != null ? t % 60 || '' : ''}" aria-label="Minuty, ${esc(plateLabel(p))}"></div>
          </div>
        </div>
      </div>
    </article>`;
  }).join('');

  const title = meta.title || file.filename.replace(/(\.gcode)?\.3mf$/i, '');
  imp.title = title;
  const sameName = state.projects.find(p => p.status !== 'done' && p.name.trim().toLowerCase() === title.trim().toLowerCase());
  const selected = reprint ? reprint.project_id : projectId ?? sameName?.id ?? (plates.length > 1 ? 'new' : null);
  const list = state.projects.filter(p => p.status !== 'done' || p.id === selected);
  $('#import-project').innerHTML = '<option value="">— žádný —</option>'
    + `<option value="new"${selected === 'new' ? ' selected' : ''}>+ Nový: ${esc(title)}</option>`
    + list.map(p => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}${p.status === 'done' ? ' (hotový)' : ''}</option>`).join('');

  $('#import-progress').hidden = true;
  $('#import-body').hidden = false;
  syncImport();
  // Většina projektů není naslicovaná → rovnou do prvního prázdného pole gramů.
  const empty = $$('#import-plates input[data-g]:not(:disabled)').find(i => !i.value);
  (empty ?? $('#import-submit')).focus();
}

const plateCards = () => $$('#import-plates .plate');
const plateGrams = card => $$('input[data-g]', card).map(i => ({ id: Number(i.dataset.fil), grams: round1(Number(i.value) || 0), input: i }));
const plateDuration = card => {
  const t = (Number($('[data-dur-h]', card).value) || 0) * 60 + (Number($('[data-dur-m]', card).value) || 0);
  return t > 0 ? t : null;
};

// Filamenty vybraných podložek (gramy sečtené přes podložky) a jejich rozdělení na cívky.
// Rezervace jiných naplánovaných tisků i gramy dřívějších řádků tohoto importu se odečítají.
function planImport() {
  const fils = new Map();
  for (const card of plateCards()) {
    if (!$('[data-plate-check]', card).checked) continue;
    const plate = imp.plates.find(p => p.index === Number(card.dataset.plate));
    for (const { id, grams } of plateGrams(card)) {
      const f = fils.get(id) ?? { ...plate.filaments.find(f => f.id === id), need: 0 };
      f.need = round1(f.need + grams);
      fils.set(id, f);
    }
  }
  const used = new Map();
  const avail = s => s.remaining - (s.reserved ?? 0) - (used.get(s.id) ?? 0);
  const list = [...fils.values()].sort((a, b) => a.id - b.id);
  for (const f of list) {
    if (imp.assign.has(f.id)) {
      f.spool = state.allSpools.find(s => s.id === imp.assign.get(f.id)) ?? null;
      f.weak = f.spool ? materialMatch(f.spool.material, f.type) === 1 : false;
    } else {
      const sug = suggestSpool(f, f.need, avail, imp.preferred.get(f.id));
      f.spool = sug?.spool ?? null;
      f.weak = sug?.weak ?? false;
      f.matched = !!sug;
    }
    f.parts = f.spool && f.need > 0 ? allocate(f.spool, f.need, avail) : [];
    f.fits = f.parts.every(p => p.grams <= round1(Math.max(0, avail(p.spool))));
    for (const p of f.parts) used.set(p.spool.id, (used.get(p.spool.id) ?? 0) + p.grams);
  }
  return list;
}

function filStatus(f) {
  const create = '<button type="button" class="btn small" data-create-spool>Založit novou cívku</button>';
  const weak = f.weak ? ` <span class="hint">(cívka je ${esc(f.spool.material)})</span>` : '';
  if (!f.spool) {
    return imp.assign.has(f.id) ? `<span class="hint">Vyberte cívku</span> ${create}`
      : `<span class="status warn">⚠ žádná cívka nesedí</span> ${create}`;
  }
  if (f.need <= 0) return '<span class="hint">doplňte gramy</span>';
  if (!f.fits) return `<span class="status warn">⚠ nestačí ani se stejnými cívkami</span>${weak} ${create}`;
  if (f.parts.length > 1) {
    return `<span class="status">rozdělí se na další stejnou cívku</span> <span class="hint num">${f.parts.map(p => fmtG(p.grams)).join(' + ')}</span>${weak}`;
  }
  return `<span class="status ok">✓ vejde se</span>${weak}`;
}

function syncImport() {
  if (!imp) return;
  let count = 0;
  for (const card of plateCards()) {
    const on = $('[data-plate-check]', card).checked;
    card.classList.toggle('off', !on);
    $$('input[data-g], [data-dur-h], [data-dur-m]', card).forEach(i => i.disabled = !on);
    const rows = plateGrams(card);
    rows.forEach(r => r.input.setCustomValidity(''));
    if (on) {
      count++;
      if (rows.length && !rows.some(r => r.grams > 0)) rows[0].input.setCustomValidity('Doplňte gramy alespoň u jednoho filamentu');
    }
  }

  const fils = planImport();
  const box = $('#import-filaments');
  const key = fils.map(f => f.id).join(',');
  if (key !== imp.rowsKey) {
    imp.rowsKey = key;
    box.innerHTML = fils.length ? fils.map(f => `
      <div class="fil-row" data-fil="${f.id}">
        <div class="fil-info">
          <span class="chip"><span class="dot" style="--c:${esc(f.color)}"></span>${filLabel(f)}</span>
          <span class="hint fil-vendor">${esc(filVendor(f))}</span>
        </div>
        <span class="fil-need num" data-need></span>
        <select data-fil-spool aria-label="Cívka pro ${filLabel(f)} ${esc(f.color)}"></select>
        <div class="fil-status" data-status></div>
      </div>`).join('') : '<p class="hint">Vyberte alespoň jednu podložku.</p>';
  }
  for (const f of fils) {
    const row = $(`.fil-row[data-fil="${f.id}"]`, box);
    $('[data-need]', row).textContent = f.need > 0 ? fmtG(f.need) : '— g';
    const sel = $('[data-fil-spool]', row);
    const value = String(f.spool?.id ?? '');
    if (sel.dataset.built !== state.allSpools.map(s => s.id).join(',') || sel.value !== value) {
      sel.innerHTML = spoolOptions(f.spool?.id ?? null);
      sel.dataset.built = state.allSpools.map(s => s.id).join(',');
    }
    sel.required = f.need > 0;
    $('[data-status]', row).innerHTML = filStatus(f);
  }
  const submit = $('#import-submit');
  submit.disabled = !count;
  submit.textContent = count ? `Naplánovat ${count} ${plural(count, 'tisk', 'tisky', 'tisků')}` : 'Naplánovat';
}

// Tělo POST /api/prints/import: rozdělení filamentu na cívky (planImport) se rozpočítá na podložky
// v pořadí, takže jedna podložka může mít víc řádků spotřeby.
function importBody() {
  const fils = planImport();
  const queues = new Map(fils.map(f => [f.id, f.parts.map(p => ({ id: p.spool.id, grams: p.grams }))]));
  const multi = imp.plates.length > 1;
  const prints = [];
  for (const card of plateCards()) {
    if (!$('[data-plate-check]', card).checked) continue;
    const plate = imp.plates.find(p => p.index === Number(card.dataset.plate));
    const usages = new Map();
    for (const { id, grams } of plateGrams(card)) {
      const queue = queues.get(id) ?? [];
      let rest = grams;
      let last = null;
      while (rest > 0 && queue.length) {
        const part = queue[0];
        const take = round1(Math.min(rest, part.grams));
        usages.set(part.id, round1((usages.get(part.id) ?? 0) + take));
        last = part.id;
        part.grams = round1(part.grams - take);
        rest = round1(rest - take);
        if (part.grams <= 0) queue.shift();
      }
      // Zaokrouhlovací zbytek (desetiny gramu) na poslední použitou cívku.
      if (rest > 0 && last != null) usages.set(last, round1(usages.get(last) + rest));
    }
    prints.push({
      plate_index: plate.index,
      name: imp.names.get(plate.index) ?? (multi ? `${imp.title} – ${plate.name || `podložka ${plate.index}`}` : imp.title),
      duration_min: plateDuration(card),
      usages: [...usages].map(([spool_id, grams]) => ({ spool_id, grams })),
    });
  }
  const project = $('#import-project').value;
  return {
    file_id: imp.file.id,
    project_id: project && project !== 'new' ? Number(project) : null,
    new_project_name: project === 'new' ? imp.title : null,
    prints,
  };
}

importForm.addEventListener('input', e => {
  if (e.target.matches('input[data-g], [data-plate-check]')) syncImport();
});
importForm.addEventListener('change', e => {
  if (e.target.matches('[data-plate-check]')) {
    syncImport();
    if (e.target.checked) $$('input[data-g]', e.target.closest('.plate')).find(i => !i.value)?.focus();
  }
  if (e.target.matches('[data-fil-spool]')) {
    imp.assign.set(Number(e.target.closest('.fil-row').dataset.fil), Number(e.target.value) || null);
    syncImport();
  }
});
// Enter v poli gramů skočí na další prázdné pole; formulář odešle až u posledního.
importForm.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('input[data-g]')) return;
  const inputs = $$('#import-plates input[data-g]:not(:disabled)');
  const next = inputs.slice(inputs.indexOf(e.target) + 1).find(i => !i.value);
  if (next) { e.preventDefault(); next.focus(); }
});
importForm.addEventListener('click', e => {
  if (!e.target.closest('[data-create-spool]')) return;
  const filId = Number(e.target.closest('.fil-row').dataset.fil);
  const fil = imp.plates.flatMap(p => p.filaments).find(f => f.id === filId);
  openSpoolForm(null, {
    prefill: {
      brand: fil.vendor && fil.vendor !== 'Generic' ? fil.vendor : '',
      material: fil.type ?? '',
      color_hex: /^#[0-9a-f]{6}$/i.test(fil.color ?? '') ? fil.color.toLowerCase() : '#e8743b',
    },
    onSaved: spool => {
      if (!imp || !spool) return;
      imp.assign.set(filId, spool.id);
      syncImport();
    },
  });
});

importDialog.addEventListener('close', async () => {
  importXhr?.abort();
  if (importDialog.returnValue !== 'save' || !imp) return;
  const body = importBody();
  try {
    const res = await api('/prints/import', { method: 'POST', body });
    const n = res.prints?.length ?? body.prints.length;
    toast(`Naplánováno: ${n} ${plural(n, 'tisk', 'tisky', 'tisků')}`);
    imp = null;
    await refresh();
    setTab('inventory');
    scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) { toast(err.message, true); importDialog.showModal(); }
});

function pickImportFile(options = {}) {
  importOptions = options;
  importFileInput.value = '';
  importFileInput.click();
}

importFileInput.addEventListener('change', () => {
  const file = importFileInput.files[0];
  if (!file) return;
  // Import z formuláře nového tisku ho nahradí.
  if (printDialog.open) { printReturnProject = null; printDialog.close('cancel'); }
  startImport(file);
});
$('#import-3mf').addEventListener('click', () => pickImportFile());
$('#print-import').addEventListener('click', () => {
  const project = projectSelect.value;
  pickImportFile({ projectId: project && project !== 'new' ? Number(project) : null });
});

// Přetažení .3mf kamkoli do okna (jen když není otevřené jiné okno než nový tisk).
let dragDepth = 0;
const draggingFiles = e => e.dataTransfer?.types.includes('Files');
addEventListener('dragenter', e => {
  if (!draggingFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
addEventListener('dragleave', e => {
  if (!draggingFiles(e) || --dragDepth > 0) return;
  dragDepth = 0;
  document.body.classList.remove('dropping');
});
addEventListener('dragover', e => { if (draggingFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const file = [...e.dataTransfer.files].find(f => /\.3mf$/i.test(f.name));
  if (!file) return toast('Přetáhněte projekt z Bambu Studia (.3mf)', true);
  if ($$('dialog[open]').some(d => d !== printDialog || editingPrint)) return toast('Nejdřív zavřete otevřené okno', true);
  if (printDialog.open) { printReturnProject = null; printDialog.close('cancel'); }
  startImport(file);
});

// Vytisknout znovu: ze souboru přes import (jen ta podložka), bez souboru jako kopie ve formuláři.
async function reprint(print) {
  if (print.file_id) {
    openImportShell('Načítám soubor…');
    setUploadProgress(1, 0);
    try {
      const file = await api(`/files/${print.file_id}`);
      if (file.meta.plates.some(p => p.index === print.plate_index)) {
        if (importDialog.open) showImport(file, { reprint: print });
        return;
      }
      importDialog.close('cancel');
    } catch (err) {
      importDialog.close('cancel');
      toast(err.message, true);
    }
  }
  openPrintForm(null, { copyOf: print });
}

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
  if (state.tab !== tab) scrollTo(0, 0);
  state.tab = tab;
  document.body.dataset.tab = tab;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  history.replaceState(null, '', `#${tab}`);
}
$('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
const tabFromHash = () => { const t = location.hash.slice(1); setTab(TABS.includes(t) ? t : 'inventory'); };
addEventListener('hashchange', tabFromHash);
tabFromHash();

loadSettings().then(refresh).catch(err => toast(err.message, true));

// Aplikace na ploše se po návratu jen „probudí“ ve stavu, ve kterém zůstala. Data mezitím mohlo
// změnit jiné zařízení (třeba import na Macu), proto se po návratu načtou znovu — ne ale
// uprostřed rozepsaného formuláře.
let lastRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastRefresh < 30_000) return;
  if ($$('dialog[open]').length) return;
  lastRefresh = Date.now();
  refresh().catch(() => {});
});
