# Kommunsign

Kommunsign är en organisationsseparerad och varumärkesanpassningsbar plattform för ansökningsstyrd anslutning, digitala godkännanden och BankID-baserad avancerad elektronisk underskrift för svensk offentlig sektor.

Repositoryt innehåller produktionsimplementationen för den första BankID-fasen: privat PDF-uppladdning, säker dokumentbearbetning, PDF/A-2b, TIC BankID, fristående kryptografiska bevis, evidenspaket, e-postleverans, administratörsstyrda konton och stängd lösenordsinloggning.

## Kontomodell

Kommunsign har ingen publik registrering.

1. En organisation skickar en ansökan via `kommunsign.se/ansok/`, eller så skapar plattformens superadmin organisationen direkt i organisationsvyn.
2. Den ordinarie ansökningsvägen granskas innan provisionering; direkt skapande är reserverat för `platform_super_admin`.
3. Tenant, standardroller, signeringspolicyer och primär domän provisioneras innan inbjudan låses upp.
4. Superadministratören bjuder in organisationens första administratör.
5. Inbjudan skickas med e-post via Supabase Auth och vald SMTP-leverantör.
6. Administratören väljer ett lösenord på `app.kommunsign.se/aktivera/`.
7. Fler organisationskonton skapas av superadministratören i plattformsadministrationen.
8. Glömt lösenord hanteras på `app.kommunsign.se/aterstall/`; svaret avslöjar aldrig om en e-postadress finns.

Gamla automatiskt skapade ansökningsidentiteter stängs av av datamigration `0014_managed_organization_accounts.sql`.


## Superadmin: organisationer och konton

På `admin.kommunsign.se` finns en separat organisationsvy där superadmin kan:

- skapa en organisation direkt med organisationsnummer, huvudadministratör och driftform,
- följa provisioneringssteg, blockeringskod, tenantstatus och primär domän,
- öppna organisationen och se befintliga konton,
- skicka eller skicka om en säker aktiveringsinbjudan,
- stänga av och återaktivera organisationskonton.

Inbjudningsformuläret är fail-closed och visas först när tenantens standardroller är provisionerade och den primära domänen är verifierad med aktiv TLS. Kunden väljer därefter sitt eget lösenord och får en hostbunden session till den egna organisationsportalen. Portalen hämtar tenantens aktiva signeringspolicyer dynamiskt och kan skapa ärenden, ladda upp PDF, lägga till signerare och skicka avtalet.

## Implementerat

- separat ansökningsportal och publik ansökningsingång,
- superadministratörsstyrda organisationskonton utan publik självregistrering,
- inloggning, säkra webbläsarsessioner, CSRF-skydd och lösenordsåterställning,
- Supabase Auth som identitetsleverantör med serverbaserad administratörsinbjudan,
- separata control- och data-plane-databaser,
- strikt organisationsisolering med RLS, sammansatta foreign keys och serverhärledd kontext,
- privat dokumentlagring, kortlivade uppladdnings- och nedladdningslänkar,
- ClamAV, qpdf, Gotenberg PDF/A-2b och veraPDF,
- immutable flerhandlingsmanifest och canonical SHA-256,
- TIC BankID-produktion med QR, samma-enhet, polling, collect och verifierad webhook,
- oberoende XML-DSig-, payload-, identitets-, dokumenthash- och OCSP-verifiering,
- deterministiska evidenspaket och publik verifiering utan personnummer,
- providerneutral e-post med Resend-, SMTP- och utvecklingsadapter,
- additiva databasmigrationer, OpenAPI och synkade SDK-versioner,
- maskinella kontroller för miljövariabler, migrationer, säkerhet och produktionsberoenden.

## Installation

```bash
npm ci
cp .env.production.template .env.production
npm run verify:env-contract
npm run auth:configure-production
npm run verify:auth-config
npm run build
npm run verify
```

## Databaser

Kör alltid control-migrationer före data-migrationer:

```bash
npm run db:up
npm run db:migrate
npm run db:verify
```

Senaste kontomigrationer:

```text
migrations/control/0011_managed_accounts_and_password_sessions.sql
migrations/data/0014_managed_organization_accounts.sql
```

## Första superadministratören

Fyll de serverhemliga Supabase Auth-variablerna och följ sedan:

```bash
set -a
source .env.production
set +a
npm run auth:bootstrap-superadmin
```

Kommandot skickar en aktiveringsinbjudan och skapar den aktiva plattformsrollen idempotent. Sätt `SUPERADMIN_BOOTSTRAPPED=true` först efter att inbjudan har mottagits, lösenordet har satts och inloggning till `admin.kommunsign.se` har verifierats.

## Lokal utveckling

```bash
npm run dev
```

Portaler:

```bash
npm run dev:website
npm run dev:platform-admin
npm run dev:tenant
npm run dev:signer
npm run dev:verify
npm run dev:onboarding
npm run dev:auth
```

Använd endast syntetiska testuppgifter lokalt.

## Produktion

```bash
npm run verify:env-contract
npm run verify:env
npm run start:api
npm run start:workers
```

`verify:env` blir grön först när hemligheter, DNS, TLS, e-post, TIC, dokumenttjänster, migrationsstatus, workers och acceptanstest har verifierats i målmiljön. Ingen utvecklingsfallback används i produktion.

Detaljer:

- `docs/operations/account-provisioning.md`
- `docs/operations/production-environment.md`
- `docs/operations/supabase-auth-email.md`
- `docs/security/password-authentication.md`
- `PRODUCTION_CHECKLIST.md`

## Deployment

Kommunsign använder ett gemensamt Vercel-projekt för webbportalerna och Railwayprojektet `kommunsign-runtime` för API, webhooks, workers, ClamAV, Gotenberg, veraPDF och validation-service. Endast `api.kommunsign.se` exponeras från Railway; övriga runtime-tjänster använder privat `railway.internal`-nät. Lokalt används en enda `.env.local`; skapa den med `npm run env:local:init`.

Verifiera deploymentkonfigurationen före push:

```bash
npm run verify:deployment-config
```

Verifiera live efter Vercel/Railway-deployment:

```bash
npm run verify:deployment:live
```

Se `RAILWAY_API_RUNTIME_SETUP.md` och `docs/operations/deployment-topology.md`.
