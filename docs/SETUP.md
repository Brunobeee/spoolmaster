# Instalace a nasazení

## Lokální vývoj

Potřebuješ Node.js 22.13 nebo novější (kvůli vestavěnému `node:sqlite`).

```bash
npm install
npm run dev
```

Aplikace běží na http://localhost:3420, data jsou v `data/spoolmaster.db`.

| Proměnná | Výchozí | Význam |
| --- | --- | --- |
| `PORT` | `3420` | port serveru |
| `SPOOLMASTER_DB` | `data/spoolmaster.db` | cesta k databázi |

## Nasazení na NAS (UGREEN UGOS, aplikace Docker)

Image se staví automaticky přes GitHub Actions při každém pushi do `main`
a publikuje se jako `ghcr.io/brunobeee/spoolmaster` (amd64 i arm64).

### Poprvé

1. Na NASu vytvoř složku pro projekt, např. `docker/spoolmaster`.
2. V aplikaci **Docker** otevři **Projekt → Vytvořit**, jako cestu zvol tu složku
   a vlož obsah [`docker-compose.yml`](../docker-compose.yml).
3. Spusť projekt. Aplikace poběží na `http://<IP-NASu>:3420`.

Data (databáze, později i 3MF soubory) jsou ve složce `data/` uvnitř projektové složky.
Tu zahrň do zálohy NASu. Rychlou ruční zálohu stáhneš v aplikaci přes **Nastavení → Exportovat databázi**.

### Aktualizace

1. Push do `main` → počkej, až doběhne GitHub Action „Docker image“.
2. V aplikaci Docker u projektu zvol znovu stáhnout image a restartovat
   (nebo přes SSH: `docker compose pull && docker compose up -d`).

Databáze se při startu sama zmigruje na novou verzi schématu. Když je co migrovat, uloží se
nejdřív kopie do `data/backups/spoolmaster-<čas>-v<stará verze>.db` (drží se posledních 10).
Kdyby migrace selhala, kontejner nenaběhne a data zůstanou beze změny; obnova = zastavit
kontejner, smazat `spoolmaster.db-wal` a `-shm`, zálohu přejmenovat na `data/spoolmaster.db`
a nasadit předchozí image.

### Když NAS image nestáhne

GitHub zakládá balíček v GHCR někdy jako soukromý. V GitHubu otevři
**Profil → Packages → spoolmaster → Package settings → Change visibility → Public**.

## Přenos dat z Macu

Zastav kontejner, zkopíruj `data/spoolmaster.db` z Macu do `data/` na NASu a kontejner znovu spusť.
