# Final report — Kommunsign full product completion rerun 2026-08-11

> **LIVE STATUS DOCUMENT.** This report supersedes earlier completion/readiness summaries where they conflict with evidence from the 2026-08-11 rerun.

This file is updated as remediation proceeds. It must not be converted to GO until every claimed gate has matching evidence.

## Baseline

- Repository: `heke99/kommunsign`
- Start branch: `main`
- Start commit: `62ccda967cbcba596aa684dabc171355ff65f1ca`
- Previous remediation: PR #3 was already merged to `main` on 2026-08-10 and is historical input only.

## Branch

`remediation/kommunsign-full-product-completion-rerun-2026-08-11`

Draft PR: #4 against `main`.

## Scope actually reviewed in this rerun

- repository and prior remediation history
- GitHub Actions and verification commands
- server-authoritative case detail and tenant portal consumption
- tenant create/upload/signer/refresh/send browser journey
- production upload boundary and document worker assumptions
- Microsoft 365 requirements 2005/2006 against their original requirement wording
- production case list pagination implementation
- authentication roundtrip shape
- existing observability metric vocabulary
- current Kungälv requirement/readiness documents
- current availability of connected Supabase live-database verification

The complete master-prompt scope is larger than the items above. Items not independently re-verified on 2026-08-11 are not silently inherited as current PASS from an older report.

## Skills

See `SKILL_ROUTING.md` in this directory. GitHub, CI diagnostics, Supabase, PostgreSQL/RLS/query review, API contract review, browser E2E, document processing, observability, security and procurement evidence review were applied.

## Architecture

The existing canonical architecture is retained. No parallel auth, RBAC, tenant, signing, audit or database system was introduced.

Verified architectural properties:

- production case detail is fetched server-side inside tenant-scoped DATA transactions;
- tenant portal reloads selected case detail through the API rather than using the removed browser-only authoritative case map;
- provider/production paths continue to use fail-closed status semantics where external services are not configured;
- the existing `packages/observability` module remains the canonical metrics/logging layer and is the target for required auth instrumentation.

## Implemented changes in this rerun

### Browser E2E and CI

The former `test:e2e` placeholder was replaced by a real Playwright browser journey. A dedicated GitHub Actions workflow installs and runs Chromium, Firefox and WebKit and exercises:

1. tenant portal load,
2. case creation,
3. PDF upload grant and quarantine path,
4. signer creation,
5. case-detail retrieval,
6. browser refresh,
7. server state reconstruction,
8. send transition.

The gate remains fail-closed while a browser journey fails. Failures have been debugged from workflow logs rather than skipped.

### Production readiness gate

`docs/readiness/PRODUCTION_GO_LIVE_CHECKLIST.md` now separates code, runtime, credentials, signing crypto, identity, database, security, operations and procurement.

## Confirmed technical findings still open

### T1 — Microsoft 365 requirements 2005/2006 are not evidenced by Office ingestion

Original requirement 2005 requires the offered solution to work together with Microsoft 365 with online and desktop editing on personal computers. Requirement 2006 requires Microsoft 365 online behavior on shared computers.

Current runtime boundary is PDF-only:

- tenant upload UI accepts PDF;
- tenant client checks `%PDF-` and sends `application/pdf`;
- `/v1/uploads` allows `application/pdf`;
- production DATA upload validation rejects other MIME types;
- worker scan/canonicalization path assumes PDF.

`packages/document-processing/src/office-ingestion.ts` is useful package-level code but is not evidence of the requested Microsoft 365 editing integration and is not wired as the current tenant upload runtime.

**Status:** technical gap / requirement status must not remain PASS until the actual requested behavior is implemented and verified. If that integration is outside the selected product architecture, this is a `TECHNICAL NO-GO` for claiming full Kungälv compliance, not a reason to reinterpret the requirement.

### T2 — Growing case list still uses pseudo-pagination

Tenant UI requests `/v1/signature-cases?limit=200`. Production repository translates the cursor to an integer OFFSET. This does not meet the master prompt's stable cursor pagination requirement and can degrade with large data sets or concurrent inserts.

**Status:** technical gap.

### T3 — Required auth timing series are not wired

The existing observability module has safe metric/log structures, but the required auth timing series are not currently present/wired:

- `auth.rate_limit_ms`
- `auth.provider_ms`
- `auth.platform_lookup_ms`
- `auth.membership_lookup_ms`
- `auth.tenant_resolution_ms`
- `auth.authorization_ms`
- `auth.session_create_ms`
- `auth.session_verify_ms`
- `auth.redirect_ms`
- `auth.total_ms`

No p95 values are claimed without measurement.

**Status:** technical gap.

### T4 — Case-detail type contract is shallower than production response

The production repository returns policy, document, signer, event, evidence and archive detail, but the shared `CaseRepository.get` type remains `SignatureCaseView`. That weakens API/implementation synchronization and lets development runtime return only the shallow case even though the UI expects richer detail.

**Status:** technical gap; browser E2E is being used to expose this class of mismatch.

## Database

### Repository / CI

The existing CI includes a clean PostgreSQL CONTROL/DATA migration/verification job. The 2026-08-10 run was green.

### Live CONTROL/DATA

