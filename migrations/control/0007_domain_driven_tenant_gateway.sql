-- Purpose: establish the canonical domain-driven tenant routing model without rewriting prior migrations.
-- Impact: additive control-plane metadata, constraints, audit history and active domain health evidence.
-- Backfill: creates a production environment for existing tenants and maps legacy domain lifecycle values.
-- Rollback: disable gateway/domain workers, preserve audit tables, then remove objects in reverse dependency order.
-- Verification: run migrations/control/verify_domain_gateway.sql and the domain database integration suite.

CREATE TYPE control.tenant_environment_kind AS ENUM ('test','production');
CREATE TYPE control.domain_type AS ENUM ('platform_default','customer_custom','customer_test','internal');
CREATE TYPE control.domain_status AS ENUM (
  'requested','dns_challenge_created','dns_verification_pending','dns_verified','routing_pending',
  'certificate_pending','active','renewal_required','suspended','removed','failed'
);
CREATE TYPE control.data_plane_status AS ENUM ('provisioning','ready','degraded','suspended','retired');

CREATE TABLE control.data_planes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  deployment_mode control.deployment_mode NOT NULL,
  status control.data_plane_status NOT NULL DEFAULT 'provisioning',
  region text NOT NULL,
  connection_secret_reference text NOT NULL,
  storage_secret_reference text,
  release_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (connection_secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret|supabase-vault)://'),
  CHECK (storage_secret_reference IS NULL OR storage_secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret|supabase-vault)://')
);

CREATE TABLE control.tenant_environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  environment control.tenant_environment_kind NOT NULL,
  data_plane_id uuid NOT NULL REFERENCES control.data_planes(id),
  status text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','onboarding','ready','active','suspended','decommissioned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, environment),
  UNIQUE (tenant_id, id)
);

CREATE TABLE control.reserved_tenant_slugs (
  slug text PRIMARY KEY,
  reason text NOT NULL,
  permanent boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);

INSERT INTO control.reserved_tenant_slugs(slug, reason) VALUES
  ('www','platform hostname'),('admin','platform hostname'),('apply','platform hostname'),
  ('app','platform hostname'),('api','platform hostname'),('auth','platform hostname'),
  ('sign','platform hostname'),('verify','platform hostname'),('docs','platform hostname'),
  ('status','platform hostname'),('hooks','platform hostname'),('mail','reserved service'),
  ('support','reserved service'),('billing','reserved service'),('test','reserved environment'),
  ('staging','reserved environment'),('dev','reserved environment'),('internal','reserved service'),
  ('system','reserved service'),('root','reserved service'),('security','reserved service'),
  ('platform','reserved service'),('public','reserved service'),('static','reserved service'),
  ('assets','reserved service'),('cdn','reserved service')
ON CONFLICT (slug) DO NOTHING;

CREATE OR REPLACE FUNCTION control.reject_reserved_tenant_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM control.reserved_tenant_slugs r WHERE r.slug = NEW.slug) THEN
    RAISE EXCEPTION 'reserved tenant slug: %', NEW.slug USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_tenants_reserved_slug_guard
BEFORE INSERT OR UPDATE OF slug ON control.platform_tenants
FOR EACH ROW EXECUTE FUNCTION control.reject_reserved_tenant_slug();

ALTER TABLE control.tenant_domains
  ADD COLUMN environment_id uuid,
  ADD COLUMN normalized_hostname text,
  ADD COLUMN domain_type control.domain_type,
  ADD COLUMN status control.domain_status,
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN is_platform_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN verification_record_name text,
  ADD COLUMN verification_record_type text,
  ADD COLUMN verification_record_value text,
  ADD COLUMN verification_expires_at timestamptz,
  ADD COLUMN provider text,
  ADD COLUMN provider_domain_id text,
  ADD COLUMN dns_verified_at timestamptz,
  ADD COLUMN certificate_issued_at timestamptz,
  ADD COLUMN certificate_expires_at timestamptz,
  ADD COLUMN last_health_check_at timestamptz,
  ADD COLUMN last_health_status text,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN created_by uuid,
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

-- Existing installations get one production environment. A real data-plane registry row must be assigned before activation.
INSERT INTO control.data_planes(name, deployment_mode, status, region, connection_secret_reference, release_version)
VALUES ('legacy-shared-data-plane', 'shared_saas', 'degraded', 'unassigned', 'supabase-vault://legacy-shared-data-plane', 'legacy')
ON CONFLICT (name) DO NOTHING;

INSERT INTO control.tenant_environments(tenant_id, environment, data_plane_id, status)
SELECT t.id, 'production', d.id,
       CASE WHEN t.status = 'active' THEN 'active' ELSE 'onboarding' END
FROM control.platform_tenants t
CROSS JOIN control.data_planes d
WHERE d.name = 'legacy-shared-data-plane'
ON CONFLICT (tenant_id, environment) DO NOTHING;

