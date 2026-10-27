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
- Zůstatek se **neukládá**, počítá se v `SPOOL_SELECT`: initial − Σ usages (bez planned) + Σ adjustments;
  `reserved` = Σ usages naplánovaných tisků. Smazání/úprava tisku tak gramy automaticky vrátí.
- Ceny počítá `PRINT_SELECT` živě z ceny cívky a nastavení: filament NULL, když některá cívka
  nemá cenu; elektřina = čas × příkon × Kč/kWh × percent.

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
- Nastavení: Kč/kWh, příkon tiskárny, hranice „dochází“, výchozí hmotnost prázdné cívky, export DB.

## Fáze
1. ✅ Docker + GitHub Actions + nasazení na NAS, verzované migrace, Nastavení
2. ✅ Projekty, fronta naplánovaných tisků, cena (filament + elektřina), rezervace
3. Import 3MF (podložky, gramáž, čas, náhledy), párování s cívkami, „vytisknout znovu“
4. PWA (manifest + ikona, bez offline) a doladění mobilu
