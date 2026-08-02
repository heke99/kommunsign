# Produktionsberedskap

## Samlad bedömning

**Status: NOT READY FOR PRODUCTION.**

Repositoryt har nu en sammanhängande, testad utvecklingsslice för ansökningsstyrd onboarding och fail-closed produktionsentrypoints. Det är inte samma sak som en produktionsfärdig e-signeringstjänst. Följande grindar måste vara gröna i riktig målmiljö.

## Grindar

| Grind | Status | Evidens | Blockerare |
|---|---|---|---|
| Git/release source | PARTIAL | zipgranskning | `.git`, branch och remote måste verifieras efter synk |
| Build/unit/integration/security | VERIFIED för lokal kod | `VERIFICATION_RESULTS.txt` | npm registry påverkade installationen, ej testerna med exakt lokal TS-version |
| Control-plane migration | IMPLEMENTED | `0006_onboarding_and_activation.sql` | live PostgreSQL migration/race/rollback evidence |
| Production API adapter | NOT_IMPLEMENTED | fail-closed bootstrap | PostgreSQL, auth, storage och queue repositories |
| Production worker adapter | NOT_IMPLEMENTED | fail-closed runner | durable repository och handlers |
| Applicant production auth | NOT_IMPLEMENTED | token primitives | mail, HttpOnly session, CSRF, rate limiting |
| Application isolation | PARTIAL | wrong-token integration | live DB tests mellan två sökande |
| Tenant isolation | PARTIAL | existing RLS/schema | non-superuser live DB tests |
| Provisioning | PARTIAL | dev saga/schema | real resources, resumability and retry evidence |
| Readiness/activation | PARTIAL | engine + blocked activation test | active checks, acceptance and green two-person E2E |
| Document security | NOT_IMPLEMENTED | metadata validation only | storage, ClamAV, sandbox, canonicalization |
| Identity federation | PARTIAL | primitives/schema | OIDC/WebAuthn/SAML/SCIM runtime |
| BankID/Freja | EXTERNAL_BLOCKER | adapter/core only | credentials, mTLS, live E2E, independent verification |
| PAdES/DSS/TSA/HSM | EXTERNAL_BLOCKER | fail-closed services | real dependencies, certificates and HSM |
| Evidence/e-archive | PARTIAL | manifest/offline core | full artifacts, timestamp/signature, archive receipt |
| Webhook/notification | PARTIAL | security primitives/schema | durable workers/providers |
| Backup/restore | NOT_IMPLEMENTED | runbook baseline | tenant-isolated restore exercise |
| Load/pentest/WCAG | EXTERNAL_BLOCKER | commands only | target environment and independent execution |
| Legal provenance | LEGAL_BLOCKER for reused donor code | zero reused LOC | verified permission evidence |

## Obligatoriska blockerande readinesskoder före produktion

Minst följande ska ge `ready=false` när de gäller: `TENANT_DATABASE_NOT_READY`, `OBJECT_STORAGE_NOT_READY`, `OIDC_NOT_CONFIGURED`, `SAML_NOT_CONFIGURED`, `SCIM_NOT_CONFIGURED`, `CUSTOM_DOMAIN_NOT_ACTIVE`, `TIC_PROVIDER_NOT_CONFIGURED`, `FREJA_PROVIDER_NOT_CONFIGURED`, `SIGN_SERVICE_NOT_CONFIGURED`, `VALIDATION_SERVICE_NOT_CONFIGURED`, `TSA_NOT_CONFIGURED`, `ARCHIVE_CONNECTOR_NOT_CONFIGURED`, `RETENTION_POLICY_NOT_APPROVED`, `DPA_NOT_ACCEPTED`, `ACCEPTANCE_TEST_NOT_PASSED`, `SOFTWARE_TEST_KEY_IN_PRODUCTION`, `CERTIFICATE_EXPIRED`.

## Produktionsbeslut

Produktion får inte öppnas genom att ändra en status manuellt. Releaseansvarig ska kräva:

1. migreringsrapport från tom och befintlig databas,
2. tenant- och application-isolation med icke-superuser,
3. grön aktiv readiness,
4. dokumenterad kundacceptans,
5. distinkt aktiveringsinitiator och approver,
6. live provider-E2E utan mocks,
7. signerad SBOM/proveniens och secret scan,
8. backup/restorebevis,
9. pentest utan blockerande fynd,
10. WCAG 2.2 AA-rapport och lastresultat.

Fram till dess ska API och workers fortsätta fail-closed när produktionsadaptrar eller providers saknas.
