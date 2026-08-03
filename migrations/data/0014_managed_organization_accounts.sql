-- Purpose: Remove legacy automatically created applicant identities and make managed organization roles available to upgraded environments.
-- Impact: Disables legacy pending-invite users, removes their role assignments, and upserts the supported organization role catalogue for every existing organization.
-- Backfill: Existing organization environments receive the same role definitions as newly provisioned environments. No real authenticated user is created.
-- Rollback: Re-enable a specifically reviewed legacy identity only through an audited maintenance procedure; role definitions can be restored from the prior exported catalogue.
-- Verification: Confirm no active pending-invite identity or assignment remains and every organization has all managed role keys.

WITH legacy_memberships AS (
  SELECT m.tenant_id, m.id
    FROM app.memberships m
    JOIN app.users u
      ON u.tenant_id = m.tenant_id
     AND u.id = m.user_id
   WHERE u.external_subject LIKE 'pending-invite:%'
)
DELETE FROM app.role_assignments ra
 USING legacy_memberships legacy
 WHERE ra.tenant_id = legacy.tenant_id
   AND ra.membership_id = legacy.id;

UPDATE app.memberships m
   SET status = 'disabled'
  FROM app.users u
 WHERE u.tenant_id = m.tenant_id
   AND u.id = m.user_id
   AND u.external_subject LIKE 'pending-invite:%';

UPDATE app.users
   SET disabled_at = COALESCE(disabled_at, now())
 WHERE external_subject LIKE 'pending-invite:%';

WITH role_catalogue(role_key, permissions) AS (
  VALUES
    ('tenant_admin', '["case:create","case:send","case:cancel","case:read","case:remind","document:add","document:download","signer:add","signer:personnummer-binding-exempt","upload:create","validation:read","evidence:download","policy:manage","integration:manage","webhook:manage","event:read","template:read","template:manage","audit:read","archive:manage","tenant:manage"]'::jsonb),
    ('tenant_security_admin', '["case:read","validation:read","policy:manage","audit:read","event:read","integration:manage"]'::jsonb),
    ('tenant_integration_admin', '["case:create","case:read","document:add","signer:add","upload:create","integration:manage","webhook:manage","event:read","template:read"]'::jsonb),
    ('tenant_archive_admin', '["case:read","document:download","validation:read","evidence:download","archive:manage","audit:read","event:read"]'::jsonb),
    ('department_admin', '["case:create","case:send","case:cancel","case:read","case:remind","document:add","document:download","signer:add","upload:create","validation:read","evidence:download","template:read"]'::jsonb),
    ('document_creator', '["case:create","case:read","document:add","signer:add","upload:create","template:read"]'::jsonb),
    ('document_sender', '["case:create","case:send","case:cancel","case:read","case:remind","document:add","document:download","signer:add","upload:create","validation:read","evidence:download","template:read"]'::jsonb),
    ('approver', '["case:read"]'::jsonb),
    ('auditor', '["case:read","validation:read","event:read","audit:read"]'::jsonb),
    ('readonly', '["case:read","template:read"]'::jsonb)
), organization_tenants AS (
  SELECT DISTINCT tenant_id FROM app.organizations
)
INSERT INTO app.roles(tenant_id, role_key, permissions)
SELECT organization_tenants.tenant_id, role_catalogue.role_key, role_catalogue.permissions
  FROM organization_tenants
 CROSS JOIN role_catalogue
ON CONFLICT (tenant_id, role_key)
DO UPDATE SET permissions = EXCLUDED.permissions;

COMMENT ON COLUMN app.users.external_subject IS
  'Verified identity-provider subject. Legacy pending-invite placeholders are disabled by migration 0014 and must never be created by application onboarding.';
