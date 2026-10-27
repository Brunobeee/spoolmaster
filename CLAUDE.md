# SpoolMaster

Webová aplikace pro evidenci inventáře filamentu pro 3D tisk. Uživatel si vede cívky
(značka, materiál, barva, hmotnost) a ke každému tisku zapíše spotřebu v gramech —
ta se odečte z cívky. Podporuje vícebarevné tisky (víc cívek na jeden tisk) a korekci
zůstatku převážením cívky.

## Stack
- Node.js ≥ 22.13 (vestavěný `node:sqlite`), Express 5, bez build kroku
- Frontend: čisté HTML/CSS/JS v `public/` (ES moduly, `<dialog>`), UI česky
- Data: SQLite v `data/spoolmaster.db` (v `.gitignore`), cesta jde přepsat `SPOOLMASTER_DB`

## Spuštění
- `npm install && npm start` → http://localhost:3420 (`PORT` přepíše port)
- `npm run dev` restartuje server při změně

## Datový model (`db.js`)
- Schéma jen přes `MIGRATIONS` (nová migrace na konec, stávající neměnit); během migrací jsou
  cizí klíče vypnuté kvůli přestavbám tabulek.
- `spools` – cívky; `initial_weight` = čistá hmotnost filamentu, `spool_weight` = prázdná cívka (tára)
- `prints` (`status` planned/ok/failed, `percent`, `duration_min`, `project_id`) + `print_usages`
- `projects` – skupiny tisků (active/done)
- `adjustments` – ruční korekce (převážení); `settings` – key/value nastavení
- `files` – nahrané 3MF (sha256 unikátní, `meta` = JSON rozboru); tisk má `file_id` + `plate_index`.
  Soubory na disku vedle DB: `files/<id>.3mf` a náhledy `files/<id>-<podložka>.png` (`FILES_DIR` v db.js).
- Zůstatek se **neukládá**, počítá se v `SPOOL_SELECT`: initial − Σ usages (bez planned) + Σ adjustments;
  `reserved` = Σ usages naplánovaných tisků. Smazání/úprava tisku tak gramy automaticky vrátí.
  Při mazání proběhlého tisku se UI ptá: vrátit filament (chybný záznam), nebo ponechat odečtený
  (`DELETE /api/prints/:id?keep=1` převede spotřebu na korekce „Smazaný tisk: …“).
- Ceny počítá `PRINT_SELECT` živě (v USD) z ceny a měny cívky, kurzu a nastavení: filament NULL,
  když některá cívka nemá cenu; elektřina = čas × příkon × Kč/kWh ÷ kurz USD × percent.

## Rozhodnutí (odsouhlaseno 2026-10-27)

**Provoz**
- Jediný uživatel, bez přihlašování, jen v domácí síti.
- Docker na NASu UGREEN (UGOS, výchozí Docker app) přes `docker-compose.yml`.
- Veřejné repo `Brunobeee/spoolmaster`; GitHub Actions staví multi-arch image (amd64 + arm64) do `ghcr.io`.
- Data (DB + 3MF soubory) v jednom připojeném volume, zálohuje NAS; v Nastavení export DB ke stažení.
- Schéma se mění jen verzovanými migracemi (`PRAGMA user_version`), data musí přežít aktualizaci.

**Tisky a 3MF** (Bambu Lab X1C s AMS, Bambu Studio)
- Nahrává se projektový `.3mf`; čte se z něj seznam podložek, gramáž po filamentech, odhad času a náhled.
  Když chybí data ze slicování: soubor uložit, upozornit, gramy zadat ručně.
- Jedna podložka = jeden tisk; při importu se vybírá, které podložky se tiskly.
- Fronta: import vytvoří tisk ve stavu „naplánováno“ (nic neodečítá). Na mobilu Hotovo / Selhalo;
  Selhalo → „vytištěno %“, gramáž se poměrně přepočítá a jde ručně upravit.
- Naplánované tisky nahoře na úvodní obrazovce (jen když existují). Cívka ukazuje rezervaci
  z naplánovaných tisků a varuje při přečerpání; skutečný zůstatek se mění až po potvrzení.
