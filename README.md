# KommunSign

KommunSign är en multi-tenant och white-label-baserad plattform för ansökningsstyrd onboarding, digitala godkännanden och elektroniska underskrifter i svensk offentlig sektor.

Den här leveransen är en **verifierad utvecklingsbas, inte en produktionsklar e-signaturtjänst**. Ansökningsflödet fungerar sammanhängande i utvecklingsruntime och har additiv produktionsdatamodell, OpenAPI och fail-closed produktionsentrypoints. Riktig produktionsrepository, dokumentpipeline, federation, PAdES, EU DSS, TIC/Freja-liveflöden, CA/HSM/TSA och e-arkiv återstår eller är externt blockerade.

## Implementerat

- separat onboardingportal och publik `/ansok`-ingång,
- applicant-, platform- och tenantseparerad routing och auktorisering,
- strikt ansökningsstatusmaskin, 256-bitars tokenkärna och atomiska `ONB-ÅÅÅÅ-NNNNNN`-referenser,
- immutable ansökningsversioner, reviews, kompletteringar, beslut och audit,
- idempotent provisioningmodell som alltid lämnar tenant i `onboarding`,
- central readinessmotor och fail-closed aktiveringsgrind,
- tvåpersonsprincip med databasblockering av självgodkänd aktivering,
- additiv control-plane-migration `0006_onboarding_and_activation.sql`,
- plattformsadmin för ansökningskö, review, beslut, provisioning och audit,
- produktionsbootstrap för API/workers utan in-memory-fallback,
- serverhärledd tenantkontext, RBAC, PostgreSQL RLS och composite tenant-FK,
- canonical JSON, SHA-256, HMAC, OIDC PKCE/state/nonce och engångstokens,
- befintlig TIC-adaptergrund, Freja JWS-kärna, evidence manifest och offlineverifiering,
- OpenAPI 3.1 och SDK-version `2026-08-02.3`,
- unit-, integration-, security-, migration-, Java-, proveniens- och secret-grindar.

## Säkerhetsgräns

Systemet fabricerar aldrig aktiv tenant, PAdES, DSS-resultat eller positiv provider-evidence. Produktions-API och workers kräver explicit granskade adaptermoduler och stoppar annars. Nedladdning av signerad PDF, valideringsrapport och evidence package returnerar fail-closed-fel tills verkliga tjänster är konfigurerade.

## Installation och verifiering

```bash
npm ci
cp .env.example .env
npm run verify
npm run web:build
npm run sbom
```

## Lokal databas

```bash
npm run db:up
npm run db:migrate
npm run db:verify
```

## Lokal körning

Kör alla statiska portaler och utvecklings-API:

```bash
npm run dev
```

Eller separat:

```bash
npm run dev:api             # 8787
npm run dev:website         # 3000
npm run dev:platform-admin  # 3001
npm run dev:tenant          # 3002
npm run dev:signer          # 3003
npm run dev:verify          # 3004
npm run dev:onboarding      # 3005
```

Utvecklingsruntime använder explicita utvecklingsidentiteter och är kodmässigt blockerad när `APP_ENV=production`. Använd inga riktiga personuppgifter eller eID-hemligheter i detta läge.

## Produktionsentrypoints

```bash
npm run build
npm run start:api
npm run start:workers
```

Dessa kommandon kräver `KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE`, `KOMMUNSIGN_WORKER_ADAPTER_MODULE`, control/data database URLs, object storage och queue. Saknad dependency ger blockerande startfel; ingen devfallback används.

## Donorstatus

Åtta donorprojekt är pinade, men **0 donor-LOC har importerats**. Placeholderfiler under `upstream/permissions` är inte juridiska tillståndsbevis. Proveniensgrinden ska fortsätta blockera kodimport tills rättighetshavare, tillståndsomfattning och SHA-256 är verifierade.

## Statusdokument

- `docs/architecture/current-state-verified.md`
- `docs/architecture/target-architecture.md`
- `docs/architecture/onboarding-architecture.md`
- `docs/architecture/remaining-implementation-plan.md`
- `docs/verification/requirements-traceability.md`
- `docs/verification/production-readiness.md`
- `DELIVERY_REPORT.md`
