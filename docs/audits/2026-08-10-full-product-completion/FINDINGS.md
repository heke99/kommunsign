# Findings — 2026-08-10 full product completion

## P0 — case detail is not yet server-authoritative in the portal

The API already exposes `GET /v1/signature-cases/:id`, but the production repository currently returns the shallow `SignatureCaseView` only. The tenant portal still declares `const caseDetails = new Map()` and uses that browser map to retain documents and signers for the preview. This violates the masterprompt requirement that refresh, logout/login, another browser and another computer must reconstruct the same state from the server.

**Required remediation:** enrich the server case-detail contract with policy/version, lifecycle timestamps, current document versions and processing/scan/PDF-A state, signer state/order, audit events and evidence/archive availability; then make the portal load that contract after refresh and after every mutation. No business state should be persisted in a browser map.

## P1 — login destination resolution is serial across tenant candidates

`resolveSubjectDestination` first resolves memberships from DATA and then awaits each tenant's primary-domain lookup one at a time. This is a measurable round-trip pattern that can become slow for subjects with multiple memberships. A safe optimization is to resolve candidate destinations concurrently, preserve the existing deterministic membership order when choosing the first valid destination, and keep fail-closed handling for every other error.

This should be followed by real p95 measurement; no performance claim is made from code inspection alone.

## P1 — performance instrumentation requested by the masterprompt is not present

The repository has an observability vocabulary, but the requested auth timing series (`auth.rate_limit_ms`, `auth.provider_ms`, `auth.platform_lookup_ms`, `auth.membership_lookup_ms`, `auth.tenant_resolution_ms`, `auth.authorization_ms`, `auth.session_create_ms`, `auth.session_verify_ms`, `auth.redirect_ms`, `auth.total_ms`) are not currently part of the metric vocabulary or emitted by the login path. The next implementation step must add a low-cardinality timing mechanism and benchmark it against the stated p95 budgets.

## Database — schema and migration ledger had drift

The live CONTROL migration ledger stopped at 0016 while the schema already contained the objects from 0017. The live DATA ledger stopped at 0016 while the schema already contained the SCIM and attachment objects from 0017/0018.

The schema was verified against the repository verification logic. All 72 live `app` tables have RLS enabled and FORCE RLS enabled, and the tenant isolation policies use `app.current_tenant_id()` for both `USING` and `WITH CHECK`.

After verifying the actual objects, the custom `kommunsign_meta.schema_migrations` ledger was reconciled with the repository checksums for CONTROL 0017 and DATA 0017/0018. This was a metadata reconciliation, not a blind re-run of DDL: an attempted DATA 0017 replay was stopped because the live SCIM tenant policy already existed.

## Verification limitation

The local environment could not complete `npm ci --ignore-scripts`: the available package registry returned HTTP 404 for `postgres@3.4.7`. Therefore this campaign does not claim a fresh local `npm run verify` pass. GitHub Actions runs were also not available for the temporary remote patch workflow, so no code patch was claimed from that mechanism.

## Current branch disposition

The remediation branch is intentionally not represented as complete yet. It currently contains the baseline/live-database audit evidence and skill routing, while the code P0/P1 remediation remains to be implemented and verified before a PR is opened.
