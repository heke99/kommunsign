# Skill routing — Kommunsign full product completion rerun 2026-08-11

Baseline: `62ccda967cbcba596aa684dabc171355ff65f1ca` (`main`).
Branch: `remediation/kommunsign-full-product-completion-rerun-2026-08-11`.

This rerun starts from current `main`. The 2026-08-10 remediation branch was already merged as PR #3 and is treated as historical evidence rather than as an active work branch.

| Skill / competence | Area | Why used | Applied to | Result |
|---|---|---|---|---|
| GitHub repository workflow | repository understanding, branches, commits, PR, CI | Establish current source of truth and publish isolated remediation safely | `main`, PR #3 history, new remediation branch, PR #4, GitHub Actions | Exact baseline established; old branch not reused; draft PR opened; CI evidence collected per commit |
| GitHub CI diagnostics | debugging, CI/CD | The old `test:e2e` command was a deliberate fail-closed stub and browser E2E was absent from CI | `package.json`, `.github/workflows`, workflow runs and job logs | Real browser workflow added; failures are being fixed from root cause rather than bypassed |
| Supabase | deployed database verification | The master prompt requires repository ↔ deployed CONTROL/DATA comparison | Kommunsign CONTROL/DATA project identifiers from repository evidence | Current connector returns permission denied for both projects. No 2026-08-11 live-schema PASS is claimed; 2026-08-10 evidence remains historical only |
| Supabase Postgres best practices | PostgreSQL, RLS, query/index review | Check tenant isolation, query shape, pagination and index assumptions without blind indexing | DATA repository queries, RLS evidence, case list/detail, auth lookups | Confirmed OFFSET pseudo-cursors on production list paths; no blind index addition made without query-plan evidence |
| Multi-tenancy / RLS review | tenant isolation, authorization | Cross-tenant access is a stop-ship class defect | repository contracts, production DATA queries, historical live RLS evidence | Production case/detail queries carry `tenant_id`; current live RLS could not be re-queried because Supabase permission is unavailable |
| API / contract review | API, pagination, server-authoritative state | Browser state must not be business source of truth and growing collections require real pagination | `GET /v1/signature-cases/:id`, case list, tenant portal | Server case-detail exists from prior remediation; list UI still requests `limit=200` and DB cursor is OFFSET-based — open technical gap |
| Browser / E2E testing | product flow, browser compatibility | The master prompt requires actual browser automation, not a placeholder command | tenant create → upload → signer → refresh → send; Chromium/Firefox/WebKit | Browser gate added. It is intentionally blocking until the real journey passes |
| Document processing review | upload, quarantine, Office, PDF/A | Requirements 2005/2006 were marked PASS but must be checked against the real product boundary and original wording | tenant portal, `/v1/uploads`, worker pipeline, `office-ingestion.ts`, Kungälv original requirements | Confirmed false-PASS risk: package-level Office conversion exists, but product upload boundary is PDF-only and 2005/2006 require Microsoft 365 online/desktop editing behavior |
| Observability review | auth performance, log safety, metrics | Prompt requires named auth timing series and forbids fake performance claims | `packages/observability`, authentication repository | Existing canonical observability package is retained; required auth timing metrics are not yet wired. No p95 values invented |
| Security review | fail closed, secrets, provider readiness | External credentials/crypto must never be converted into fake success | provider readiness, old remediation evidence, CI | External crypto/identity/runtime evidence remains blocked where not verifiable; no production-ready claim is made |
| Requirements/evidence review | procurement readiness | 138 requirements must be individually evidence-based and contradictory readiness docs must be reconciled | `requirements.json`, `assessments.json`, `REQUIREMENT_MATRIX.md`, readiness docs | Original M365 wording checked; stale 2026-08-07 assessments and contradictory status documents identified for reconciliation |

## Rules retained during implementation

- No alternate auth, RBAC, tenant, signing, audit or database system is introduced.
- Existing canonical packages and repositories are extended rather than replaced.
- No external provider is marked successful without runtime evidence.
- No performance number is reported unless measured.
- No current live-database assertion is made while the connected Supabase account lacks permission.