A fresh 2026-08-11 live verification could not be performed through the connected Supabase tool: both known Kommunsign project identifiers return permission denied for the current connected account.

Historical 2026-08-10 evidence reports migration-ledger reconciliation after object verification and 72/72 DATA `app` tables with RLS + FORCE RLS. This is retained as historical evidence only.

**Current live-database status:** NOT RE-VERIFIED.

**Production impact:** production/staging database readiness remains blocked until fresh schema/migration/RLS/policy verification is available.

## Performance

No before/after latency numbers are reported because no production-like timing sample has been collected in this rerun.

Confirmed code observations:

- prior remediation parallelized eligible tenant primary-domain resolution;
- auth still has distinct phases for rate limiting, provider authentication, destination/access resolution, rate-limit cleanup and session creation;
- required auth timing instrumentation is not yet emitted;
- production case listing uses OFFSET pagination and must be remediated before claiming the requested scale behavior.

## Product E2E

Current browser gate targets Chromium, Firefox and WebKit. It is intentionally considered **not passed** until the latest workflow run concludes green across all three engines.

A passing Playwright engine is useful automation evidence, but it does not replace final procurement acceptance on actual Windows 11 Edge, Windows 11 Chrome and a supported Safari platform when those named browsers are required.

## Security

No new authorization bypass or tenant bypass was introduced by the browser E2E changes. Production provider and artifact operations remain fail closed when dependencies are unavailable.

A complete post-implementation security review must be rerun after the remaining technical changes. Historical security tests are not represented as a final 2026-08-11 result before that rerun.

Known stop-ship class items retained from prior evidence include operational rotation of any previously exposed sensitive keys until rotation is actually evidenced. Code support for rotation is not operational rotation.

## Kungälv — 138 requirements

The repository contains the original 138 requirements and a generated requirement matrix, but current status documents are inconsistent:

- an older readiness snapshot contains PARTIAL/GAP counts;
- a later generated matrix reports zero technical GAP/PARTIAL;
- `assessments.json` is dated 2026-08-07 and states it was assessed against an older remediation branch;
- requirements 2005/2006 are marked PASS based on Office conversion even though the original wording requires Microsoft 365 online/desktop editing behavior and current product upload is PDF-only.

Therefore the old 96 PASS / 42 BLOCKED summary is **not accepted as the authoritative final 2026-08-11 disposition** until all 138 entries are reconciled against current implementation and the false-PASS risk is removed.

## External blockers

External/runtime evidence remains required where applicable for:

- TIC production credentials and production BankID runtime verification;
- Freja/Freja OrgID RP credentials and mTLS/runtime evidence;
- Kungälv MobilityGuard/IdP metadata and real federation acceptance;
- CA/signing certificate chain;
- HSM/remote QSCD or approved signing-key custody;
- TSA/RFC3161 where required;
- supplier/subprocessor/data-region evidence;
- PUB/DPA/SLA/support/organizational ISMS and personnel controls;
- restore exercise and named-browser/manual acceptance where required.

These are `BLOCKED_EXTERNAL` only when the implementation itself is complete. They must not be used to hide a code gap.

## Stop ship

Current stop-ship / GO blockers:

1. Microsoft 365 2005/2006 technical scope is not implemented/evidenced as currently claimed.
2. Fresh live CONTROL/DATA verification is unavailable because the connected Supabase account lacks permission.
3. Browser E2E must be green on the final branch.
4. Any previously exposed production-sensitive key must have verified operational rotation before sensitive production use.
5. Mandatory production signing crypto/identity dependencies must be configured and verified for capabilities advertised as production-ready.

## Remaining risks

- stale procurement assessments can create false compliance claims if consumed without the rerun status;
- OFFSET pagination can become slow/inconsistent under larger and concurrent case populations;
- shallow shared case-detail typing can hide divergence between dev and production runtimes;
- missing auth stage metrics prevents evidence-based latency optimization;
- browser automation uses engine-level coverage and still needs named-browser/platform acceptance where the contract requires it.

## Final status — current rerun state

```text
TECHNICAL STATUS:
TECHNICAL NO-GO
```

Technical blockers: Microsoft 365 requirements 2005/2006 are not implemented/evidenced to their actual wording; stable pagination and required auth instrumentation remain open; browser E2E is not yet green; case-detail contract synchronization remains incomplete.

```text
PRODUCT STATUS:
PRODUCT NO-GO
```

Product blocker: the required final browser journey is not yet proven green and the Microsoft 365 product requirement is not fulfilled by the current PDF-only runtime.

```text
PRODUCTION STATUS:
PRODUCTION NO-GO
```

Production blockers: fresh live database verification unavailable; mandatory external credentials/crypto/runtime evidence remains incomplete; operational key rotation must be evidenced where previously exposed keys existed.

```text
PROCUREMENT / EXTERNAL STATUS:
BLOCKED
```

Procurement blockers: 138-requirement current evidence reconciliation is incomplete, 2005/2006 false-PASS risk is confirmed, and external identity/signing/organizational/supplier evidence remains outstanding.

These statuses are deliberately conservative. They are to be promoted only after the remaining technical gaps are fixed and the corresponding CI/runtime/external evidence exists.
