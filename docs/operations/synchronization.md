# Synkronisering av leveransen

## Patch över befintligt repository

Packa upp patchen direkt över repositoryts rot:

```bash
unzip -q kommunsign-patch-2026-08-02.zip -d /sökväg/till/kommunsign
cd /sökväg/till/kommunsign
npm ci
npm run verify
npm run sbom
npm run provenance:report
```

Patchpaketet raderar inga filer. Granska `CHANGED_FILES.txt` och `git diff` före commit.

## Ersätt med komplett repository

```bash
unzip -q kommunsign-hardened-2026-08-02.zip -d /tmp/kommunsign-release
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='node_modules/' \
  /tmp/kommunsign-release/kommunsign-main/ /sökväg/till/kommunsign/
cd /sökväg/till/kommunsign
npm ci
npm run verify
```

## Databassynk

Ta backup, stoppa inkompatibla writers och kör först i staging:

```bash
for file in migrations/control/[0-9]*.sql; do
  psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

for file in migrations/data/[0-9]*.sql; do
  psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/data/verify.sql
```

Kör inte SQL-filerna genom att välja enbart de senaste manuellt i en okänd miljö. Använd en migrationsjournal i den riktiga deployment-pipelinen så att redan tillämpade migrationer hoppas över deterministiskt.
