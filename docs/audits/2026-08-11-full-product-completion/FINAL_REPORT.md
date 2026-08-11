# Final report — Kommunsign full product completion rerun 2026-08-11

> **LIVE STATUS DOCUMENT.** This is the authoritative technical/readiness report for the 2026-08-11 rerun. Earlier reports are historical snapshots where they conflict with this document.

## Baseline

- Repository: `heke99/kommunsign`
- Baseline branch: `main`
- Baseline commit: `62ccda967cbcba596aa684dabc171355ff65f1ca`
- Previous campaign: PR #3 was already merged on 2026-08-10 and was therefore treated as historical input, not reused as the work branch.

## Branch / PR

- Branch: `remediation/kommunsign-full-product-completion-rerun-2026-08-11`
- Draft PR: #4 → `main`
- Merge status: **not merged**. The branch intentionally remains draft while technical or external gates are open.

## Scope actually verified in this rerun

The rerun inspected and/or exercised:

- repository baseline and previous remediation history;
- current GitHub Actions verification and clean database replay;
- server-authoritative signature-case detail;
- tenant portal create/upload/signer/detail/refresh/send behavior;
- independent browser-context state reconstruction;
- explicit cross-tenant IDOR reads/lists/mutations;
- production upload boundary and document-processing assumptions;
- original Kungälv Microsoft 365 requirements 2005/2006;
- current requirement generator and stale historical assessments;
- authentication roundtrip shape and observability vocabulary;
- current pagination implementation;
- current ability to reach the connected Kommunsign CONTROL/DATA Supabase projects;
- historical readiness reports that contradicted the fresh evidence.

The master prompt is broader than the items independently re-verified on 2026-08-11. No older PASS is silently promoted to fresh runtime evidence merely because it exists in a historical report.

## Skills / competence routing

See `SKILL_ROUTING.md` in this directory. GitHub repository/PR/CI diagnostics, Supabase, PostgreSQL/RLS/query review, API contract review, browser E2E, multi-tenancy, document processing, observability, security and procurement evidence review were actively applied.

## Canonical architecture after this rerun

No parallel auth, RBAC, tenant, signing, audit or database system was introduced.

Confirmed properties:

- production case detail is loaded inside tenant-scoped DATA transactions;
- tenant portal business state is reconstructed from API/server state rather than a browser-only `Map`;
- development runtime now returns the documents, signers and events the portal requires and preserves creator + selected policy metadata;
- enabled production provider paths remain fail-closed when mandatory external capabilities are not configured;
- existing repository observability remains the canonical target for auth timing instrumentation;
- existing migration-led architecture remains canonical.

## Implemented changes

### 1. Real browser E2E instead of a placeholder

The old `test:e2e` placeholder (`E2E_TEST_ENVIRONMENT_NOT_CONFIGURED`) was replaced by a real Playwright journey and a dedicated PR workflow.

The gate runs Chromium, Firefox and WebKit and covers:

1. tenant portal load;
2. case creation;
3. PDF upload grant;
4. upload to private quarantine path;
5. upload completion;
6. document attachment to case;
7. signer creation;
8. rich case-detail read;
9. browser refresh;
10. document + signer reconstruction from API;
11. a separate browser context reading the same server state;
12. send transition.

The first executions failed and exposed real defects. The failures were not skipped: selector handling, upload-preflight support and the shallow development case-detail runtime were corrected. The resulting browser workflow is green.

### 2. Explicit tenant-isolation browser/API gate

The E2E suite now creates separate Tenant A and Tenant B identities. It verifies that Tenant B cannot:

- fetch Tenant A's case ID;
- see Tenant A's case in its list;
- add a signer to Tenant A's case.

The expected result is 404/fail-closed behavior. The gate is green.

### 3. Development/runtime case-detail synchronization

The development runtime previously returned only the shallow case view even though the portal consumed `documents`, `signers` and `events`. Browser E2E exposed this as a real runtime crash after upload.

The development runtime now builds server detail including policy snapshot identity, creator metadata, documents, signers, events and artifact availability flags. A later self-review also corrected two evidence-semantic defects: `createdBy` no longer becomes the current reader, and policy metadata is no longer inferred only from decision mode.

### 4. Modern CI runtime

The PR workflows now use SHA-pinned current action generations for checkout/setup-node and a pinned current Playwright runtime. Clean DB, repository verify and browser E2E remain separate gates.

### 5. Requirement verification no longer emits a false M365 PASS

A dated 2026-08-11 evidence-override layer was added to the existing Kungälv generator. It does **not** alter original requirement text. It only corrects historical assessments that fresh evidence disproves.

Current generator output:

