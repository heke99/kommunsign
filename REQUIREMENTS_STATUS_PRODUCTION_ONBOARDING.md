# Requirements status — BankID production foundation

Updated: 2026-08-03

Status meanings: **Implemented** = executable repository implementation exists; **Environment-blocked** = implementation exists but requires external credentials/services/evidence; **Partial** = a production-critical part still requires work.

| Area | Status | Repository evidence / remaining gate |
|---|---|---|
| Multi-tenant, control/data plane, RLS, tenant FK | Implemented | Existing architecture preserved; migration `migrations/data/0013_bankid_production_foundation.sql`; verification SQL extended. |
| Canonical domains and reserved slugs | Implemented | `.env.example`, tenant gateway/domain model; live DNS/TLS is environment-blocked. |
| Strict personal-number binding | Implemented | `packages/personal-number`, encrypted/blind-index storage, server-side exact evidence match. |
| Controlled personal-number exception | Implemented | Tenant policy, permission, reason codes, encrypted reason and audit fields. |
| Private PDF upload grants | Implemented | Upload/create/complete API, private storage adapter, server-side checksum confirmation. |
| Malware/PDF policy pipeline | Implemented | ClamAV INSTREAM, qpdf policy inspection and durable handlers; live engines are environment-blocked. |
| PDF/A-2b conversion and validation | Implemented | Gotenberg and veraPDF clients, immutable canonical SHA-256; approved veraPDF deployment/digest is environment-blocked. |
| Multi-document signing intent | Implemented | Immutable v2 signing intents and document snapshots with deterministic ordering. |
| Parallel/sequential signing | Implemented | `signing_order` groups and lower-group blocking in public start flow. |
| TIC production adapter | Implemented | Direct backend start/poll/collect/cancel/extend and QR data; TIC credentials/account/live test are environment-blocked. |
| TIC webhook | Implemented | Raw body HMAC, timestamp, known event, state/session binding and idempotent persistence. |
| XML-DSig/OCSP verifier | Implemented | Isolated Java validation service with XXE disabled, strict reference checks, X.509, payload/identity and OCSP checks; live TIC fixture acceptance is environment-blocked. |
| Evidence packages | Implemented | Deterministic ZIP, manifests/checksums, signer/case builders, public offline verifier. |
| Provider-neutral email | Implemented | `EmailProvider`, Resend, development and SMTP boundaries; Resend credentials/DNS are environment-blocked. |
| Resend compliance gate | Implemented | Tenant/global readiness flags; written data-residency approval or provider replacement is environment-blocked. |
| Public signer portal | Implemented | Invitation/document routes, review acknowledgement, QR/same-device, poll, extend, cancel and decline. |
| Tenant portal workflow | Implemented | Create/upload/complete/add document/add signer/send/remind/cancel and immutable preview. |
| Verification portal | Implemented | Non-sensitive verification-ID lookup and ZIP package verification. |
| OpenAPI and SDKs | Implemented | OpenAPI `2026-08-03.1`; TypeScript/C#/Java synchronization check passes. |
| Unit/integration/security verification | Implemented | 28 unit tests plus integration, security, repository, migration, provenance, SDK, secret and Java checks pass locally. |
| Full `npm run verify` from clean install | Environment-blocked | Current package registry mirror returns 404 for pinned `postgres@3.4.7`; no claim of full clean-install pass. |
| Evidence fixture verification | Implemented | Deterministic package fixture passes and byte modification is rejected by `scripts/verify-evidence-fixtures.mjs`. |
| Runtime readiness gates | Implemented | Separate fail-closed checks cover TIC, PDF services, verifier, email/data residency, workers, TLS, keys, migrations, storage, retention, DPA and acceptance. |
| Empty/upgrade DB and external E2E | Environment-blocked | Requires Docker/PostgreSQL/services plus TIC/Resend production credentials and consenting test participants. |

The repository is a production-oriented, fail-closed foundation. It must not be marketed as externally production-verified until all environment-blocked acceptance items are evidenced.
