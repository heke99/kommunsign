-- Purpose: repair and verify the control-plane objects required by direct organization creation.
-- Impact: restores the encrypted idempotency response column if migration history and the live schema drifted apart, and adds a fail-closed runtime contract check.
-- Backfill: existing idempotency rows are left unchanged; they expire according to their original retention window.
-- Rollback: stop organization creation, remove the runtime assertion function, and remove the additive index/column only in a maintenance window after all idempotency rows expire.
-- Verification: run migrations/control/verify_organization_creation.sql and then create a disposable organization through POST /v1/platform/organizations.

BEGIN;

ALTER TABLE control.onboarding_idempotency_keys
  ADD COLUMN IF NOT EXISTS response_body_ciphertext bytea;

COMMENT ON COLUMN control.onboarding_idempotency_keys.response_body_ciphertext IS
  'Envelope-encrypted serialized idempotency response. Required by production onboarding and direct organization creation.';

CREATE INDEX IF NOT EXISTS onboarding_idempotency_expiry_idx
  ON control.onboarding_idempotency_keys(expires_at);

CREATE OR REPLACE FUNCTION control.assert_organization_creation_runtime()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, control
AS $$
DECLARE
  missing_objects text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('control.onboarding_applications') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.onboarding_applications');
  END IF;
  IF to_regclass('control.onboarding_application_versions') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.onboarding_application_versions');
  END IF;
  IF to_regclass('control.tenant_provisioning_requests') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.tenant_provisioning_requests');
  END IF;
  IF to_regclass('control.tenant_provisioning_steps') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.tenant_provisioning_steps');
  END IF;
  IF to_regclass('control.onboarding_idempotency_keys') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.onboarding_idempotency_keys');
  ELSIF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'control'
       AND table_name = 'onboarding_idempotency_keys'
       AND column_name = 'response_body_ciphertext'
  ) THEN
    missing_objects := array_append(missing_objects, 'control.onboarding_idempotency_keys.response_body_ciphertext');
  END IF;
  IF to_regclass('control.control_audit_events') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.control_audit_events');
  END IF;
  IF to_regclass('control.onboarding_application_reference_seq') IS NULL THEN
    missing_objects := array_append(missing_objects, 'control.onboarding_application_reference_seq');
  END IF;

  IF cardinality(missing_objects) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'DATABASE_SCHEMA_OUTDATED',
      DETAIL = array_to_string(missing_objects, ',');
  END IF;
END;
$$;

COMMENT ON FUNCTION control.assert_organization_creation_runtime() IS
  'Fail-closed schema contract used before direct organization creation. Does not read tenant or applicant data.';


COMMIT;
