# KommunSign

KommunSign är en greenfield-grund för en multi-tenant och white-label-baserad underskriftsplattform för svensk offentlig sektor.

Denna leverans implementerar en säker produktkärna och de kontrakt som resten av plattformen måste följa:

- strikt tenantkontext och auktorisering,
- versionerade signaturpolicyer,
- separata statusmaskiner för ärende, signerare och dokument,
- canonical JSON, SHA-256, HMAC och säkra engångstokens,
- TIC/BankID-adapter med dokumenthashbindning och webhookverifiering,
- provideroberoende identitetskontrakt,
- PostgreSQL-schema med composite tenant keys och RLS,
- append-only hashkedjad auditmodell,
- transactional outbox, idempotens och webhookleveranser,
- OpenAPI 3.1,
- Java-gränstjänster som blockerar falsk produktionssignering,
- Docker Compose, Kubernetes-bas, CI, hotmodell och drift/runbooks,
- verifieringsbara tester och proveniensgrind.

## Viktig säkerhetsgräns

Projektet skapar **inte** en låtsad PAdES-signatur. Java-tjänsterna returnerar explicit `NOT_CONFIGURED` tills Sweden Connect SignService, EU DSS, TSA, CA/HSM, TIC och Freja har kopplats med godkända avtal, certifikat och fastlåsta versioner. Ett ärende kan därför inte bli `completed` bara genom en klientstatus eller en namn-/signaturbild.

## Kom igång

```bash
npm ci
cp .env.example .env
npm run verify
```

För lokal infrastruktur, på en dator med Docker:

```bash
docker compose up -d postgres redis minio clamav gotenberg
```

Kör SQL-migrationerna i ordning under `migrations/control` och `migrations/data`. Se `docs/operations/local-development.md`.

## Repository

- `apps/` – API, workers och portalgränssnitt.
- `packages/` – domän, policy, säkerhet och provideradaptrar.
- `services/` – isolerade Java-gränser för identitet, signering och validering.
- `migrations/` – control plane och tenant data plane.
- `upstream/` – proveniens, licenser och tillstånd.
- `infrastructure/` – lokal drift, Kubernetes, monitoring och backup.
- `docs/` – arkitektur, säkerhet, integration, compliance och drift.

## Verifieringsstatus

Se `docs/verification/verification-matrix.md` och `DELIVERY_REPORT.md` för exakt skillnad mellan implementerat, lokalt verifierat och beroenden som kräver externa avtal eller produktionscertifikat.
