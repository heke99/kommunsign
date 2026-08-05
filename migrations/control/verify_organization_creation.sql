\set ON_ERROR_STOP on

DO $$
BEGIN
  PERFORM control.assert_organization_creation_runtime();

  IF NOT EXISTS (
    SELECT 1
      FROM control.data_planes
     WHERE deployment_mode='shared_saas'
       AND status='ready'
       AND region='se-central'
       AND storage_secret_reference IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'DATABASE_RUNTIME_NOT_READY: shared SaaS data plane is not registered';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM control.tenant_provisioning_requests request
      JOIN control.platform_tenants tenant ON tenant.id=request.tenant_id
     WHERE request.status='completed'
       AND tenant.status='provisioning'
  ) THEN
    RAISE EXCEPTION 'DATABASE_RUNTIME_NOT_READY: completed tenant still has provisioning status';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = 'control'
       AND t.typname = 'provisioning_status'
       AND e.enumlabel = 'queued'
  ) THEN
    RAISE EXCEPTION 'DATABASE_SCHEMA_OUTDATED: control.provisioning_status lacks queued';
  END IF;
END
$$;

SELECT 'organization_creation_control_runtime_ok' AS verification;
