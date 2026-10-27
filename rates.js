import { db, RATE_FALLBACK } from './db.js';

// Denní kurzy ČNB (Kč za jednotku měny), ukládané do DB, aby ceny šly spočítat i offline.
const CNB_URL = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt';
const CURRENCIES = ['USD', 'EUR'];
const REFRESH_MS = 6 * 60 * 60 * 1000;

export function getRates() {
  const rows = db.prepare('SELECT currency, czk_per_unit, rate_date, fetched_at FROM exchange_rates').all();
  const byCode = Object.fromEntries(rows.map(r => [r.currency, r]));
  const complete = CURRENCIES.every(c => byCode[c]);
  return {
    USD: byCode.USD?.czk_per_unit ?? RATE_FALLBACK.USD,
    EUR: byCode.EUR?.czk_per_unit ?? RATE_FALLBACK.EUR,
    date: complete ? byCode.USD.rate_date : null,
    fetched_at: complete ? byCode.USD.fetched_at : null,
    source: complete ? 'cnb' : 'fallback',
  };
}

// Formát lístku: "27.10.2026 #208", hlavička, pak řádky "USA|dolar|1|USD|23,145".
function parseCnb(text) {
  const lines = text.trim().split('\n');
  const [, day, month, year] = lines[0].match(/^(\d{2})\.(\d{2})\.(\d{4})/) ?? [];
  if (!year) throw new Error('Neznámý formát kurzovního lístku ČNB');
  const rates = {};
  for (const line of lines.slice(2)) {
    const [, , amount, code, rate] = line.split('|');
    if (CURRENCIES.includes(code)) rates[code] = Number(rate.replace(',', '.')) / Number(amount);
  }
  if (!CURRENCIES.every(c => rates[c] > 0)) throw new Error('Na lístku ČNB chybí USD nebo EUR');
  return { date: `${year}-${month}-${day}`, rates };
}

export async function refreshRates() {
  const res = await fetch(CNB_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ČNB vrátila ${res.status}`);
  const { date, rates } = parseCnb(await res.text());
  const stmt = db.prepare(`
    INSERT INTO exchange_rates (currency, czk_per_unit, rate_date, fetched_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(currency) DO UPDATE SET czk_per_unit = excluded.czk_per_unit,
      rate_date = excluded.rate_date, fetched_at = excluded.fetched_at`);
  for (const [code, rate] of Object.entries(rates)) stmt.run(code, rate, date);
  return getRates();
}

export function scheduleRateRefresh() {
  const tick = () => refreshRates().catch(err => console.warn(`Kurzy ČNB se nepodařilo stáhnout: ${err.message}`));
  tick();
  setInterval(tick, REFRESH_MS).unref();
}
