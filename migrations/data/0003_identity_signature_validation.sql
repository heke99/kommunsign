-- Purpose: provider evidence, cryptographic signatures, certificates and validation.
-- Impact: Adds identity transactions, cryptographic signature artifacts, certificate evidence and validation runs.
-- Backfill: No data backfill; evidence is created only by trusted services.
-- Rollback: Disable signing workers, export evidence references, then drop in reverse dependency order.
-- Verification: Confirm digest checks and tenant-scoped foreign keys exist.
CREATE TABLE app.identity_transactions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signer_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  provider app.identity_provider NOT NULL,
  provider_reference text NOT NULL,
  state_hash bytea NOT NULL,
  nonce_hash bytea NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code text,
  raw_evidence_object_key text,
  evidence_sha256 text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_reference),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id)
);
CREATE TABLE app.identity_provider_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_transaction_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_event_id),
  FOREIGN KEY (tenant_id, identity_transaction_id) REFERENCES app.identity_transactions(tenant_id, id)
);
CREATE TABLE app.signature_attempts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signer_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  identity_transaction_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('prepared','identity_verified','credential_issued','signed','validated','failed','cancelled')),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  provider app.identity_provider NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, signer_id, attempt_number),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, identity_transaction_id) REFERENCES app.identity_transactions(tenant_id, id)
);
CREATE TABLE app.signature_artifacts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_attempt_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('PAdES-B','PAdES-T','PAdES-LT','PAdES-LTA')),
  signed_document_object_key text NOT NULL,
  signed_document_sha256 text NOT NULL CHECK (signed_document_sha256 ~ '^[0-9a-f]{64}$'),
  signature_value_object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_attempt_id) REFERENCES app.signature_attempts(tenant_id, id)
);
CREATE TABLE app.signature_certificates (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_artifact_id uuid NOT NULL,
  subject_summary text NOT NULL,
  issuer_summary text NOT NULL,
  serial_number text NOT NULL,
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  certificate_object_key text NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_artifact_id) REFERENCES app.signature_artifacts(tenant_id, id)
);
CREATE TABLE app.ocsp_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_artifact_id uuid NOT NULL,
  object_key text NOT NULL,
  produced_at timestamptz,
  sha256 text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_artifact_id) REFERENCES app.signature_artifacts(tenant_id, id)
);
CREATE TABLE app.crl_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_artifact_id uuid NOT NULL,
  object_key text NOT NULL,
  this_update timestamptz,
  next_update timestamptz,
  sha256 text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_artifact_id) REFERENCES app.signature_artifacts(tenant_id, id)
);
CREATE TABLE app.timestamp_tokens (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_artifact_id uuid NOT NULL,
  tsa_name text NOT NULL,
  token_object_key text NOT NULL,
  gen_time timestamptz NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_artifact_id) REFERENCES app.signature_artifacts(tenant_id, id)
);
CREATE TABLE app.validation_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_artifact_id uuid NOT NULL,
  validator text NOT NULL,
  validator_version text NOT NULL,
  indication app.validation_indication NOT NULL,
  trust_list_snapshot_object_key text,
  machine_report_object_key text NOT NULL,
  human_report_object_key text NOT NULL,
  report_sha256 text NOT NULL,
  validated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_artifact_id) REFERENCES app.signature_artifacts(tenant_id, id)
);
