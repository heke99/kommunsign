# Verifieringsmatris

Statusdatum: 2026-08-02.

| Krav | Status | Bevis / begränsning |
|---|---|---|
| Tenant härleds server-side | verifierat i kärna | tenant-context tester |
| Auktorisering per API-operation | verifierat i routertester | `apps/api/src/router.ts`, `tests/run.mjs` |
| Composite tenant keys | implementerat | data plane-migrationer |
| PostgreSQL RLS | statiskt verifierat, live-körning återstår | `0005`, `0008`, `verify.sql` |
| Cross-case-kopplingar blockeras | implementerat | `0009_integrity_and_worker_recovery.sql` |
| Klient kan inte sätta terminal status | implementerat | state tests + SQL triggers |
| Digital approval kräver eget immutable evidence | implementerat | domänregel + `digital_approval_evidence` |
| E-signature completion kräver signatur + validation | implementerat | domänregel + SQL completion guard |
| Dokument/policy/identitetsbindning blir immutable | implementerat | migration `0010` |
| Canonical JSON/SHA-256/Base64 | verifierat | `tests/run.mjs` |
| TIC start/poll/collect/cancel | verifierat mot adapterkontrakt | provider adapter tests; extern TIC-miljö återstår |
| TIC webhook HMAC/timestamp/bindning | verifierat lokalt | `tests/run.mjs` |
| Oberoende BankID XML-DSig/OCSP | fail-closed boundary | riktig verifierare återstår |
| Freja JWS crypto primitive | verifierat med Java self-test | `scripts/build-java.sh` |
| Freja testflöde | kräver avtal/certifikat | extern gate |
| PAdES | boundary, ej integrerat | signservice blockerar |
| DSS validation | boundary, ej integrerat | validation service blockerar |
| Evidence manifest | verifierat lokalt | `tests/run.mjs` |
| Offline verifier CLI | implementerat | `scripts/kommunsign-verify.mjs` |
| API runtime | delvis implementerat | create/list/get/send/cancel; övriga kontraktsstatusar anges i OpenAPI |
| Säkra API-fel/body limits/strict JSON | verifierat | routertests |
| Durable worker lease recovery | implementerat och testat i kärna | worker tests + migration `0009` |
| Custom domain TLS/DNS | datamodell och integritetsregler | driftintegration återstår |
| Entra ID/SCIM | arkitektur | adapter återstår |
| Backup restore | runbook | miljötest återstår |
| WCAG 2.2 AA | grundskal | full audit återstår |
| Donor 85%-gate | verifierat vid 0 LOC | provenance verifier + report |
| Permission evidence | inte verifierat | dokumenten var inte bifogade |
| SQL-syntax/live migration | statiskt granskat | ingen PostgreSQL/Docker-runtime i körmiljön |
| TypeScript/Java/testsvit | verifierat lokalt | `VERIFICATION_RESULTS.txt` |
