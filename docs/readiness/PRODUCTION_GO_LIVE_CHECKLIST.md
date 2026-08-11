# Kommunsign production go-live checklist

Authoritative rerun date: 2026-08-11.

This checklist deliberately separates code completeness from runtime, credentials, signing crypto, identity, database, security, operations and procurement. A checked repository item is not evidence that an external service or organizational control exists.

## Code complete

- [x] Server-authoritative case retrieval exists in production DATA repository.
- [x] Tenant portal reloads case detail from API after mutations/selection.
- [x] Existing CI `verify` and clean database jobs are active.
- [x] Browser E2E is no longer a placeholder command and has a dedicated PR gate.
- [x] Browser E2E is green for create → upload → signer → detail → refresh → independent browser context → send in Chromium, Firefox and WebKit.
- [x] Development case-detail runtime now returns server detail with documents, signers and events instead of a shallow case that crashes the portal.
- [ ] Replace `?limit=200` pseudo-pagination and OFFSET cursor implementation on growing collections with a stable cursor contract.
- [ ] Promote the rich case-detail response into the shared typed `CaseRepository.get` contract; production JSON aggregate payloads are still typed as `unknown`.
- [ ] Wire required auth timing metrics into the existing observability system.
- [ ] Resolve Microsoft 365 requirements 2005/2006 against their actual online/desktop editing scope. Package-level Office conversion alone is not accepted as completion evidence.
- [ ] Re-assess all 138 requirements against the final current branch. The two disproven Microsoft 365 PASS rows are already overridden to GAP by the 2026-08-11 verification layer.

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
- [x] Current PR clean CONTROL/DATA migration and `db-verify` jobs are green in GitHub Actions.
- [x] Historical 2026-08-10 DATA evidence reports RLS + FORCE RLS on all 72 `app` tables; treat this as historical evidence only.
- [ ] Fresh CONTROL schema/ledger comparison completed against connected staging/live database.
- [ ] Fresh DATA schema/ledger comparison completed against connected staging/live database.
- [ ] Fresh RLS/policy inspection completed against connected staging/live database.
- [ ] Critical query plans and index choices verified in the target staging environment.
- [ ] Staging migration run green against the actual connected Kommunsign staging project.

Unverified production/staging migration state is **STOP-SHIP**.

## Security ready

- [x] Cross-tenant browser/API IDOR gate is green: Tenant B cannot read, list or mutate Tenant A's test case.
- [x] Current repository security suite is green for branding, SSRF, domains, uploads, invitations and OIDC.
- [x] Current repository secret scan is green.
- [ ] CSRF negative suite explicitly re-verified against the final production-auth runtime.
- [ ] Session revocation propagation explicitly re-verified against the final production-auth runtime.
- [ ] No unrotated known-compromised secrets.
- [ ] Provider mocks are impossible to activate in every final production deployment path.

Critical tenant-isolation, RLS or unrotated-secret failures are **STOP-SHIP**.

## Operational ready

- [ ] Required auth timing metrics emitted: `auth.rate_limit_ms`, `auth.provider_ms`, `auth.platform_lookup_ms`, `auth.membership_lookup_ms`, `auth.tenant_resolution_ms`, `auth.authorization_ms`, `auth.session_create_ms`, `auth.session_verify_ms`, `auth.redirect_ms`, `auth.total_ms`.
- [ ] Real p95 login/session/case measurements collected in a production-like environment; no values are to be invented.
- [ ] Worker retry/dead-letter visibility re-verified against the final runtime.
- [ ] Dependency health/readiness reflects enabled mandatory providers in the final runtime.
- [ ] Alerts/incident routes are operationally configured.
- [ ] Browser acceptance recorded for actual Windows 11 Edge, Windows 11 Chrome and supported Safari platform when procurement evidence requires those named browsers.

## Contract / procurement ready

- [ ] All 138 requirements re-assessed against current code/runtime/external evidence.
- [x] Requirement verification no longer reports 2005/2006 as PASS: the current generator applies dated 2026-08-11 evidence corrections and reports them as technical GAP.
- [ ] Requirements 2005 and 2006 have evidence for the Microsoft 365 behavior actually requested, not merely Office-file ingestion.
- [ ] Digg advanced electronic signature evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] TIC/BankID evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] Freja/Freja OrgID evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] MobilityGuard/municipal IdP runtime evidence complete or explicitly `BLOCKED_EXTERNAL`.
- [ ] Supplier/subprocessor/data-region evidence complete.
- [ ] PUB/DPA/SLA/support and organizational ISMS/HR evidence complete where required.
- [ ] Reference-customer evidence verified internally where required.

## Current verified requirement counts

Current CI generation on 2026-08-11 reports:

- SKA: 87 PASS, 2 GAP, 41 BLOCKED_EXTERNAL.
- BÖR: 7 PASS, 0 GAP/PARTIAL, 1 BLOCKED_EXTERNAL.
- Total: 138/138 assessed by the generator, but not all 138 have been independently re-evidenced in this rerun.

## Current gate

`CODE COMPLETE`: **NO**

`RUNTIME CONFIGURED`: **NO**

`PRODUCTION GO`: **NO**

`PROCUREMENT GO`: **NO**

These statuses must only be promoted by evidence generated after the outstanding technical and external gates above are resolved.
