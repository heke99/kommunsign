-- Purpose: add fail-closed tenant configuration and durable evidence storage for Freja eID and external document-signing providers, plus indexes required by keyset pagination.
-- Impact: additive provider configuration/evidence tables, rollout switches, and read-path indexes; existing TIC BankID tenants remain unchanged and enabled behavior is opt-in per tenant.
-- Backfill: none. Existing tenants keep all new rollout switches disabled and no provider is usable until an explicit enabled configuration with secret references is provisioned.
-- Rollback: disable provider rollouts and workers, export provider evidence, then remove the new triggers/tables/columns and indexes in reverse order during a maintenance window.
-- Verification: run clean DATA migration replay, migrations/data/verify.sql, provider integration/security tests, and confirm existing TIC signing remains green.

ALTER TABLE app.tenant_signing_settings
  ADD COLUMN freja_direct_rollout_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN external_document_signing_rollout_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE app.signing_provider_configs (
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('FREJA_DIRECT','INLEED_DOCSIGN')),
  enabled boolean NOT NULL DEFAULT false,
  base_url text NOT NULL,
  client_certificate_ref text,
  client_private_key_ref text,
  api_credential_ref text,
  webhook_secret_ref text,
  connect_timeout_ms integer NOT NULL DEFAULT 3000 CHECK (connect_timeout_ms BETWEEN 250 AND 10000),
  request_timeout_ms integer NOT NULL DEFAULT 10000 CHECK (request_timeout_ms BETWEEN 1000 AND 30000),
  maximum_attempts integer NOT NULL DEFAULT 8 CHECK (maximum_attempts BETWEEN 1 AND 20),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app.users(tenant_id, id),
  CHECK (base_url ~ '^https://'),
  CHECK (provider <> 'FREJA_DIRECT' OR (client_certificate_ref IS NOT NULL AND client_private_key_ref IS NOT NULL)),
  CHECK (provider <> 'INLEED_DOCSIGN' OR api_credential_ref IS NOT NULL)
);
COMMENT ON TABLE app.signing_provider_configs IS 'Fail-closed tenant-scoped provider configuration. Stores vault references only; never provider credentials or private keys.';

CREATE TABLE app.freja_identity_artifacts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_transaction_id uuid NOT NULL,
  signing_intent_id uuid NOT NULL,
  response_object_key text NOT NULL,
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  jws_object_key text NOT NULL,
  jws_sha256 text NOT NULL CHECK (jws_sha256 ~ '^[0-9a-f]{64}$'),
  verification_report_object_key text NOT NULL,
  verification_report_sha256 text NOT NULL CHECK (verification_report_sha256 ~ '^[0-9a-f]{64}$'),
  verification_result text NOT NULL CHECK (verification_result IN ('PASS','FAIL')),
  verifier_engine text NOT NULL,
  verifier_policy_version text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, identity_transaction_id),
  FOREIGN KEY (tenant_id, identity_transaction_id) REFERENCES app.identity_transactions(tenant_id, id),
  FOREIGN KEY (tenant_id, signing_intent_id) REFERENCES app.signing_intents(tenant_id, id)
);
COMMENT ON TABLE app.freja_identity_artifacts IS 'Append-only Freja response/JWS verification evidence bound to one immutable signing intent.';

CREATE TABLE app.external_signature_transactions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'INLEED_DOCSIGN'),
  signature_case_id uuid NOT NULL,
  signer_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  provider_reference text,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  source_document_sha256 text NOT NULL CHECK (source_document_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','pending','completed_unverified','verified','failed','cancelled','expired')),
  final_document_object_key text,
  final_document_sha256 text CHECK (final_document_sha256 IS NULL OR final_document_sha256 ~ '^[0-9a-f]{64}$'),
  verification_report_object_key text,
  verification_report_sha256 text CHECK (verification_report_sha256 IS NULL OR verification_report_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at timestamptz,
  provider_completed_at timestamptz,
  verified_at timestamptz,
  next_reconcile_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_reference),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id),
  CHECK (status <> 'verified' OR (final_document_object_key IS NOT NULL AND final_document_sha256 IS NOT NULL AND verification_report_object_key IS NOT NULL AND verification_report_sha256 IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX external_signature_one_active_idx
  ON app.external_signature_transactions(tenant_id,provider,signer_id,document_version_id)
  WHERE status IN ('prepared','submitted','pending','completed_unverified');
CREATE INDEX external_signature_reconcile_idx
  ON app.external_signature_transactions(next_reconcile_at,tenant_id,id)
  WHERE status IN ('submitted','pending','completed_unverified');
COMMENT ON TABLE app.external_signature_transactions IS 'Durable provider-neutral reconciliation state. Provider completion is non-terminal until final PDF is fetched server-side, hashed and locally verified.';

CREATE INDEX signature_cases_keyset_idx
  ON app.signature_cases(tenant_id,created_at DESC,id DESC);
CREATE INDEX outbox_events_keyset_idx
  ON app.outbox_events(tenant_id,occurred_at DESC,id DESC);
CREATE INDEX notification_templates_keyset_idx
  ON app.notification_templates(tenant_id,template_key,locale,version DESC,id DESC);

CREATE OR REPLACE FUNCTION app.reject_external_provider_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'external provider evidence is append-only'; END $$;
CREATE TRIGGER freja_identity_artifacts_no_mutation
BEFORE UPDATE OR DELETE ON app.freja_identity_artifacts
FOR EACH ROW EXECUTE FUNCTION app.reject_external_provider_evidence_mutation();

CREATE OR REPLACE FUNCTION app.enforce_bankid_terminal_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='signed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.signing_intents si
      LEFT JOIN app.tic_identity_artifacts tia
        ON tia.tenant_id=si.tenant_id AND tia.signing_intent_id=si.id AND tia.verification_result='PASS'
      LEFT JOIN app.freja_identity_artifacts fia
        ON fia.tenant_id=si.tenant_id AND fia.signing_intent_id=si.id AND fia.verification_result='PASS'
      WHERE si.tenant_id=NEW.tenant_id AND si.signer_id=NEW.id
        AND si.status IN ('verified','packaged')
        AND (tia.id IS NOT NULL OR fia.id IS NOT NULL)
    ) THEN RAISE EXCEPTION 'signed signer requires verified identity evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['signing_provider_configs','freja_identity_artifacts','external_signature_transactions'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id())',table_name);
  END LOOP;
END $$;

REVOKE ALL ON app.signing_provider_configs,app.freja_identity_artifacts,app.external_signature_transactions FROM PUBLIC;
