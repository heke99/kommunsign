-- Purpose: add superadmin-managed organization account invitations and CSRF-bound API sessions.
-- Impact: extends the control plane without changing existing authentication or tenant data rows.
-- Backfill: existing sessions receive no CSRF hash and must authenticate again before mutating requests.
-- Rollback: revoke active sessions and invitations before removing the additive objects in reverse order.
-- Verification: confirm invitations contain no plaintext email and every active browser session has a CSRF hash.

BEGIN;

ALTER TABLE control.host_bound_sessions
  ADD COLUMN csrf_token_hash bytea,
  ADD COLUMN session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0);

UPDATE control.host_bound_sessions
   SET revoked_at = coalesce(revoked_at, now())
 WHERE csrf_token_hash IS NULL;

ALTER TABLE control.host_bound_sessions
  ADD CONSTRAINT host_bound_sessions_browser_csrf_required
  CHECK (revoked_at IS NOT NULL OR authentication_method <> 'session' OR csrf_token_hash IS NOT NULL);


CREATE TABLE control.auth_rate_limit_buckets (
  action text NOT NULL CHECK (action IN ('login','password_recovery','password_complete')),
  bucket_hash text NOT NULL CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, bucket_hash)
);

CREATE INDEX auth_rate_limit_buckets_cleanup_idx
  ON control.auth_rate_limit_buckets (updated_at);

COMMENT ON TABLE control.auth_rate_limit_buckets IS
  'Database-backed authentication throttling keyed only by irreversible SHA-256 material; raw IP and email are never stored.';
REVOKE ALL ON control.auth_rate_limit_buckets FROM PUBLIC;

CREATE TABLE control.organization_account_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  provider text NOT NULL CHECK (provider IN ('supabase_auth')),
  provider_user_id text NOT NULL,
  display_name text NOT NULL,
  email_ciphertext bytea NOT NULL,
  email_blind_index bytea NOT NULL,
  role_key text NOT NULL CHECK (role_key IN (
    'tenant_admin','tenant_security_admin','tenant_integration_admin','tenant_archive_admin',
    'department_admin','document_creator','document_sender','approver','auditor','readonly'
  )),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled','revoked','failed')),
  invited_by uuid NOT NULL REFERENCES control.platform_subjects(id),
  idempotency_key text NOT NULL,
  invite_sent_at timestamptz,
  accepted_at timestamptz,
  disabled_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_user_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX organization_account_invitations_active_email_idx
  ON control.organization_account_invitations (tenant_id, email_blind_index)
  WHERE status IN ('invited','active');

CREATE INDEX organization_account_invitations_tenant_status_idx
  ON control.organization_account_invitations (tenant_id, status, created_at DESC);

COMMENT ON TABLE control.organization_account_invitations IS
  'Server-created organization user invitations. Email is encrypted and blind-indexed; public self-registration is not supported.';
COMMENT ON COLUMN control.organization_account_invitations.provider_user_id IS
  'External identity provider subject identifier returned by the server-side administrative invite operation.';
COMMENT ON COLUMN control.organization_account_invitations.email_ciphertext IS
  'Encrypted email address. Plaintext email must never be written to control-plane audit or logs.';
COMMENT ON COLUMN control.host_bound_sessions.csrf_token_hash IS
  'SHA-256 hash of the browser-held CSRF token. Required for cookie-authenticated mutating API requests.';

REVOKE ALL ON control.organization_account_invitations FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM control.host_bound_sessions
     WHERE revoked_at IS NULL AND authentication_method='session' AND csrf_token_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'active browser session without CSRF binding';
  END IF;
END $$;

COMMIT;
