# KommunSign

KommunSign är en säker grund för en multi-tenant och white-label-baserad plattform för digitala godkännanden och elektroniska underskrifter i svensk offentlig sektor.

Den här leveransen är en **härdad fas 0–1-kärna med delar av fas 2–4**. Den är inte hela den färdiga produkten i masterkravet.

## Implementerat i denna leverans

- strikt serverhärledd tenantkontext, RBAC och PostgreSQL RLS-modell,
- composite tenant keys och skydd mot cross-case-kopplingar,
- versionerade signaturpolicyer och serverstyrda statusmaskiner,
- skilda completion-krav för digitalt godkännande och e-underskrift,
- immutable dokument-, policy-, identitets- och evidence-bindningar,
- canonical JSON, SHA-256, Base64, HMAC och säkra engångstokens,
- TIC/BankID-adapter med rätt HTTP-semantik, dokumenthashbindning och webhookverifiering,
- Java JWS-verifieringskärna för Freja-gränsen,
- hållbar worker leasing och återtag efter krasch/lease expiry,
- append-only hashkedjad auditmodell,
- transactional outbox, idempotens och webhookmodell,
- säker API-runtime för create/list/get/send/cancel,
- OpenAPI 3.1 med tydlig implementationsstatus per operation,
- offline verifier-CLI och evidence manifest,
- CI-grindar för build, migrationer, proveniens, hemligheter, Java och tester,
- 85-procentsgrind med exakta donor-pins och permission-evidence-kontroll.

## Viktig säkerhetsgräns

Projektet skapar inte en låtsad PAdES-signatur. Java-tjänsterna och databasen blockerar slutförande tills rätt teknisk evidence finns. Sweden Connect SignService, EU DSS, TSA, CA/HSM, TIC och Freja måste kopplas med godkända avtal, certifikat och fastlåsta versioner innan produktionssignering kan påstås fungera.

## Donorstatus

Åtta donorprojekt är låsta till exakta commits, men **0 donor-LOC har importerats**. Uppgiften om skriftligt tillstånd är registrerad, men tillståndsdokumenten var inte bifogade. Lägg verifierbara kopior under `upstream/permissions/<donor>/`, registrera SHA-256 och ändra status först efter juridisk kontroll. Proveniensgrinden blockerar annars importen.

## Kom igång

```bash
npm ci
cp .env.example .env
npm run verify
npm run sbom
npm run provenance:report
```

Lokal infrastruktur:

```bash
docker compose up -d postgres redis minio clamav gotenberg
```

Migrationer och synkkommandon finns i:

- `docs/operations/local-development.md`
- `docs/operations/synchronization.md`

## Repository

- `apps/` – API, workers och portalgrund.
- `packages/` – domän, policy, crypto, audit och provideradaptrar.
- `services/` – isolerade Java-gränser för identitet, signering och validering.
- `migrations/` – control plane och tenant data plane.
- `upstream/` – proveniens, licenser, pins och tillståndsbevis.
- `infrastructure/` – lokal drift, container, monitoring och IaC-bas.
- `docs/` – arkitektur, säkerhet, integration, compliance, drift och verifiering.

Se `DELIVERY_REPORT.md`, `docs/architecture/review-2026-08-02.md` och `docs/verification/verification-matrix.md` för exakt status.
