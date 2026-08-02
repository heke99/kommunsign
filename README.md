# KommunSign

KommunSign är en multi-tenant och white-label-baserad plattformskärna för digitala godkännanden och elektroniska underskrifter i svensk offentlig sektor.

Den här leveransen är **inte produktionsklar e-signering**. Den innehåller en verifierad säker kärna, komplett runtimekontrakt för kärn-API:t, funktionella utvecklingsportaler och additiva databasmigrationer. Riktig PAdES, EU DSS, TIC/Freja-liveflöden, CA/HSM/TSA och produktionsauth förblir blockerade tills externa avtal, certifikat och provideradapters finns.

## Implementerat

- serverhärledd tenantkontext, RBAC, PostgreSQL RLS och composite tenant-FK,
- tenanttransaktioner med `tenant_id`, `actor_kind`, `actor_id` och `request_id`,
- immutable dokument/policy/evidence och completion guards,
- canonical JSON, SHA-256, Base64, HMAC, OIDC PKCE/state/nonce och engångstokens,
- TIC BankID-adaptergrund och webhookverifiering,
- Freja JWS-verifieringskärna i Java,
- audit-hashkedja, durable jobs, idempotens och outbox,
- sexton runtimeoperationer i OpenAPI och API-router,
- tenantportal för cases/uploads/signerare/events samt operativa admin-, signer- och verifieringsytor,
- upload-, branding-, custom-domain-, invitation- och webhook-SSRF-guards,
- Docker Compose för separata control/data-databaser och lokala stödtjänster,
- unit-, integration-, security-, migration-, Java-, proveniens- och secret-grindar.

## Säkerhetsgräns

Systemet fabricerar aldrig PAdES, DSS-resultat eller positiv provider-evidence. Nedladdning av signerad PDF, valideringsrapport och evidence package returnerar strukturerade fail-closed-fel tills motsvarande tjänst är konfigurerad.

## Installation

```bash
npm ci
cp .env.example .env
npm run verify
npm run web:build
npm run sbom
```

## Lokal körning

```bash
npm run db:up
npm run db:migrate
npm run db:verify

npm run dev:api
npm run dev:tenant
```

Portaler:

```bash
npm run dev:website         # 3000
npm run dev:platform-admin  # 3001
npm run dev:tenant          # 3002
npm run dev:signer          # 3003
npm run dev:verify          # 3004
```

API-utvecklingsruntime lyssnar normalt på `8787`. Den använder explicita utvecklingsheaders och är kodmässigt blockerad när `APP_ENV=production`.

## Donorstatus

Åtta donorprojekt är pinade, men **0 donor-LOC har importerats**. Placeholderfilerna under `upstream/permissions` är inte juridiskt tillståndsbevis. Proveniensgrinden ska fortsätta blockera all import tills signerade rättighetsdokument, SHA-256 och reuse-map är verifierade.

## Status och nästa steg

- `docs/architecture/current-state-verified.md`
- `docs/architecture/remaining-implementation-plan.md`
- `docs/verification/requirements-traceability.md`
- `DELIVERY_REPORT.md`