UPDATE control.tenant_domains td
SET environment_id = te.id,
    normalized_hostname = lower(rtrim(td.hostname, '.')),
    domain_type = CASE WHEN td.hostname LIKE '%.kommunsign.se' THEN 'platform_default'::control.domain_type ELSE 'customer_custom'::control.domain_type END,
    status = CASE td.lifecycle_state
      WHEN 'requested' THEN 'requested'::control.domain_status
      WHEN 'dns_challenge_created' THEN 'dns_challenge_created'::control.domain_status
      WHEN 'dns_verified' THEN 'dns_verified'::control.domain_status
      WHEN 'certificate_pending' THEN 'certificate_pending'::control.domain_status
      WHEN 'active' THEN 'active'::control.domain_status
      WHEN 'renewal_required' THEN 'renewal_required'::control.domain_status
      WHEN 'suspended' THEN 'suspended'::control.domain_status
      WHEN 'removed' THEN 'removed'::control.domain_status
      ELSE 'failed'::control.domain_status END,
    is_platform_managed = td.hostname LIKE '%.kommunsign.se',
    dns_verified_at = COALESCE(td.verified_at, td.dns_verified_at, CASE WHEN td.lifecycle_state = 'active' THEN td.created_at END),
    certificate_issued_at = COALESCE(td.certificate_issued_at, CASE WHEN td.lifecycle_state = 'active' THEN td.created_at END),
    last_health_check_at = COALESCE(td.last_health_check_at, CASE WHEN td.lifecycle_state = 'active' THEN td.created_at END),
    last_health_status = COALESCE(td.last_health_status, CASE WHEN td.lifecycle_state = 'active' THEN 'healthy' END),
    activated_at = CASE WHEN td.lifecycle_state = 'active' THEN COALESCE(td.verified_at, td.created_at) ELSE td.activated_at END
FROM control.tenant_environments te
WHERE te.tenant_id = td.tenant_id AND te.environment = 'production';

ALTER TABLE control.tenant_domains
  ALTER COLUMN environment_id SET NOT NULL,
  ALTER COLUMN normalized_hostname SET NOT NULL,
  ALTER COLUMN domain_type SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT tenant_domains_environment_fk FOREIGN KEY (tenant_id, environment_id)
    REFERENCES control.tenant_environments(tenant_id, id),
  ADD CONSTRAINT tenant_domains_normalized_hostname_check CHECK (
    normalized_hostname = lower(rtrim(hostname, '.'))
    AND normalized_hostname ~ '^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'
  ),
  ADD CONSTRAINT tenant_domains_verification_record_type_check CHECK (
    verification_record_type IS NULL OR verification_record_type IN ('TXT','CNAME','A','AAAA')
  ),
  ADD CONSTRAINT tenant_domains_activation_evidence_check CHECK (
    status <> 'active' OR (
      dns_verified_at IS NOT NULL
      AND certificate_issued_at IS NOT NULL
      AND last_health_status = 'healthy'
      AND activated_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT tenant_domains_custom_domain_tenant_check CHECK (
    domain_type <> 'customer_custom' OR tenant_id IS NOT NULL
  );

DROP INDEX IF EXISTS control.tenant_domains_hostname_canonical_unique;
CREATE UNIQUE INDEX tenant_domains_normalized_hostname_unique ON control.tenant_domains(normalized_hostname);
CREATE UNIQUE INDEX tenant_domains_one_primary_per_environment
  ON control.tenant_domains(tenant_id, environment_id) WHERE is_primary AND status <> 'removed';
CREATE UNIQUE INDEX tenant_domains_one_default_per_environment
  ON control.tenant_domains(tenant_id, environment_id) WHERE domain_type = 'platform_default' AND status <> 'removed';
CREATE INDEX tenant_domains_active_resolution_idx ON control.tenant_domains(normalized_hostname, status)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION control.sync_domain_canonical_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.hostname := lower(rtrim(NEW.hostname, '.'));
  NEW.normalized_hostname := NEW.hostname;
  NEW.updated_at := now();
  NEW.version := CASE WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.version, 1) ELSE COALESCE(OLD.version, 0) + 1 END;
  NEW.lifecycle_state := CASE NEW.status
    WHEN 'requested' THEN 'requested'
    WHEN 'dns_challenge_created' THEN 'dns_challenge_created'
    WHEN 'dns_verification_pending' THEN 'dns_challenge_created'
    WHEN 'dns_verified' THEN 'dns_verified'
    WHEN 'routing_pending' THEN 'dns_verified'
    WHEN 'certificate_pending' THEN 'certificate_pending'
    WHEN 'active' THEN 'active'
    WHEN 'renewal_required' THEN 'renewal_required'
    WHEN 'suspended' THEN 'suspended'
    WHEN 'removed' THEN 'removed'
    WHEN 'failed' THEN 'suspended'
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_domains_canonical_sync
BEFORE INSERT OR UPDATE ON control.tenant_domains
FOR EACH ROW EXECUTE FUNCTION control.sync_domain_canonical_fields();

CREATE TABLE control.domain_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_domain_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  record_name text NOT NULL,
  record_type text NOT NULL CHECK (record_type = 'TXT'),
  record_value_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_domain_id, token_hash),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES control.tenant_environments(tenant_id, id),
  FOREIGN KEY (tenant_id, tenant_domain_id) REFERENCES control.tenant_domains(tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK (NOT (verified_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE TABLE control.domain_provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_domain_id uuid NOT NULL,
  provider text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('request','attach','verify_dns','issue_certificate','renew_certificate','health_check','remove')),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','retryable_failure','permanent_failure')),
  provider_reference text,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  safe_error_code text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (provider, operation, idempotency_key),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES control.tenant_environments(tenant_id, id),
  FOREIGN KEY (tenant_id, tenant_domain_id) REFERENCES control.tenant_domains(tenant_id, id)
);

CREATE TABLE control.domain_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_domain_id uuid NOT NULL,
  check_type text NOT NULL CHECK (check_type IN ('dns','tls','routing','tenant_resolution','auth_callback','same_origin_api','signer_flow','verification_portal','takeover_protection')),
  status text NOT NULL CHECK (status IN ('healthy','degraded','failed')),
  checked_at timestamptz NOT NULL DEFAULT now(),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  safe_error_code text,
  FOREIGN KEY (tenant_id, environment_id) REFERENCES control.tenant_environments(tenant_id, id),
  FOREIGN KEY (tenant_id, tenant_domain_id) REFERENCES control.tenant_domains(tenant_id, id)
);
CREATE INDEX domain_health_checks_latest_idx ON control.domain_health_checks(tenant_domain_id, check_type, checked_at DESC);

