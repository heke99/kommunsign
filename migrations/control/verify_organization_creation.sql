\set ON_ERROR_STOP on

DO $$
BEGIN
  PERFORM control.assert_organization_creation_runtime();

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
