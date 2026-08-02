# Synkronisering av leveransen

## Rekommenderat: patch över befintligt repository

Patchen innehåller endast ändrade och tillagda filer och raderar ingenting.

```bash
set -euo pipefail

PROJECT=/Users/hekmath/Projects/kommunsign
PATCH=/Users/hekmath/Downloads/kommunsign-patch-20260802.zip

cd "$PROJECT"
test "$(git rev-parse --show-toplevel)" = "$PROJECT"
git remote -v
git status --short

BACKUP="${PROJECT}-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$PROJECT" "$BACKUP"

TMP_DIR=$(mktemp -d)
unzip -q "$PATCH" -d "$TMP_DIR"

test -d "$TMP_DIR/kommunsign"
rsync -av \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.env.*.local' \
  --exclude='node_modules/' \
  --exclude='build/' \
  --exclude='dist/' \
  --exclude='local-certs/' \
  "$TMP_DIR/kommunsign/" \
  "$PROJECT/"

rm -rf "$TMP_DIR"

cd "$PROJECT"
npm ci --ignore-scripts
npm run verify
npm run web:build
npm run sbom
git status --short
```

Avbryt innan `rsync` om Git-roten inte är exakt `/Users/hekmath/Projects/kommunsign`.

## Databassynk i lokal/stagingmiljö

Starta lokala dependencies och kör alla migrationer genom de versionsordnade skripten:

```bash
cd /Users/hekmath/Projects/kommunsign
cp -n .env.example .env
npm run db:up
npm run db:migrate
npm run db:verify
```

Migrationerna `migrations/control/0005_auth_domain_and_break_glass_runtime.sql` och `migrations/data/0011_upload_notification_and_invitation_runtime.sql` är nya och additiva. Äldre migrationer har inte skrivits om i denna leverans. I en riktig produktionspipeline måste en migrationsjournal användas så att redan körda filer hoppas över deterministiskt.

## Komplett zip

Det kompletta paketet är avsett för jämförelse, ny klon eller återställning. Kör inte `rsync --delete` mot ett aktivt repository utan manuell granskning eftersom lokala, icke versionshanterade filer kan finnas.
