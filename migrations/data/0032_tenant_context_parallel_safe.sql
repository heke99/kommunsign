-- Purpose: mark app.current_tenant_id() PARALLEL SAFE so queries against RLS-protected tables can use parallel plans.
-- Impact: every row level security policy in schemas app and audit is tenant_id = app.current_tenant_id(). The function is
--   STABLE, but it was left at the PARALLEL UNSAFE default. RLS predicates are injected during query rewrite, before the
--   planner evaluates parallel safety, so that default disqualified every query against every one of these tables from a
--   parallel plan. The function reads a transaction-local setting and touches no table, so it is genuinely parallel safe.
--   No policy, grant or predicate changes; only the function's parallel marking.
-- Backfill: none; this alters a function marking only and mutates no rows.
-- Rollback: ALTER FUNCTION app.current_tenant_id() PARALLEL UNSAFE;
-- Verification: select proparallel from pg_proc where proname = 'current_tenant_id' returns 's'. Tenant isolation tests must
--   still pass unchanged, since the function body and every policy using it are untouched.

ALTER FUNCTION app.current_tenant_id() PARALLEL SAFE;
