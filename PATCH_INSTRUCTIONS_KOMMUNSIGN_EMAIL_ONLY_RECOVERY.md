# Kommunsign – e-postbaserad lösenordsåterställning

## Grundorsaker

1. Vercel-portalen anropar `https://api.kommunsign.se/v1/auth/password/forgot`.
2. Den tidigare Railway-backenden kallade `resolveDestination(...)` innan Supabase Auth fick skicka återställningsmejlet. På `app.kommunsign.se` krävde detta en `organizationSlug`, vilket gjorde e-postbaserad återställning omöjlig.
3. POST-anropet använder JSON och egna headers. Webbläsaren gör därför en CORS-preflight till Railway. Om `https://app.kommunsign.se` inte finns i Railway-tjänstens tillåtna origins blockeras anropet innan POST körs.
4. Frontend fångade nätverks-, DNS- och CORS-fel och visade alltid samma generiska text.
5. Supabase Auth Site URL var felaktigt satt till `https://app.kommunsign.se/login/`. Eftersom e-postmallen lägger till `/aterstall/` kunde länkmålet bli `/login/aterstall/` i stället för den verkliga Vercel-routen `/aterstall/`.

## Ändringar

- Glömt lösenord kräver endast e-post.
- Railway skickar återställningsmejlet utan att först kräva organisation.
- Återställningslänken går till `https://app.kommunsign.se/aterstall/`.
- Efter verifierad Supabase-token slår Railway upp användarens aktiva plattforms- eller organisationsbehörighet och väljer korrekt destination.
- Railway har säkra standard-origins för Kommunsigns Vercel-domäner även om en CORS-variabel saknas.
- Frontend visar nu om API, DNS, CORS, Supabase Auth eller redirect-konfiguration är problemet.
- Supabase Site URL är låst till domänroten och verifieringsskriptet avvisar sökvägar som `/login/`.

## Synka

```bash
rm -rf /tmp/kommunsign-email-recovery-fix && \
mkdir -p /tmp/kommunsign-email-recovery-fix && \
unzip -o "/Users/hekmath/Downloads/kommunsign-email-only-recovery-changed-files.zip" \
  -d /tmp/kommunsign-email-recovery-fix && \
rsync -avh --progress \
  /tmp/kommunsign-email-recovery-fix/ \
  "/Users/hekmath/Projects/kommunsign/"
```

## Verifiera och driftsätt

```bash
cd "/Users/hekmath/Projects/kommunsign"
npm ci
npm run verify
git status
git add \
  FILE_MANIFEST.sha256 \
  apps/auth-portal/public/app.js \
  apps/auth-portal/public/index.html \
  apps/api/server.mjs \
  apps/api/src/production-adapters/postgres/authentication-repository.ts \
  scripts/supabase-auth-config-lib.mjs \
  infrastructure/railway/shared.runtime.env.example \
  docs/api/openapi.yaml \
  docs/operations/supabase-auth-email.md \
  ACCOUNT_PRODUCTION_SETUP.md \
  PRODUCTION_CHECKLIST.md \
  .env.example \
  .env.production.template \
  tests/run.mjs
git commit -m "fix(auth): make password recovery email-only across Vercel and Railway"
git push origin main
```

Vercel måste driftsätta auth-portalen och Railway måste bygga om API-tjänsten från samma commit.

## Railway-variabler

```env
CORS_ALLOWED_ORIGINS=https://kommunsign.se,https://app.kommunsign.se,https://admin.kommunsign.se
STATIC_ALLOWED_ORIGINS=https://kommunsign.se,https://app.kommunsign.se,https://admin.kommunsign.se
TENANT_DISCOVERY_URL=https://app.kommunsign.se
AUTH_BROKER_URL=https://app.kommunsign.se/login/
PLATFORM_ADMIN_URL=https://admin.kommunsign.se
SUPABASE_AUTH_PROJECT_URL=https://<project-ref>.supabase.co
SUPABASE_AUTH_ANON_KEY=<publishable-or-anon-key>
SUPABASE_AUTH_SERVICE_ROLE_KEY=<service-role-key>
```

## Supabase Auth

Site URL:

```text
https://app.kommunsign.se
```

Använd inte `/login/` som Site URL. Mallarna skapar själva länkarna till `/aktivera/` och `/aterstall/`.

Tillåtna redirect-adresser:

```text
https://app.kommunsign.se/aktivera/
https://app.kommunsign.se/aterstall/
```

Custom SMTP måste vara aktivt och Resend-domänen verifierad. Supabase Auth skickar mejlet, medan Kommunsigns vanliga Resend-provider används för övriga produktmejl.

## Produktionskontroll

```bash
curl -i https://api.kommunsign.se/health/ready

curl -i -X OPTIONS \
  https://api.kommunsign.se/v1/auth/password/forgot \
  -H 'Origin: https://app.kommunsign.se' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-request-id,idempotency-key'
```

OPTIONS-svaret ska innehålla:

```text
access-control-allow-origin: https://app.kommunsign.se
access-control-allow-credentials: true
```
