# Implementationsplan

Statusdatum: 2026-08-02.

## Fas 0 – källor, tillstånd och arkitektur

### Implementerat

- Åtta donorprojekt är låsta till exakta commit-SHA:n.
- Proveniensmanifest v2 och maskinläsbar reuse-map finns.
- 85-procentsgrinden räknar faktisk återanvänd LOC per donor och stoppar import över gränsen.
- Grinden kontrollerar att permission evidence finns, har verifierad SHA-256 och är kopplad till rätt donor innan donor-LOC får importeras.
- Licenspolicy, hotmodell, arkitekturbeslut och verifieringsmatris finns.

### Blockerat

Användarens uppgift om skriftligt tillstånd är registrerad som `claimed_not_verified`. Själva tillståndsdokumenten ingick inte i leveransen. Därför är donorimport fortsatt fail-closed och `reused_loc` är 0 för samtliga donorprojekt.

## Fas 1 – plattformsgrund

### Implementerat

- Gemensam TypeScript-/Java-kodbas med control plane och tenant data plane.
- Serverhärledd tenantkontext, RBAC, RLS, composite tenant foreign keys och tenantbundna idempotency keys.
- Versionerade policies/profiler, white-label-modell, custom-domainmodell och audit/outbox.
- Oföränderlighetsregler för verifierad domänbindning och aktiverad/versionerad tenantkonfiguration.
- API-runtime med fail-closed readiness, body limits, strikt JSON-validering, auktorisering och säkra fel.
- CI-grindar för build, migrationer, proveniens, hemlighetsskanning, Java och testsvit.

### Återstår

- Riktig OAuth2/OIDC-tokenvaliderare och Entra ID/SCIM-adapter.
- DNS/TLS-provisionering mot vald driftleverantör.
- Fullständiga administrationsvyer.

## Fas 2 – dokument och manuellt workflow

### Implementerat

- Datamodell, statusmaskiner, karantän-/scan-/canonicaliseringsjobb, dokumenthashar och fältmodell.
- Serverstyrda övergångar och databasskydd mot dokumentbyte efter att flödet startat.
- Hållbar job leasing med återtag av utgångna leases.
- Separat immutable evidence för digitalt godkännande.

### Återstår

- Full PDF-editor och tillgängligt listalternativ.
- Verkliga ClamAV-, Gotenberg-/PDF-A- och S3-adaptrar.
- Kompletta portalvyer, notifieringsflöden och E2E mot riktiga tjänster.

## Fas 3 – BankID via TIC

### Implementerat

- Backendadapter med verifierade HTTP-metoder, HTTPS-krav och timeout.
- Canonical dokumenthashpayload, Base64-kodning, session/state/nonce-bindning.
- QR-/subscription-/orderfält bevaras när TIC returnerar dem.
- Webhook-HMAC, timestamp, konstanttidsjämförelse och collect-bindning.
- Fail-closed separat XML-DSig/OCSP-verifieringsgräns.

### Återstår

- TIC testtenant, verkliga nycklar och kontraktstest mot TIC-miljö.
- Oberoende XML-DSig/OCSP-implementation med testvektorer.

## Fas 4 – Freja

### Implementerat

- Java JWS-verifieringskärna med skyddat algoritmval, nyckeltypkontroll, `crit`/`b64`-skydd och RS256/ES256-stöd.
- Självtest som körs i verifieringskedjan.

### Återstår

- Officiell Freja-klient som låst Maven-dependency.
- Integrator RP-avtal, mTLS, certifikatrotation, dynamisk QR och full payloadbindning i testmiljö.

## Fas 5–6 – PAdES, validering och bevarande

### Implementerat

- Signerings- och valideringsgränser som vägrar skapa falsk produktionssignatur.
- Databaskrav på kryptografisk signaturartefakt och accepterad validering innan ett e-signaturärende får bli `completed`.
- Datamodell för certifikatkedja, OCSP, CRL, tidsstämplar, trust-list snapshots och valideringsrapporter.
- Evidence manifest och offline-verifierings-CLI.

### Återstår

- Sweden Connect SignService, CA/TSP/HSM och EU DSS som faktiskt låsta och körande integrationer.
- PAdES B/T/LT/LTA, inkrementella signaturer, TSA och arkivvalidering.
- Verifierat evidence package med verkliga providersvar.

## Fas 7 – API och connectors

### Implementerat

- OpenAPI 3.1-kontrakt.
- Runtimeimplementerade endpoints för create/list/get/send/cancel.
- OAuth/scopes är specificerade, men extern tokenvalidering återstår.
- Idempotensmodell, webhookmodell och connectorgränssnitt finns.

### Återstår

- Övriga OpenAPI-endpoints, SDK-generering, webhook worker och kommunconnectors.
- E-arkivadapter och full exportverifiering.

## Fas 8 – produktionshärdning

Återstår i extern/integrerad miljö:

- live PostgreSQL-migrationstest och RLS/tenant-escape-test,
- provider-E2E,
- lasttest,
- penetrationstest,
- WCAG 2.2 AA-audit,
- DPIA och juridiska policybeslut,
- backup/restore-övning,
- certifikatrotation och disaster recovery,
- pilotgodkännande.