CREATE TABLE control.domain_certificate_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_domain_id uuid NOT NULL,
  provider text NOT NULL,
  certificate_reference text,
  status text NOT NULL CHECK (status IN ('pending','issued','renewal_required','failed','revoked')),
  not_before timestamptz,
  not_after timestamptz,
  fingerprint_sha256 text CHECK (fingerprint_sha256 IS NULL OR fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES control.tenant_environments(tenant_id, id),
  FOREIGN KEY (tenant_id, tenant_domain_id) REFERENCES control.tenant_domains(tenant_id, id),
  CHECK (not_after IS NULL OR not_before IS NULL OR not_after > not_before)
);

CREATE TABLE control.domain_routing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  environment_id uuid,
  tenant_domain_id uuid,
  normalized_hostname text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('resolution_succeeded','unknown_host_rejected','inactive_host_rejected','misdirected_request','cache_invalidated','primary_changed')),
  request_id uuid,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_routing_events_hostname_idx ON control.domain_routing_events(normalized_hostname, occurred_at DESC);

CREATE TABLE control.tenant_branding_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  active boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX tenant_branding_versions_one_active ON control.tenant_branding_versions(tenant_id) WHERE active;

CREATE TABLE control.tenant_primary_domain_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_domain_id uuid NOT NULL,
  previous_domain_id uuid,
  changed_by uuid NOT NULL,
  change_reason text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES control.tenant_environments(tenant_id, id),
  FOREIGN KEY (tenant_id, tenant_domain_id) REFERENCES control.tenant_domains(tenant_id, id)
);

CREATE OR REPLACE FUNCTION control.guard_primary_domain_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_primary AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'primary domain must be active' USING ERRCODE = '23514';
  END IF;
  IF OLD.is_primary AND NOT NEW.is_primary AND OLD.domain_type = 'platform_default'
     AND NOT EXISTS (
       SELECT 1 FROM control.tenant_domains replacement
       WHERE replacement.tenant_id = OLD.tenant_id
         AND replacement.environment_id = OLD.environment_id
         AND replacement.id <> OLD.id
         AND replacement.is_primary
         AND replacement.status = 'active'
     ) THEN
    RAISE EXCEPTION 'cannot remove primary default domain without an active replacement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_domains_primary_guard
BEFORE UPDATE OF is_primary, status ON control.tenant_domains
FOR EACH ROW EXECUTE FUNCTION control.guard_primary_domain_change();

REVOKE ALL ON control.data_planes, control.tenant_environments, control.reserved_tenant_slugs,
  control.domain_verification_challenges, control.domain_provider_operations, control.domain_health_checks,
  control.domain_certificate_snapshots, control.domain_routing_events, control.tenant_branding_versions,
  control.tenant_primary_domain_history FROM PUBLIC;

CREATE TABLE control.platform_subjects (
  id uuid PRIMARY KEY,
  external_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.platform_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_subject_id uuid NOT NULL REFERENCES control.platform_subjects(id),
  role_key text NOT NULL CHECK (role_key IN (
    'platform_super_admin','platform_security_admin','platform_operations','platform_support','platform_auditor',
    'onboarding_manager','onboarding_case_worker','commercial_reviewer','legal_reviewer','security_reviewer',
    'technical_reviewer','provisioning_operator','activation_approver'
  )),
  granted_by uuid NOT NULL REFERENCES control.platform_subjects(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (platform_subject_id, role_key)
);
REVOKE ALL ON control.platform_subjects, control.platform_role_assignments FROM PUBLIC;
