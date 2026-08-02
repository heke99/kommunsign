# Exakta kommandon – synk, migration, lokal körning och deployment

## Synka patchen utan att skapa en dubbel `kommunsign/kommunsign`-mapp

```bash
set -euo pipefail

rm -rf /tmp/kommunsign-production-onboarding
mkdir -p /tmp/kommunsign-production-onboarding
unzip ~/Downloads/kommunsign-production-onboarding-patch.zip \
  -d /tmp/kommunsign-production-onboarding

rsync -av \
  --exclude='.git/' \
  --exclude='.env' \
  /tmp/kommunsign-production-onboarding/kommunsign/ \
  /Users/hekmath/Projects/kommunsign/

cd /Users/hekmath/Projects/kommunsign
npm ci
npm run verify
```

Använd inte `--delete` vid patchsynk.

## Databasmigrationer

Sätt riktiga anslutningssträngar i den aktuella terminalsessionen eller secret manager. Kör sedan:

```bash
set -euo pipefail
cd /Users/hekmath/Projects/kommunsign

export CONTROL_DATABASE_URL='postgresql://...'
export DATA_DATABASE_URL='postgresql://...'

npm run verify:migrations
npm run db:migrate
npm run db:verify

psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f migrations/control/verify_domain_gateway.sql
```

Kör först i en tom eller stagingklassad databas. Ändra inte redan körda migrationer.

## Lokal utveckling

```bash
set -euo pipefail
cd /Users/hekmath/Projects/kommunsign

test -f .env || cp .env.example .env
npm ci
npm run db:up
npm run db:migrate
npm run db:verify
npm run dev
```

## Produktionsverifiering före deploy

```bash
set -euo pipefail
cd /Users/hekmath/Projects/kommunsign

npm ci
npm run verify
npm run package:release
sha256sum release/kommunsign-source.zip
```

## Vercel – projekt, statiska portaler och domäner

Installera eller använd aktuell Vercel CLI via `npx`. Kommandona nedan skapar/länkar projekt; de ska köras med rätt team-scope.

```bash
cd /Users/hekmath/Projects/kommunsign
npm ci
npm run web:build
npm run portal:build

npx vercel project add kommunsign-public
npx vercel link --yes --project kommunsign-public
npx vercel deploy --prod
npx vercel domains add kommunsign.se kommunsign-public
npx vercel domains add www.kommunsign.se kommunsign-public
```

Statiska portaler:

```bash
cd /Users/hekmath/Projects/kommunsign

npx vercel project add kommunsign-onboarding
(
  cd build/portals/onboarding-portal
  npx vercel link --yes --project kommunsign-onboarding
  npx vercel deploy --prod
)
npx vercel domains add apply.kommunsign.se kommunsign-onboarding

npx vercel project add kommunsign-platform-admin
(
  cd build/portals/platform-admin
  npx vercel link --yes --project kommunsign-platform-admin
  npx vercel deploy --prod
)
npx vercel domains add admin.kommunsign.se kommunsign-platform-admin

npx vercel project add kommunsign-verification
(
  cd build/portals/verification-portal
  npx vercel link --yes --project kommunsign-verification
  npx vercel deploy --prod
)
npx vercel domains add verify.kommunsign.se kommunsign-verification
```

Skapa inte `kommunsign-auth` eller `kommunsign-tenant-gateway` som skarpa projekt förrän respektive HTTP-entrypoint, callbackroutes och same-origin BFF är färdigställda. Manifestet i `infrastructure/vercel/projects.json` beskriver den avsedda slutstrukturen men är inte i sig en deployment.

## Git och merge till main

```bash
set -euo pipefail
cd /Users/hekmath/Projects/kommunsign

git status --short
git switch fix/kommunsign-production-onboarding
npm ci
npm run verify

git add .
git commit -m "Implement production tenant onboarding and domain architecture"
git push -u origin fix/kommunsign-production-onboarding

git switch main
git pull --ff-only origin main
git merge --no-ff fix/kommunsign-production-onboarding
npm ci
npm run verify
git push origin main
```
