# Synkronisering av KommunSign-leveransen

Patchen innehåller endast ändrade och tillagda filer och har roten `kommunsign/`. Den använder inte `--delete` och skriver inte över `.git`, `.env`, certifikat eller genererade kataloger.

## Patch över befintligt repository

```bash
set -euo pipefail

PROJECT="/Users/hekmath/Projects/kommunsign"
PATCH="/Users/hekmath/Downloads/kommunsign-production-onboarding-patch.zip"

test -d "$PROJECT/.git"
test -f "$PATCH"

cd "$PROJECT"
ROOT="$(git rev-parse --show-toplevel)"
test "$ROOT" = "$PROJECT"
git remote -v
git status --short
git branch --show-current

if git show-ref --verify --quiet refs/heads/fix/kommunsign-production-onboarding; then
  git checkout fix/kommunsign-production-onboarding
else
  git checkout -b fix/kommunsign-production-onboarding
fi

BACKUP="${PROJECT}-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$PROJECT" "$BACKUP"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
unzip -q "$PATCH" -d "$TMP_DIR"

PATCH_ROOT="$TMP_DIR/kommunsign"
test -d "$PATCH_ROOT"

rsync -av \
  --exclude ".git" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "node_modules" \
  --exclude "build" \
  --exclude "dist" \
  --exclude ".next" \
  --exclude ".turbo" \
  --exclude "local-certs" \
  "$PATCH_ROOT/" \
  "$PROJECT/"

cd "$PROJECT"
npm ci
npm run verify
npm run web:build
npm run sbom
git status --short
```

## Databassynk i lokal/staging

```bash
cd /Users/hekmath/Projects/kommunsign
cp -n .env.example .env
npm run db:up
npm run db:migrate
npm run db:verify
```

Kör endast nya, ej journalförda migrationer i en etablerad miljö. Äldre migrationer har inte skrivits om. Den nya onboardingmigrationen är:

```text
migrations/control/0006_onboarding_and_activation.sql
```

## Lokal start

```bash
npm run dev
```

API kör på `8787`, public website `3000`, platform admin `3001`, tenantportal `3002`, signerportal `3003`, verifieringsportal `3004` och onboardingportal `3005`.

## Vercel

Den befintliga rootkonfigurationen bygger endast den publika webbplatsen. Onboardingportal och övriga frontendappar ska få separata Vercel-projekt/root directories enligt målarkitekturen. Backend, workers och Java-tjänster ska deployas som containers.

## Komplett zip

Det kompletta paketet används för granskning, ny klon eller återställning. Synka aldrig ett komplett paket med `rsync --delete` mot ett aktivt repository utan manuell granskning av lokala filer och hemligheter.
