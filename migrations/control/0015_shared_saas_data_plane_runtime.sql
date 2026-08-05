-- Purpose: register the production shared-SaaS data plane and release provisioning requests blocked by a missing registry row.
-- Impact: marks the canonical shared data plane ready in se-central and resets only requests blocked by data-plane readiness.
-- Backfill: preserves the existing data-plane identifier so existing tenant environments remain valid; no tenant data is moved.
-- Rollback: mark the row degraded and stop workers before reverting; do not delete a data-plane row referenced by tenant environments.
-- Verification: confirm one ready shared_saas row in se-central with database and storage secret references, then run db:verify.

BEGIN;

INSERT INTO control.data_planes AS plane(
  name,
  deployment_mode,
  status,
  region,
  connection_secret_reference,
  storage_secret_reference,
  release_version
)
VALUES (
  'legacy-shared-data-plane',
  'shared_saas',
  'ready',
  'se-central',
  'supabase-vault://kommunsign/data-database',
  'supabase-vault://kommunsign/data-storage',
  '0.2.0'
)
ON CONFLICT (name) DO UPDATE SET
  deployment_mode='shared_saas',
  status='ready',
  region='se-central',
  connection_secret_reference=CASE
    WHEN plane.connection_secret_reference='supabase-vault://legacy-shared-data-plane'
      THEN excluded.connection_secret_reference
    ELSE plane.connection_secret_reference
  END,
  storage_secret_reference=coalesce(plane.storage_secret_reference,excluded.storage_secret_reference),
  release_version=excluded.release_version,
  updated_at=now();

UPDATE control.tenant_provisioning_steps step
   SET status='pending',safe_error_code=null
  FROM control.tenant_provisioning_requests request
 WHERE request.id=step.provisioning_request_id
   AND request.deployment_mode='shared_saas'
   AND request.region='se-central'
   AND request.status='waiting_for_external_dependency'
   AND request.blocking_code IN ('DATA_PLANE_NOT_READY','DATA_PLANE_STORAGE_SECRET_MISSING')
   AND step.step_key='assign_data_plane';

UPDATE control.tenant_provisioning_requests
   SET status='queued',blocking_code=null,current_step='assign_data_plane',updated_at=now()
 WHERE deployment_mode='shared_saas'
   AND region='se-central'
   AND status='waiting_for_external_dependency'
   AND blocking_code IN ('DATA_PLANE_NOT_READY','DATA_PLANE_STORAGE_SECRET_MISSING');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM control.data_planes
     WHERE deployment_mode='shared_saas'
       AND status='ready'
       AND region='se-central'
       AND storage_secret_reference IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SHARED_SAAS_DATA_PLANE_NOT_READY';
  END IF;
END
$$;

COMMIT;
