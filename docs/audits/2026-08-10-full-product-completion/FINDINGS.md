# Findings — 2026-08-10 full product completion

## Closed P0 — case detail is now server-authoritative

`GET /v1/signature-cases/:id` now reads the case, policy snapshot/version, lifecycle timestamps, current document versions, scan/processing reports, signer state/order, audit events, and evidence/archive availability from DATA inside the authenticated tenant transaction. The tenant portal no longer keeps authoritative document/signer state in a browser-only `Map`; it reloads server detail after selection and mutations.

This closes the refresh/logout-login/other-browser/other-computer source-of-truth finding.

## Closed P1 — tenant destination resolution

`resolveSubjectDestination` now resolves eligible tenant primary-domain candidates concurrently and selects the first valid destination according to the existing deterministic membership ordering. Unexpected errors remain fail-closed.

## Remaining P1 — requested auth timing instrumentation

The repository verification gate passes, but the masterprompt's explicit low-cardinality auth timing series is not yet part of the runtime metric vocabulary: `auth.rate_limit_ms`, `auth.provider_ms`, `auth.platform_lookup_ms`, `auth.membership_lookup_ms`, `auth.tenant_resolution_ms`, `auth.authorization_ms`, `auth.session_create_ms`, `auth.session_verify_ms`, `auth.redirect_ms`, and `auth.total_ms`.

This remains an implementation item if the masterprompt requires those exact runtime metrics rather than merely the existing observability vocabulary. No p95 performance claim is made without real measurements.

## Database — schema and migration drift reconciled

The live CONTROL migration ledger had stopped at 0016 while schema objects from 0017 existed; DATA likewise had 0017/0018 objects while the ledger stopped at 0016. The actual objects were verified first and the custom `kommunsign_meta.schema_migrations` ledger was reconciled to the repository checksums without blindly replaying already-present DDL.

The DATA runtime currently has 72/72 `app` tables with RLS enabled and FORCE RLS enabled, and tenant policies use `app.current_tenant_id()` for both `USING` and `WITH CHECK`.

## Verification

The complete repository gate `npm run verify` passed in GitHub Actions on Node 22 after installing Temurin Java 21. The first remote verification failure was environmental: the runner's default JDK did not support `--release 21`. With Java 21 installed, the full gate completed successfully.

## Current disposition

The code remediation is implemented and the repository gate is green. The remaining explicit technical item from the findings is the requested auth timing instrumentation/p95 measurement; external integrations and live production secrets remain outside this repository-only verification gate.
