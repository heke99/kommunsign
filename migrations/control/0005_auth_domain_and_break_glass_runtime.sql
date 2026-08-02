-- Purpose: add tenant identity federation, SCIM, domain provisioning lifecycle and controlled break-glass runtime records.
-- Impact: Extends control-plane metadata only; no tenant documents, national identifiers or signature evidence are stored.
-- Backfill: Existing verified/active domains become active, other domains become requested; no identity provider is enabled automatically.
-- Rollback: Disable federation, SCIM, domain jobs and break-glass workflows before dropping these additive objects in a maintenance window.
-- Verification: Check domain lifecycle consistency, hashed SCIM tokens, expiring sessions and two-person break-glass approval constraints.

ALTER TABLE control.tenant_domains
  ADD COLUMN lifecycle_state text,
  ADD COLUMN dns_challenge_name text,
  ADD COLUMN dns_challenge_value_hash bytea,
  ADD COLUMN certificate_reference text,
  ADD COLUMN last_error_code text,
  ADD COLUMN next_retry_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE control.tenant_domains
SET lifecycle_state = CASE
  WHEN verification_status = 'verified' AND tls_status = 'active' THEN 'active'
  WHEN verification_status = 'verified' THEN 'certificate_pending'
  ELSE 'requested'
END
WHERE lifecycle_state IS NULL;

ALTER TABLE control.tenant_domains ALTER COLUMN lifecycle_state SET NOT NULL;
ALTER TABLE control.tenant_domains
  ADD CONSTRAINT tenant_domains_lifecycle_state_valid CHECK (lifecycle_state IN (
    'requested','dns_challenge_created','dns_verified','certificate_pending',
    'active','renewal_required','suspended','removed'
  )) NOT VALID;
ALTER TABLE control.tenant_domains VALIDATE CONSTRAINT tenant_domains_lifecycle_state_valid;

CREATE TABLE control.tenant_federation_configs (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  protocol text NOT NULL CHECK (protocol IN ('OIDC','SAML')),
  configuration_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  issuer text NOT NULL,
  client_id text,
  discovery_uri text,
  metadata_uri text,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  group_role_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_mfa_claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_secret_reference text,
  signing_certificate_reference text,
  enabled boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, protocol, configuration_key, version),
  CHECK (jsonb_typeof(group_role_mapping) = 'object'),
  CHECK (jsonb_typeof(required_mfa_claims) = 'object'),
  CHECK (credential_secret_reference IS NULL OR credential_secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://'),
  CHECK (signing_certificate_reference IS NULL OR signing_certificate_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://')
);
CREATE UNIQUE INDEX tenant_federation_one_active
  ON control.tenant_federation_configs (tenant_id, protocol, configuration_key) WHERE active;
CREATE TRIGGER tenant_federation_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_federation_configs
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();

CREATE TABLE control.scim_tokens (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  description text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  CHECK (cardinality(scopes) > 0),
  CHECK (expires_at > created_at)
);

CREATE TABLE control.platform_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL,
  authentication_method text NOT NULL CHECK (authentication_method IN ('OIDC','WEBAUTHN','BREAK_GLASS')),
  refresh_token_family_hash bytea NOT NULL,
  mfa_satisfied boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_rotated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE control.break_glass_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  requested_by uuid NOT NULL,
  approved_by uuid,
  justification text NOT NULL CHECK (length(trim(justification)) BETWEEN 20 AND 2000),
  permission_scope text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','active','expired','revoked','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  active_from timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  customer_notification_status text NOT NULL DEFAULT 'pending' CHECK (customer_notification_status IN ('pending','sent','failed','not_required')),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (expires_at > requested_at),
  CHECK ((status IN ('approved','active','expired','revoked') AND approved_by IS NOT NULL) OR status IN ('pending','rejected'))
);

CREATE TABLE control.domain_provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  tenant_domain_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CREATE_CHALLENGE','VERIFY_DNS','ISSUE_CERTIFICATE','RENEW_CERTIFICATE','SUSPEND','REMOVE')),
  provider_key text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','leased','completed','dead_letter')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  maximum_attempts integer NOT NULL DEFAULT 10 CHECK (maximum_attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, operation, idempotency_key),
  FOREIGN KEY (tenant_id, tenant_domain_id) REFERENCES control.tenant_domains(tenant_id, id)
);
CREATE INDEX domain_provisioning_jobs_claim_idx ON control.domain_provisioning_jobs (available_at, created_at)
  WHERE status = 'pending';
