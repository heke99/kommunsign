-- Purpose: keep completed tenant provisioning, organization status and managed-account invitations consistent.
-- Impact: moves completed provisioned tenants from provisioning to onboarding and preserves active environments.
-- Backfill: updates only tenants with a completed provisioning request; no tenant-owned data or identities are removed.
-- Rollback: restore individual tenant status only after reviewing its provisioning request and environment state.
-- Verification: no completed provisioning request may leave its tenant in provisioning status.

BEGIN;

UPDATE control.platform_tenants tenant
   SET status='onboarding',updated_at=now(),version=version+1
  FROM control.tenant_provisioning_requests request
 WHERE request.tenant_id=tenant.id
   AND request.status='completed'
   AND tenant.status='provisioning';

UPDATE control.tenant_environments environment
   SET status='onboarding',updated_at=now()
  FROM control.tenant_provisioning_requests request
 WHERE request.tenant_id=environment.tenant_id
   AND request.status='completed'
   AND environment.environment='production'
   AND environment.status<>'active';

UPDATE control.onboarding_applications application
   SET status='onboarding',status_version=status_version+1,updated_at=now()
  FROM control.tenant_provisioning_requests request
 WHERE request.application_id=application.id
   AND request.status='completed'
   AND application.status='provisioning';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM control.tenant_provisioning_requests request
      JOIN control.platform_tenants tenant ON tenant.id=request.tenant_id
     WHERE request.status='completed'
       AND tenant.status='provisioning'
  ) THEN
    RAISE EXCEPTION 'COMPLETED_PROVISIONING_WITH_PROVISIONING_TENANT_STATUS';
  END IF;
END
$$;

COMMIT;
