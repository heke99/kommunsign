# Skill routing — full product completion 2026-08-10

## Scope

This routing is the execution record for the remediation branch `remediation/kommunsign-full-product-completion-2026-08-10`. It distinguishes skills actually applied from skills that remain conditional.

| Område | Tillämpning | Resultat hittills |
|---|---|---|
| Repository understanding | GitHub baseline, tree, current remediation reports, local ZIP inventory | Applied |
| Architecture | CONTROL/DATA separation, API/router and tenant boundaries reviewed | Applied |
| Supabase/PostgreSQL | Live schema inventory for both Kommunsign projects; migration ledger and RLS inspected | Applied |
| RLS / tenant isolation | Live DATA `app` tables checked for RLS + FORCE RLS and tenant policies | Applied; all inspected app tables are RLS+FORCE RLS |
| Database migration integrity | Repository migrations compared with live `kommunsign_meta.schema_migrations` | Applied; drift identified |
| Security / fail closed | AGENTS rules and final remediation claims reviewed against current code | Applied |
| Authentication / authorization | Auth routing and tenant-context boundaries inspected | Applied; deeper latency profiling remains |
| API design | `/v1/signature-cases/:id` route exists; response contract inspected | Applied; response is currently too shallow for the masterprompt case-detail contract |
| Multi-tenancy | Tenant-scoped queries and composite-key/RLS posture reviewed | Applied |
| Performance / SQL optimization | Session/case query paths inspected; live PostgreSQL 17 + pg_stat_statements availability checked | Applied; real p95 load benchmark remains |
| Observability | Existing observability package and requested auth timing points identified | Partial; timing instrumentation/benchmark remains |
| Accessibility | Existing WCAG gate and prior remediation reviewed | Existing gate present; browser-level verification remains |
| E2E / browser testing | Test scripts and current portal architecture reviewed | Remaining: runtime browser execution is not yet evidenced |
| CI/CD | `npm run verify` contract and GitHub repository state reviewed | Applied; local `npm ci` is blocked by the available package registry, so a clean local verify could not be executed in this environment |
| Threat modeling | Existing threat model reviewed as historical evidence | Remaining deep review |
| Documentation / ADR | Existing reports, readiness and architecture docs reviewed | Applied; this audit is the current execution record |

## Important distinction

Installed skills are not treated as evidence of execution. A skill is marked applied only when a concrete repository, database, security, performance or verification activity was performed during this campaign.

## External prerequisites

No code change may manufacture production evidence for CA/HSM/QSCD/TSA, TIC production credentials, Freja relying-party credentials, customer IdP metadata, contracts, supplier evidence or organizational controls. Those remain `BLOCKED_EXTERNAL` unless independently supplied and verified.