- SKA: **87 PASS / 2 GAP / 41 BLOCKED_EXTERNAL**;
- BÖR: **7 PASS / 0 GAP / 0 PARTIAL / 1 BLOCKED_EXTERNAL**;
- total: **138/138 assessed**.

The two GAP rows are 2005 and 2006.

### 6. Contradictory old readiness reports are marked historical

The 2026-08-07 final/readiness reports that said no technical gap remained are explicitly labelled `HISTORICAL SNAPSHOT — SUPERSEDED` and point to this report/current checklist.

## Verification evidence

On the rerun branch, GitHub Actions has produced green evidence for the code state preceding only documentation-only status updates:

- `npm ci --ignore-scripts` — green;
- TypeScript build — green;
- repository verification — green;
- deployment configuration verification — green;
- SQL migration static verification — green;
- requirement generator — green with 87/2/41 SKA status;
- provenance — green;
- SDK sync — green;
- WCAG static automation — green;
- repository secret scan — green;
- Java/Freja boundary self-test — green;
- **98 unit tests** — green;
- integration suites — green;
- security suite — green;
- public website build — green;
- SBOM generation — green;
- clean isolated CONTROL + DATA PostgreSQL migration replay — green;
- `db-verify.sh` — green;
- Chromium / Firefox / WebKit E2E — green;
- cross-tenant IDOR gate — green.

These automated results do not replace external production credentials, live database inspection, manual WCAG acceptance, named-browser procurement acceptance or cryptographic/provider evidence.

## Database

### Repository / clean replay

The current CI creates isolated CONTROL and DATA databases, applies migrations and executes `db-verify.sh`. This is green.

### Connected Kommunsign databases

A fresh 2026-08-11 inspection of the actual connected Kommunsign CONTROL and DATA Supabase projects could **not** be completed. Both known project identifiers return permission denied through the currently connected Supabase account.

Historical 2026-08-10 evidence recorded migration-ledger reconciliation after object verification and 72/72 DATA `app` tables with RLS + FORCE RLS. This remains historical evidence only.

**Fresh live database status: NOT RE-VERIFIED.**

No ad-hoc production schema write was attempted.

## Performance

No latency number is invented in this report.

Confirmed code observations:

- earlier remediation parallelized eligible tenant primary-domain resolution;
- login still has distinct rate-limit, provider, destination/access, cleanup and session-creation phases;
- the named auth timing series requested by the master prompt is not yet emitted;
- case list still uses OFFSET-based cursor semantics and tenant UI still uses a large single-page request;
- therefore requested login p95 and stable pagination performance gates are not proven.

### Required auth metrics still missing

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

**Status: technical gap.**

## Product E2E

### Proven green in automation

Tenant create/upload/signer/detail/refresh/independent-context/send is green in Chromium, Firefox and WebKit. Server state reconstruction and tenant IDOR are included.

### Not proven by that automation

- server restart persistence against a real persistent staging DATA plane;
- completed real signer journey using a configured production-equivalent identity/signing provider;
- final signed PDF download from real signing crypto;
- real validation report from configured validator;
- real evidence package + archive export against production-equivalent external services.

Those must remain blocked unless actual runtime dependencies are configured.

## Browser

Engine automation is green for Chromium, Firefox and WebKit.

That is **not** represented as final named-browser procurement acceptance. When the Kungälv requirement requires exact environments, acceptance still needs recorded runs on:

- Windows 11 + Microsoft Edge;
- Windows 11 + Google Chrome;
- supported Apple platform + Safari.

## Security

Fresh rerun evidence includes:

- tenant A/B read isolation;
- tenant A/B list isolation;
- tenant A/B mutation isolation;
- current repository security suite green for branding, SSRF, domains, uploads, invitations and OIDC;
- current repository secret scan green;
- fail-closed provider behavior retained.

Not promoted to final production evidence in this report:

- fresh live RLS/policy inspection;
- production-auth session-revocation propagation;
- actual operational rotation of any historically exposed key;
- real IdP/provider/crypto configuration.

Operational rotation support in code is not evidence that a leaked key was actually rotated.

## Microsoft 365 — requirements 2005/2006

Original requirement 2005 requires the solution to function together with Microsoft 365 with **online and desktop editing** on personal computers. Requirement 2006 requires Microsoft 365 **online** behavior on shared computers.

The current active tenant flow is PDF-only:

- portal validates `%PDF-`;
- portal requests `application/pdf` upload;
- `/v1/uploads` is used as a PDF upload boundary;
- production upload validation rejects non-PDF MIME types;
- worker canonicalization assumes the PDF flow.

