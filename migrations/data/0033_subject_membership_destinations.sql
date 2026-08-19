-- Purpose: make login's cross-tenant subject lookup an explicit SECURITY DEFINER resolver instead of a plain query that
--   silently depends on the runtime role holding BYPASSRLS.
-- Impact: login must map a verified subject to the tenants it belongs to before any tenant is known, so the lookup is
--   necessarily cross-tenant. It was written as an ordinary query with no tenant context set. Every table in app has
--   FORCE ROW LEVEL SECURITY with the policy tenant_id = app.current_tenant_id(), and with no context that function
--   returns NULL, so the query matches no rows for a role that respects RLS. That it works in production proves the
--   runtime role currently has BYPASSRLS, which contradicts docs/security/security-controls.md and means the database
--   layer of tenant isolation is not actually active.
--   This resolver makes the one deliberate cross-tenant read explicit, narrow and auditable: it returns only tenant ids
--   and a display name for a single subject, never domain rows. Once the runtime moves to a role without BYPASSRLS,
--   this path keeps working while every other query starts being enforced by RLS.
--   AGENTS.md rule 1 still holds: p_external_subject comes from a verified Supabase Auth response, never from a free
--   request field. The authorization decision for the chosen tenant is still made separately under
--   withTenantTransaction, so RLS governs it.
-- Backfill: none; this adds a function and mutates no rows.
-- Rollback: DROP FUNCTION app.subject_membership_destinations(text);
-- Verification: calling the function with a subject that has memberships returns one row per tenant, most recently
--   joined first. Calling it as a role without EXECUTE must raise insufficient_privilege. Tenant isolation tests must
--   still pass: the function must never return a row for a subject with no active membership.

CREATE OR REPLACE FUNCTION app.subject_membership_destinations(p_external_subject text)
RETURNS TABLE(tenant_id uuid, display_name text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=app,pg_temp AS $$
  SELECT u.tenant_id, min(u.display_name)
  FROM app.users u
  JOIN app.memberships m
    ON m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
  WHERE u.external_subject = p_external_subject
    AND u.disabled_at IS NULL
  GROUP BY u.tenant_id
  ORDER BY max(m.created_at) DESC, u.tenant_id
  LIMIT 25
$$;

REVOKE ALL ON FUNCTION app.subject_membership_destinations(text) FROM PUBLIC;
