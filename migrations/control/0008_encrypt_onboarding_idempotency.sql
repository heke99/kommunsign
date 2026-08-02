-- Purpose: prevent onboarding PII from being persisted in plaintext idempotency responses.
-- Impact: adds an encrypted response column and expiry lookup index; existing rows remain readable only through the legacy path until expiry.
-- Backfill: no sensitive legacy response is copied; existing 24-hour idempotency rows expire naturally.
-- Rollback: stop onboarding writes and remove the additive column/index in a maintenance window after all rows expire.
-- Verification: verify production code writes response_body_ciphertext and leaves response_body null.

BEGIN;

ALTER TABLE control.onboarding_idempotency_keys
  ADD COLUMN IF NOT EXISTS response_body_ciphertext bytea;

COMMENT ON COLUMN control.onboarding_idempotency_keys.response_body_ciphertext IS
  'Envelope-encrypted serialized idempotency response. Production code must not persist applicant PII in response_body.';

CREATE INDEX IF NOT EXISTS onboarding_idempotency_expiry_idx
  ON control.onboarding_idempotency_keys(expires_at);

COMMIT;
