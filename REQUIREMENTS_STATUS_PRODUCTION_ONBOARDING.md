# Requirements status — BankID production foundation

Updated: 2026-08-03

Status: **Implementerat** = körbar repositoryimplementation finns. **Driftsättningssteg** = implementationen finns och ska verifieras med målmiljöns credentials, DNS eller tjänstebevis. **Extern aktivering** = leverantören eller organisationen måste godkänna/aktivera tjänsten.

| Area | Status | Repository evidence / remaining gate |
|---|---|---|
| Multi-organisation, control/data plane, RLS, organisation FK | Implemented | Existing architecture preserved; migration `migrations/data/0013_bankid_production_foundation.sql`; verification SQL extended. |
| Canonical domains and reserved slugs | Implemented | `.env.example`, organisation gateway/domain model; live DNS/TLS is driftsättningssteg. |
| Strict personal-number binding | Implemented | `packages/personal-number`, encrypted/blind-index storage, server-side exact evidence match. |
| Controlled personal-number exception | Implemented | Organisation policy, permission, reason codes, encrypted reason and audit fields. |
| Private PDF upload grants | Implemented | Upload/create/complete API, private storage adapter, server-side checksum confirmation. |
| Malware/PDF policy pipeline | Implemented | ClamAV INSTREAM, qpdf policy inspection and durable handlers; live engines are driftsättningssteg. |
| PDF/A-2b conversion and validation | Implemented | Gotenberg and veraPDF clients, immutable canonical SHA-256; approved veraPDF deployment/digest is driftsättningssteg. |
| Multi-document signing intent | Implemented | Immutable v2 signing intents and document snapshots with deterministic ordering. |
| Parallel/sequential signing | Implemented | `signing_order` groups and lower-group blocking in public start flow. |
| TIC production adapter | Implemented | Direct backend start/poll/collect/cancel/extend and QR data; TIC credentials/account/live test are driftsättningssteg. |
| TIC webhook | Implemented | Raw body HMAC, timestamp, known event, state/session binding and idempotent persistence. |
| XML-DSig/OCSP verifier | Implemented | Isolated Java validation service with XXE disabled, strict reference checks, X.509, payload/identity and OCSP checks; live TIC fixture acceptance is driftsättningssteg. |
| Evidence packages | Implemented | Deterministic ZIP, manifests/checksums, signer/case builders, public offline verifier. |
| Provider-neutral email | Implemented | `EmailProvider`, Resend, development and SMTP boundaries; Resend credentials/DNS are driftsättningssteg. |
| Resend compliance gate | Implemented | Organisation/global readiness flags; written data-residency approval or provider replacement is driftsättningssteg. |
| Public signer portal | Implemented | Invitation/document routes, review acknowledgement, QR/same-device, poll, extend, cancel and decline. |
| Organisation portal workflow | Implemented | Create/upload/complete/add document/add signer/send/remind/cancel and immutable preview. |
| Verification portal | Implemented | Non-sensitive verification-ID lookup and ZIP package verification. |
| Stängd kontomodell | Implementerat | Ansökan skapar ingen användare. Superadministratören bjuder in organisationens konton via server-side Supabase Auth. |
| Inloggning och glömt lösenord | Implementerat | Hostbunden cookie, CSRF, DB-rate-limit, neutralt återställningssvar, token-hashverifiering som motstår e-postförhandsöppning och lösenordsaktivering på auth-portalen. |
| Kontolivscykel | Implementerat | Superadministratören kan bjuda in, skicka en ny inbjudan till samma adress, stänga av och återaktivera organisationskonton. Avstängning återkallar aktiva Kommunsign-sessioner. |
| Uppgradering av äldre ansökningskonton | Implementerat | Data-migration `0014_managed_organization_accounts.sql` stänger legacy `pending-invite`-identiteter och fyller rollkatalogen. |
| OpenAPI and SDKs | Implemented | OpenAPI `2026-08-03.2`; TypeScript/C#/Java synchronization check passes. |
| Unit/integration/security verification | Implemented | 33 unit tests plus integration, security, repository, migration, provenance, SDK, secret, ENV contract and Java checks pass locally. |
| Full `npm run verify` from clean install | Driftsättningssteg | Current package registry mirror returns 404 for pinned `postgres@3.4.7`; no claim of full clean-install pass. |
| Evidence fixture verification | Implemented | Deterministic package fixture passes and byte modification is rejected by `scripts/verify-evidence-fixtures.mjs`. |
| Runtime readiness gates | Implemented | Separate fail-closed checks cover TIC, PDF services, verifier, email/data residency, workers, TLS, keys, migrations, storage, retention, DPA and acceptance. |
| Empty/upgrade DB and external E2E | Driftsättningssteg | Requires Docker/PostgreSQL/services plus TIC/Resend production credentials and consenting test participants. |

Repositoryt innehåller produktionsimplementationen. Aktivering sker efter att målmiljöns verifieringssteg i `PRODUCTION_CHECKLIST.md` har dokumenterade testbevis.
