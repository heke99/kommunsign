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

npm ci
npm run env:local:init
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

## Vercel – ett projekt för alla portaler

```bash
set -euo pipefail
cd /Users/hekmath/Projects/kommunsign

npm ci
npm run build:vercel

# Skapar projektet interaktivt om det inte redan finns.
npx vercel project add
npx vercel link --yes --project kommunsign-web
npx vercel deploy --prod

for domain in \
  kommunsign.se \
  www.kommunsign.se \
  apply.kommunsign.se \
  admin.kommunsign.se \
  auth.kommunsign.se \
  app.kommunsign.se \
  sign.kommunsign.se \
  verify.kommunsign.se \
  '*.kommunsign.se'
do
  npx vercel domains add "$domain" kommunsign-web
done
```

Kör `npx vercel domains inspect <domän>` för att få korrekt DNS-instruktion för varje domän. Wildcarddomänen kan kräva Vercels nameservers. `api.kommunsign.se` och `hooks.kommunsign.se` läggs inte i webprojektet utan pekas mot runtime-deploymenten.

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
