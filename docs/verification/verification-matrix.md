# Verifieringsmatris

| Krav | Status | Bevis |
|---|---|---|
| Tenant härleds server-side | verifierat i kärna | tenant-context test |
| Composite tenant keys | implementerat | SQL migration 0002–0004 |
| PostgreSQL RLS | implementerat, kräver Postgres-körning | migration 0005 + verify.sql |
| Klient kan inte sätta terminal status | implementerat | state test + SQL trigger |
| Canonical JSON/SHA-256 | verifierat | tests/run.mjs |
| TIC start/evidence payload | implementerat | provider adapter |
| TIC webhook HMAC/timestamp | verifierat lokalt | tests/run.mjs |
| Freja JWS crypto primitive | kompilerad | Java build |
| Freja testflöde | kräver avtal/certifikat | external gate |
| PAdES | boundary, ej integrerat | signservice blockerar |
| DSS validation | boundary, ej integrerat | validation service blockerar |
| Evidence manifest | verifierat lokalt | tests/run.mjs |
| Offline verifier CLI | implementerat | scripts/kommunsign-verify.mjs |
| OpenAPI | implementerat | docs/api/openapi.yaml |
| Custom domain TLS/DNS | datamodell, driftintegration återstår | control migration |
| Entra ID/SCIM | arkitektur, adapter återstår | implementation plan |
| Backup restore | runbook, ej miljötestat | operations runbook |
| WCAG 2.2 AA | grundskal, full audit återstår | portal HTML/CSS |
| Donor 85% gate | verifierat vid 0 LOC | provenance script |