- Párování filamentu s cívkou podle barvy + materiálu. Ze shodných cívek: načatá s nejmenším zůstatkem,
  na kterou se tisk vejde; když žádná, ta s největším zůstatkem + varování. Bez shody: nabídnout
  „Založit novou cívku“ (předvyplněno z 3MF), nebo ruční výběr.
- „Vytisknout znovu“ = nový naplánovaný tisk se stejnou podložkou a gramáží, cívky navrženy znovu
  (původní mají přednost, pokud stačí).

**Projekty a cena**
- Projekt = samostatná položka (název, poznámka, stav rozpracovaný/hotový, hotové jdou skrýt).
  Tisky se do něj přiřazují; při importu: existující / nový podle názvu souboru / žádný.
- Projekt ukazuje celkovou gramáž a cenu, nepovedené tisky se započítají a ukážou zvlášť.
- Cena tisku = filament (cena cívky / hmotnost) + elektřina zvlášť (čas × příkon × Kč/kWh).
  Bez ceny cívky „cena neznámá“, nikdy 0 Kč.
- **Hlavní měna je USD** (filament se kupuje hlavně v zahraničí). Cívka má měnu USD (výchozí) / EUR / CZK;
  všechny ceny se přepočítají na USD a vedle se ukáže orientační přepočet na Kč. Kurzy: denní lístek ČNB
  (`rates.js`, tabulka `exchange_rates`, obnova každých 6 h, offline poslední známý kurz).
- Čísla jde zadávat s desetinnou čárkou: pole jsou `type="text" inputmode="decimal"`, čárka se při
  psaní mění na tečku a server (`toNum`) čárku přijme také.
- Nastavení: Kč/kWh, příkon tiskárny, hranice „dochází“, výchozí hmotnost prázdné cívky, export DB.

**Stejné cívky**
- Každá fyzická cívka je vlastní záznam (vlastní zůstatek), žádný „profil filamentu“ v DB.
- Inventář slučuje stejné cívky (značka + materiál + název barvy + průměr + hmotnost, `groupKey`)
  do jedné karty „×N“ s celkovým zůstatkem; detail skupiny vypíše jednotlivé cívky
  (načatá / neotevřená = bez spotřeby i korekcí). Načaté se řadí a nabízejí první.
- Formulář tisku: když se gramáž na vybranou cívku nevejde (`availableOn` počítá i rezervace
  a řádky formuláře), zbytek se automaticky rozdělí na další stejné cívky (`autoSplit`, při
  změně pole i při odeslání).
- Prázdné cívky (zůstatek ≤ 0 a bez rezervace) nejsou v aktivním inventáři ani v přehledu; ukazuje je
  filtr „Archiv a prázdné“ (`ACTIVE_SPOOL` v server.js). Je to odvozené, ne uložené — smazání tisku
  cívku vrátí mezi aktivní.
- „+ Přidat stejnou“ (detail cívky i skupiny) = `POST /api/spools/:id/duplicate` s počtem kusů
  a volitelně jinou cenou; nové cívky jsou plné.

## Fáze
1. ✅ Docker + GitHub Actions + nasazení na NAS, verzované migrace, Nastavení
2. ✅ Projekty, fronta naplánovaných tisků, cena (filament + elektřina), rezervace
3. ✅ Import 3MF (podložky, gramáž, čas, náhledy), párování s cívkami, „vytisknout znovu“
4. PWA (manifest + ikona, bez offline) a doladění mobilu

## Import 3MF (`threemf.js`, `POST /api/files`, `POST /api/prints/import`)
- Rozbaluje se jen `Metadata/*.config` a náhledy podložek (projekty mají i 380MB model uvnitř).
- Podložky z `model_settings.config` (`plater_id`, `plater_name`, objekty → `extruder` = 1-based filament),
  filamenty projektu z `project_settings.config` (paralelní pole), gramy/čas ze `slice_info.config`
  (`<plate>` → `prediction` s, `<filament id used_g>`), jen když je projekt uložený po slicování.
  Uživatel projekty obvykle ukládá bez slicování → import předvyplní podložky a filamenty, gramy ručně.
- Párování filament → cívka a rozdělení přes stejné cívky na klientu (`suggestSpool`, `allocate`).
- Uploadnuté soubory se zatím nemažou.
