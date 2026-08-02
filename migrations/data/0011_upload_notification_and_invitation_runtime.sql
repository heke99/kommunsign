-- Purpose: add durable upload grants, invitation consumption, notification retries and API response integrity for implemented runtime operations.
-- Impact: Adds tenant-scoped operational records and additive columns without rewriting existing signed evidence.
-- Backfill: Existing invitations remain unused; existing notification deliveries receive safe retry defaults; no jobs are enqueued automatically.
-- Rollback: Stop API and workers, preserve operational evidence, then remove additive objects using expand-and-contract in a maintenance window.
-- Verification: Validate forced RLS, single-use upload/invitation constraints, retry bounds and idempotent response hashes.

ALTER TABLE app.signer_invitations
  ADD COLUMN used_at timestamptz,
  ADD COLUMN revoked_reason text,
  ADD CONSTRAINT signer_invitations_terminal_time_order CHECK (
    (used_at IS NULL OR used_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  ) NOT VALID;
ALTER TABLE app.signer_invitations VALIDATE CONSTRAINT signer_invitations_terminal_time_order;

CREATE TABLE app.upload_grants (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  object_key text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','uploaded','consumed','expired','revoked')),
  expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, object_key),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users(tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK (uploaded_at IS NULL OR uploaded_at >= created_at),
  CHECK (consumed_at IS NULL OR uploaded_at IS NOT NULL),
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL)
);
CREATE INDEX upload_grants_expiry_idx ON app.upload_grants (tenant_id, expires_at) WHERE status = 'issued';

ALTER TABLE app.notification_deliveries
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN maximum_attempts integer NOT NULL DEFAULT 10,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN bounced_at timestamptz,
  ADD COLUMN complained_at timestamptz,
  ADD CONSTRAINT notification_delivery_attempts_valid CHECK (
    attempt_count >= 0 AND maximum_attempts > 0 AND attempt_count <= maximum_attempts
  ) NOT VALID;
ALTER TABLE app.notification_deliveries VALIDATE CONSTRAINT notification_delivery_attempts_valid;
CREATE INDEX notification_deliveries_retry_idx ON app.notification_deliveries (tenant_id, next_attempt_at)
  WHERE next_attempt_at IS NOT NULL AND delivered_at IS NULL;

ALTER TABLE app.api_idempotency_keys
  ADD COLUMN response_body_sha256 text,
  ADD CONSTRAINT api_idempotency_response_hash_valid CHECK (
    response_body_sha256 IS NULL OR response_body_sha256 ~ '^[0-9a-f]{64}$'
  ) NOT VALID;
ALTER TABLE app.api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_response_hash_valid;

ALTER TABLE app.upload_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.upload_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.upload_grants
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.protect_consumed_invitation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'consumed invitation is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked invitation is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signer_invitations_terminal_immutable
BEFORE UPDATE ON app.signer_invitations
FOR EACH ROW EXECUTE FUNCTION app.protect_consumed_invitation();
