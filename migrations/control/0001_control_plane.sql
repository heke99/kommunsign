-- Purpose: control-plane metadata only. No documents, national identifiers or signature evidence.
-- Rollback: disable writes, export tenant deployment registry, then drop schema in a dedicated maintenance window.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS control;

CREATE TYPE control.tenant_status AS ENUM ('provisioning','active','paused','suspended','decommissioning','decommissioned');
CREATE TYPE control.deployment_mode AS ENUM ('shared_saas','dedicated_data_plane','customer_hosted');

CREATE TABLE control.platform_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  legal_name text NOT NULL,
  organization_number text,
  municipality_code text,
  status control.tenant_status NOT NULL DEFAULT 'provisioning',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);
CREATE TABLE control.tenant_deployments (
  tenant_id uuid PRIMARY KEY REFERENCES control.platform_tenants(id),
  mode control.deployment_mode NOT NULL,
  region text NOT NULL,
  data_plane_reference text NOT NULL,
  object_storage_reference text NOT NULL,
  queue_namespace text NOT NULL,
  kms_key_reference text NOT NULL,
  release_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.tenant_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  hostname text NOT NULL UNIQUE,
  verification_token_hash bytea NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('pending','verified','failed','revoked')),
  tls_status text NOT NULL CHECK (tls_status IN ('pending','active','renewal_required','failed','revoked')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE control.tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES control.platform_tenants(id),
  display_name text NOT NULL,
  logo_object_key text,
  favicon_object_key text,
  design_tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  support_contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(design_tokens) = 'object')
);
CREATE TABLE control.tenant_features (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  feature_key text NOT NULL,
  enabled boolean NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, feature_key)
);
CREATE TABLE control.tenant_limits (
  tenant_id uuid PRIMARY KEY REFERENCES control.platform_tenants(id),
  monthly_signature_cases integer NOT NULL DEFAULT 1000 CHECK (monthly_signature_cases > 0),
  maximum_users integer NOT NULL DEFAULT 100 CHECK (maximum_users > 0),
  maximum_concurrent_sessions integer NOT NULL DEFAULT 100 CHECK (maximum_concurrent_sessions > 0),
  maximum_document_bytes bigint NOT NULL DEFAULT 52428800 CHECK (maximum_document_bytes > 0)
);
CREATE TABLE control.tenant_subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES control.platform_tenants(id),
  plan_code text NOT NULL,
  included_volume bigint NOT NULL DEFAULT 0,
  overage_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_reference text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz
);
CREATE TABLE control.control_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES control.platform_tenants(id),
  actor_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_event_hash text NOT NULL,
  event_hash text NOT NULL UNIQUE
);
REVOKE ALL ON SCHEMA control FROM PUBLIC;