`packages/document-processing/src/office-ingestion.ts` is useful Office→PDF conversion functionality, but it is not a Microsoft 365 online/desktop editing integration.

Therefore both older PASS rows were corrected to **GAP**. This is a technical gap, not an external blocker that may be hidden behind credentials.

## Shared case-detail contract

Runtime behavior is now synchronized and browser-proven, but the shared `CaseRepository.get` TypeScript return type remains the shallow `SignatureCaseView`. Production JSON aggregate payloads for documents/signers/events are also typed as `unknown` inside the DATA adapter.

The correct remediation is to promote a rich detail type through the shared contract and type/validate the SQL JSON aggregates. A cosmetic cast is intentionally not used.

**Status: technical gap.**

## Pagination

Case/event/template production list queries still include OFFSET-based pagination helpers. The tenant case screen also issues a large single list request.

The master prompt explicitly requires stable cursor pagination for growing collections. That work is not complete.

**Status: technical gap.**

## Kungälv — requirement integrity

The repository still contains all 138 original requirements. Fresh verification corrected the two disproven M365 rows instead of preserving a false green matrix.

Current automated classification is:

```text
SKA PASS: 87
SKA GAP: 2
SKA PARTIAL: 0
SKA BLOCKED_EXTERNAL: 41
BÖR PASS: 7
BÖR GAP: 0
BÖR PARTIAL: 0
BÖR BLOCKED_EXTERNAL: 1
TOTAL: 138
```

This does **not** satisfy the master prompt's final requirement that technical GAP/PARTIAL be zero. All 138 rows also still require final evidence reconciliation after technical remediation; historical PASS rows are not automatically fresh runtime evidence.

## External blockers

Where implementation is complete, real external evidence remains necessary for applicable requirements, including:

### Identity

- TIC production credentials and actual production BankID runtime evidence;
- Freja/Freja OrgID relying-party credentials and mTLS/runtime evidence;
- Kungälv MobilityGuard/IdP metadata and actual federation acceptance.

### Signing

- CA/signing certificate chain;
- signing-key custody;
- HSM/remote QSCD or selected approved equivalent;
- TSA/RFC3161 where required;
- real final PAdES/validation evidence.

### Supplier / organization / contracts

- data-region and subprocessor evidence;
- PUB/DPA and contractual appendices;
- SLA/support evidence;
- ISMS/LIS and personnel/process evidence;
- restore exercise evidence;
- reference-customer evidence where required.

## Stop-ship

Current stop-ship / GO blockers include:

1. Microsoft 365 requirements 2005/2006 remain technical GAP.
2. Stable cursor pagination remains a technical gap.
3. Required auth stage instrumentation/measurements remain a technical gap.
4. Shared rich case-detail typing remains incomplete, despite runtime behavior being fixed.
5. Fresh live CONTROL/DATA schema/RLS/policy comparison is unavailable through the currently connected Supabase account.
6. Any historically exposed production-sensitive key requires verified operational rotation before sensitive production data.
7. Mandatory signing crypto and identity dependencies must be configured and proven before the corresponding production capability is advertised as ready.

## Remaining risk

- older assessment content can still be read historically, but it is now explicitly superseded and the current generator applies dated evidence corrections;
- OFFSET pagination can degrade and can produce inconsistent page boundaries during concurrent inserts;
- missing auth-stage metrics prevents evidence-based p95 optimization;
- shared shallow case typing can permit future runtime/UI drift unless promoted to a canonical detail contract;
- browser engine automation does not replace exact named-browser/manual acceptance;
- live-database state cannot be claimed current without restored Supabase access.

## Final status

```text
TECHNICAL STATUS:
TECHNICAL NO-GO
```

Reason: technical GAP ≠ 0. M365 2005/2006, stable cursor pagination, required auth instrumentation and shared rich case-detail typing remain open.

```text
PRODUCT STATUS:
PRODUCT NO-GO
```

Reason: central browser workflow is now green, but the product still does not meet the complete Microsoft 365 requirement scope and real externally backed signing completion cannot be represented as production-proven without its dependencies.

```text
PRODUCTION STATUS:
PRODUCTION NO-GO
```

Reason: fresh connected CONTROL/DATA verification is unavailable, external production identity/signing/crypto evidence remains incomplete and operational key-rotation evidence is still required where historical exposure occurred.

```text
PROCUREMENT / EXTERNAL STATUS:
BLOCKED
```

Reason: the current matrix correctly contains two technical GAP rows plus external evidence blockers. The master prompt's final 0 technical GAP/PARTIAL procurement gate is therefore not satisfied.

## Merge decision

**Do not merge PR #4 yet.** CI being green does not override the technical and external NO-GO gates above.
