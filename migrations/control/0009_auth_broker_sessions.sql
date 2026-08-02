-- Purpose: persist host-bound, single-use authorization codes and host-only session references for the central auth broker.
-- Impact: adds hashed/ciphertext-only broker and session records in the control plane.
-- Backfill: none; existing sessions are not migrated and must authenticate again.
-- Rollback: disable the auth broker and revoke active sessions before removing the additive tables in a maintenance window.
-- Verification: exchange one code once, reject replay and reject the same session token from a different hostname.

BEGIN;

CREATE TABLE control.auth_authorization_codes (
  code_hash bytea PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  destination_hostname text NOT NULL,
  subject_id text NOT NULL,
  auth_method text NOT NULL CHECK (auth_method IN ('oidc','saml','magic_link','session')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (destination_hostname = lower(rtrim(destination_hostname,'.'))),
  CHECK (NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX auth_authorization_codes_expiry_idx ON control.auth_authorization_codes(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE control.auth_broker_transactions (
  state_hash bytea PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  destination_hostname text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('OIDC','SAML')),
  nonce_hash bytea,
  pkce_verifier_ciphertext bytea,
  return_path text NOT NULL DEFAULT '/',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%')
);
CREATE INDEX auth_broker_transactions_expiry_idx ON control.auth_broker_transactions(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE control.host_bound_sessions (
  token_hash bytea PRIMARY KEY,
  tenant_id uuid REFERENCES control.platform_tenants(id),
  boundary text NOT NULL CHECK (boundary IN ('tenant','platform','applicant','signer')),
  hostname text NOT NULL,
  subject_id text NOT NULL,
  authentication_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (hostname = lower(rtrim(hostname,'.'))),
  CHECK ((boundary='tenant' AND tenant_id IS NOT NULL) OR boundary<>'tenant')
);
CREATE INDEX host_bound_sessions_active_idx ON control.host_bound_sessions(hostname,boundary,expires_at) WHERE revoked_at IS NULL;

REVOKE ALL ON control.auth_authorization_codes, control.auth_broker_transactions, control.host_bound_sessions FROM PUBLIC;
COMMIT;
