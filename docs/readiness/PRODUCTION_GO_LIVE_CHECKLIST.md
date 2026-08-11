# Kommunsign production go-live checklist

Authoritative rerun date: 2026-08-11.

This checklist deliberately separates code completeness from runtime, credentials, signing crypto, identity, database, security, operations and procurement. A checked repository item is not evidence that an external service or organizational control exists.

## Code complete

- [x] Server-authoritative case retrieval exists in production DATA repository.
- [x] Tenant portal reloads case detail from API after mutations/selection.
- [x] Existing CI `verify` and clean database jobs are active.
- [x] Browser E2E is no longer a placeholder command and has a dedicated PR gate.
- [ ] Browser E2E is green for the required central tenant flow in Chromium, Firefox and WebKit.
- [ ] Replace `?limit=200` pseudo-pagination and OFFSET cursor implementation on growing collections with a stable cursor contract.
- [ ] Wire required auth timing metrics into the existing observability system.
- [ ] Resolve Microsoft 365 requirements 2005/2006 against their actual online/desktop editing scope. Package-level Office conversion alone is not accepted as completion evidence.
- [ ] Reconcile current 138-requirement evidence after this rerun; stale assessments must not remain authoritative.

## Runtime configured

- [ ] Fresh 2026-08-11 CONTROL database verification available.
- [ ] Fresh 2026-08-11 DATA database verification available.
- [ ] Mandatory production dependencies return healthy/readiness evidence.
- [ ] Production regions and data locations are evidenced per enabled component.
- [ ] Restore exercise evidence is current where required.

Current blocker: the connected Supabase account returns permission denied for both Kommunsign CONTROL and DATA projects. The 2026-08-10 live-database review is historical evidence, not a substitute for the fresh verification required by this rerun.

## Credentials ready

- [ ] TIC production credential/configuration verified in runtime.
- [ ] Freja production RP credentials/mTLS verified where enabled.
- [ ] MobilityGuard/municipal IdP metadata and trust configuration verified with the actual municipality.
- [ ] Mail/storage/runtime credentials verified without exposing their values.
- [ ] Any secret previously exposed in repository history has documented operational rotation evidence.

## Signing crypto ready

- [ ] Mandatory CA certificate chain verified.
- [ ] Signing key custody verified.
- [ ] HSM/remote QSCD or approved equivalent verified for the selected advanced-signature architecture.
- [ ] TSA/RFC3161 production service verified where required.
- [ ] Final PAdES/validation path verified against real production cryptographic material.

Missing mandatory signing crypto is **STOP-SHIP** for production advanced electronic signatures. Digital approval must remain clearly separate from advanced electronic signature.

## Identity ready

- [ ] TIC/BankID full production start/status/cancel/error path verified.
- [ ] Freja/Freja OrgID production path verified where required.
- [ ] Kungälv IdP/MobilityGuard issuer, audience, signing key, replay and logout behavior verified with real metadata.
- [ ] Disabled user, revoked role and revoked session propagation verified in production-like runtime.

## Database ready

- [x] Repository migrations have a CI clean-replay gate.
- [x] Historical 2026-08-10 DATA evidence reports RLS + FORCE RLS on all 72 `app` tables; treat this as historical evidence only.
- [ ] Fresh CONTROL schema/ledger comparison completed.
- [ ] Fresh DATA schema/ledger comparison completed.
- [ ] Fresh RLS/policy inspection completed.
- [ ] Critical query plans and index choices verified in the target staging environment.
- [ ] Staging migration run green from the current branch.

Unverified production/staging migration state is **STOP-SHIP**.

## Security ready

- [ ] Cross-tenant E2E/IDOR suite green against the final branch.
- [ ] CSRF negative suite green against the final branch.
- [ ] SSRF/webhook negative suite green against the final branch.
- [ ] Session revocation tests green against the final branch.
- [ ] Secret scan green against the final branch.
- [ ] No unrotated known-compromised secrets.
- [ ] Provider mocks are impossible to activate in production paths.

Critical tenant-isolation, RLS or unrotated-secret failures are **STOP-SHIP**.

## Operational ready

- [ ] Required auth timing metrics emitted: `auth.rate_limit_ms`, `auth.provider_ms`, `auth.platform_lookup_ms`, `auth.membership_lookup_ms`, `auth.tenant_resolution_ms`, `auth.authorization_ms`, `auth.session_create_ms`, `auth.session_verify_ms`, `auth.redirect_ms`, `auth.total_ms`.
- [ ] Real p95 login/session/case measurements collected in a production-like environment; no values are to be invented.
- [ ] Worker retry/dead-letter visibility verified.
- [ ] Dependency health/readiness reflects enabled mandatory providers.
- [ ] Alerts/incident routes are operationally configured.
- [ ] Browser acceptance recorded for actual Windows 11 Edge, Windows 11 Chrome and supported Safari platform when procurement evidence requires those named browsers.

## Contract / procurement ready

- [ ] All 138 requirements re-assessed against current code/runtime/external evidence.
- [ ] Requirements 2005 and 2006 have evidence for the Microsoft 365 behavior actually requested, not merely Office-file ingestion.
- [ ] Digg advanced electronic signature evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] TIC/BankID evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] Freja/Freja OrgID evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] MobilityGuard/municipal IdP runtime evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] Supplier/subprocessor/data-region evidence complete.
- [ ] PUB/DPA/SLA/support and organizational ISMS/HR evidence complete where required.
- [ ] Reference-customer evidence verified internally where required.

## Current gate

`CODE COMPLETE`: **NO**

`RUNTIME CONFIGURED`: **NO**

`PRODUCTION GO`: **NO**

`PROCUREMENT GO`: **NO**

These statuses must only be promoted by evidence generated after the outstanding technical and external gates above are resolved.
