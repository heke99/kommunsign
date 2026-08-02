-- Purpose: support production API repositories with durable idempotency and opaque recipient references.
-- Impact: additive tenant-scoped operational records only.
-- Backfill: existing signers receive generated legacy opaque references; no national identifier is exposed.
-- Rollback: stop production API writers, preserve idempotency evidence, then remove additive objects in a maintenance window.
-- Verification: confirm forced RLS and unique operation keys per tenant.

CREATE TABLE app.operation_idempotency (
  tenant_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  response_body jsonb,
  response_body_sha256 text CHECK (response_body_sha256 IS NULL OR response_body_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (tenant_id, operation, idempotency_key),
  CHECK (expires_at > created_at)
);
ALTER TABLE app.operation_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operation_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.operation_idempotency
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.signers ADD COLUMN recipient_reference text;
UPDATE app.signers SET recipient_reference = 'legacy-' || id::text WHERE recipient_reference IS NULL;
ALTER TABLE app.signers ALTER COLUMN recipient_reference SET NOT NULL;
ALTER TABLE app.signers ADD CONSTRAINT signers_recipient_reference_safe
  CHECK (length(recipient_reference) BETWEEN 8 AND 512 AND recipient_reference !~ '[\u0000-\u001f\u007f]') NOT VALID;
ALTER TABLE app.signers VALIDATE CONSTRAINT signers_recipient_reference_safe;
CREATE INDEX signers_recipient_reference_idx ON app.signers(tenant_id, signature_case_id, recipient_reference);
