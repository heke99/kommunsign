-- Purpose: tenant-owned organization, users, policies, cases, documents and signers.
-- Impact: Creates organization, authorization, policy, case, document and signer tables.
-- Backfill: No data backfill; initial schema.
-- Rollback: Export tenant data and drop tables in reverse dependency order in a maintenance window.
-- Verification: Confirm every tenant-owned relation has tenant_id and composite tenant foreign keys.
CREATE TABLE app.organizations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  organization_number text,
  municipality_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE app.departments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations(tenant_id, id)
);
CREATE TABLE app.users (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_subject text NOT NULL,
  display_name text NOT NULL,
  email_ciphertext bytea,
  email_blind_index bytea,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, external_subject)
);
CREATE TABLE app.memberships (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  department_id uuid,
  status text NOT NULL CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.departments(tenant_id, id)
);
CREATE TABLE app.roles (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  permissions jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, role_key)
);
CREATE TABLE app.role_assignments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  department_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES app.memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.roles(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.departments(tenant_id, id)
);
CREATE TABLE app.signature_policies (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  decision_mode app.decision_mode NOT NULL,
  policy jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users(tenant_id, id)
);
CREATE TABLE app.signature_cases (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid,
  created_by uuid NOT NULL,
  external_reference text,
  title text NOT NULL,
  decision_mode app.decision_mode NOT NULL,
  policy_id uuid NOT NULL,
  policy_version integer NOT NULL,
  policy_snapshot jsonb NOT NULL,
  information_classification app.information_classification NOT NULL DEFAULT 'INTERNAL',
  status app.case_status NOT NULL DEFAULT 'draft',
  status_version bigint NOT NULL DEFAULT 1,
  expires_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES app.departments(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id, policy_version) REFERENCES app.signature_policies(tenant_id, id, version)
);
CREATE TABLE app.signature_case_references (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  system text NOT NULL,
  reference_type text NOT NULL,
  reference_value text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, system, reference_type, reference_value),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id)
);
CREATE TABLE app.documents (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id)
);
CREATE TABLE app.document_versions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status app.document_status NOT NULL DEFAULT 'uploaded',
  source_object_key text NOT NULL,
  canonical_object_key text,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_id, version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES app.documents(tenant_id, id),
  CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
);
CREATE TABLE app.document_hashes (
  tenant_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  algorithm text NOT NULL CHECK (algorithm IN ('SHA-256')),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_version_id, algorithm),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id)
);
CREATE TABLE app.document_scan_results (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL,
  engine text NOT NULL,
  engine_version text NOT NULL,
  result text NOT NULL CHECK (result IN ('CLEAN','INFECTED','ERROR')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id)
);
CREATE TABLE app.document_fields (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL,
  signer_id uuid,
  page_number integer NOT NULL CHECK (page_number > 0),
  field_type text NOT NULL,
  normalized_geometry jsonb NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id)
);
CREATE TABLE app.signers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  display_name text,
  expected_identifier_ciphertext bytea,
  expected_identifier_blind_index bytea,
  expected_identifier_type text,
  email_ciphertext bytea,
  email_blind_index bytea,
  status app.signer_status NOT NULL DEFAULT 'pending',
  signing_order integer,
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id)
);
ALTER TABLE app.document_fields ADD CONSTRAINT document_fields_signer_fk
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id);
CREATE TABLE app.signer_invitations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signer_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  first_opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id)
);
