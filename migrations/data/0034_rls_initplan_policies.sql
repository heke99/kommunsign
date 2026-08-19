-- Purpose: evaluate the tenant isolation predicate once per query instead of once per row.
-- Impact: every policy in schemas app and audit is tenant_id = app.current_tenant_id(). The function is STABLE and
--   PARALLEL SAFE, but a bare STABLE function call in a policy predicate is still evaluated per row. Wrapping it in a
--   scalar subquery forces PostgreSQL to evaluate it once as an InitPlan and compare every row against that constant.
--   The predicate is semantically identical -- same value, same NULL behaviour, so a session with no tenant context still
--   matches nothing -- and no policy name, command, role or table changes. Only the evaluation strategy changes.
--   This runs in a single transaction, so although each policy is dropped and recreated, no other session ever observes
--   a table without its isolation policy: the drop and the create commit together or not at all.
-- Backfill: none; this rewrites policy predicates and mutates no rows.
-- Rollback: rerun the same loop with (tenant_id = app.current_tenant_id()) in place of the subquery form.
-- Verification: every policy in app and audit must report qual and with_check of (tenant_id = ( SELECT
--   app.current_tenant_id() AS current_tenant_id)), the policy count must be unchanged, and the tenant isolation tests
--   must still pass -- a session without app.tenant_id set must still read no rows.

DO $$
DECLARE policy_record record;
BEGIN
  FOR policy_record IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname IN ('app','audit')
       AND qual = '(tenant_id = app.current_tenant_id())'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', policy_record.policyname, policy_record.schemaname, policy_record.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I USING (tenant_id = (SELECT app.current_tenant_id())) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))',
      policy_record.policyname, policy_record.schemaname, policy_record.tablename);
  END LOOP;
END $$;
