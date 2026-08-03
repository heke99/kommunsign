-- Purpose: additive BankID production signing intents, identifier binding, TIC artifacts, email events and evidence package integrity.
-- Impact: adds tenant-scoped immutable evidence structures and strengthens terminal-state guards without changing historical migrations.
-- Backfill: normalizes null signing_order to group 1; legacy signers remain draft-compatible but cannot be invited without a complete identifier-binding decision.
-- Rollback: disable new signing starts, export evidence, then remove triggers/tables in reverse dependency order during a maintenance window.
-- Verification: run migrations/data/verify.sql and the BankID integration/evidence fixture tests.

ALTER TABLE app.signers
  ADD COLUMN identifier_binding_mode text,
  ADD COLUMN identifier_binding_exception_code text,
  ADD COLUMN identifier_binding_exception_reason_ciphertext bytea,
  ADD COLUMN identifier_binding_exception_approved_by uuid,
  ADD COLUMN identifier_binding_exception_at timestamptz,
  ADD COLUMN verified_identifier_ciphertext bytea,
  ADD COLUMN verified_identifier_blind_index bytea,
  ADD COLUMN hard_bounced_at timestamptz,
  ADD COLUMN complained_at timestamptz,
  ADD COLUMN status_version bigint NOT NULL DEFAULT 1;

UPDATE app.signers SET signing_order = 1 WHERE signing_order IS NULL;
ALTER TABLE app.signers ALTER COLUMN signing_order SET DEFAULT 1;
ALTER TABLE app.signers ALTER COLUMN signing_order SET NOT NULL;
ALTER TABLE app.signers ADD CONSTRAINT signers_signing_order_positive CHECK (signing_order > 0) NOT VALID;
ALTER TABLE app.signers VALIDATE CONSTRAINT signers_signing_order_positive;
ALTER TABLE app.signers ADD CONSTRAINT signers_identifier_binding_mode_valid CHECK (
  identifier_binding_mode IS NULL OR identifier_binding_mode IN ('STRICT_PREBOUND','BANKID_DISCOVERED')
) NOT VALID;
ALTER TABLE app.signers VALIDATE CONSTRAINT signers_identifier_binding_mode_valid;
ALTER TABLE app.signers ADD CONSTRAINT signers_identifier_exception_code_valid CHECK (
  identifier_binding_exception_code IS NULL OR identifier_binding_exception_code IN (
    'UNKNOWN_AT_INVITATION','DATA_MINIMIZATION','PROTECTED_PERSONAL_DATA_WORKFLOW','RECIPIENT_SELECTED_BY_SECURE_CHANNEL','OTHER'
  )
) NOT VALID;
ALTER TABLE app.signers VALIDATE CONSTRAINT signers_identifier_exception_code_valid;
ALTER TABLE app.signers ADD CONSTRAINT signers_identifier_binding_consistent CHECK (
  identifier_binding_mode IS NULL OR
  (identifier_binding_mode = 'STRICT_PREBOUND'
    AND expected_identifier_ciphertext IS NOT NULL
    AND expected_identifier_blind_index IS NOT NULL
    AND expected_identifier_type = 'SSN'
    AND identifier_binding_exception_code IS NULL
    AND identifier_binding_exception_reason_ciphertext IS NULL
    AND identifier_binding_exception_approved_by IS NULL
    AND identifier_binding_exception_at IS NULL)
  OR
  (identifier_binding_mode = 'BANKID_DISCOVERED'
    AND expected_identifier_ciphertext IS NULL
    AND expected_identifier_blind_index IS NULL
    AND identifier_binding_exception_code IS NOT NULL
    AND identifier_binding_exception_approved_by IS NOT NULL
    AND identifier_binding_exception_at IS NOT NULL
    AND (identifier_binding_exception_code <> 'OTHER' OR identifier_binding_exception_reason_ciphertext IS NOT NULL))
) NOT VALID;
ALTER TABLE app.signers VALIDATE CONSTRAINT signers_identifier_binding_consistent;
ALTER TABLE app.signers ADD CONSTRAINT signers_identifier_exception_approver_fk
  FOREIGN KEY (tenant_id, identifier_binding_exception_approved_by) REFERENCES app.users(tenant_id, id);

COMMENT ON COLUMN app.signers.expected_identifier_ciphertext IS 'Tenant-encrypted normalized YYYYMMDDNNNN expected BankID subject; never log or expose directly.';
COMMENT ON COLUMN app.signers.expected_identifier_blind_index IS 'Keyed blind index for exact expected personal-number matching.';
COMMENT ON COLUMN app.signers.identifier_binding_exception_reason_ciphertext IS 'Tenant-encrypted justification; excluded from TIC payload and ordinary audit payloads.';
COMMENT ON COLUMN app.signers.verified_identifier_ciphertext IS 'Tenant-encrypted identity independently verified from TIC evidence.';

CREATE TABLE app.tenant_signing_settings (
  tenant_id uuid NOT NULL PRIMARY KEY,
  allow_identifier_binding_exceptions boolean NOT NULL DEFAULT false,
  maximum_document_bytes bigint NOT NULL DEFAULT 52428800 CHECK (maximum_document_bytes BETWEEN 1 AND 104857600),
  maximum_document_pages integer NOT NULL DEFAULT 500 CHECK (maximum_document_pages BETWEEN 1 AND 500),
  maximum_documents_per_case integer NOT NULL DEFAULT 20 CHECK (maximum_documents_per_case BETWEEN 1 AND 20),
  tic_bankid_rollout_enabled boolean NOT NULL DEFAULT false,
  email_data_residency_approved boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app.users(tenant_id, id)
);
COMMENT ON TABLE app.tenant_signing_settings IS 'Fail-closed tenant policy and rollout switches. Exceptions, TIC production and Resend compliance require explicit approval.';

CREATE TABLE app.signing_intents (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  signer_id uuid NOT NULL,
  sequence_group integer NOT NULL CHECK (sequence_group > 0),
  visible_text text NOT NULL,
  visible_text_sha256 text NOT NULL CHECK (visible_text_sha256 ~ '^[0-9a-f]{64}$'),
  non_visible_payload text NOT NULL,
  non_visible_payload_sha256 text NOT NULL CHECK (non_visible_payload_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_schema_version text NOT NULL CHECK (evidence_schema_version = 'kommunsign.bankid-evidence.v2'),
  identifier_binding_mode text NOT NULL CHECK (identifier_binding_mode IN ('STRICT_PREBOUND','BANKID_DISCOVERED')),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','provider_started','evidence_collected','verified','packaged','cancelled','expired','failed')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  provider_started_at timestamptz,
  evidence_collected_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX signing_intents_one_active_per_signer_case
  ON app.signing_intents(tenant_id, signature_case_id, signer_id)
  WHERE status IN ('prepared','provider_started','evidence_collected');
CREATE INDEX signing_intents_status_expiry_idx ON app.signing_intents(tenant_id, status, expires_at);
COMMENT ON TABLE app.signing_intents IS 'Immutable BankID signing intent binding a signer to exact canonical PDF/A bytes and canonical evidence payload.';
COMMENT ON COLUMN app.signing_intents.non_visible_payload IS 'Exact canonical UTF-8 JSON sent to TIC as userNonVisibleData; immutable after insertion.';

CREATE TABLE app.signing_intent_documents (
  tenant_id uuid NOT NULL,
  signing_intent_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  display_name_snapshot text NOT NULL,
  mime_type_snapshot text NOT NULL CHECK (mime_type_snapshot = 'application/pdf'),
  profile_snapshot text NOT NULL CHECK (profile_snapshot = 'PDF/A-2b'),
  byte_size_snapshot bigint NOT NULL CHECK (byte_size_snapshot > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, signing_intent_id, document_version_id),
  UNIQUE (tenant_id, signing_intent_id, ordinal),
  FOREIGN KEY (tenant_id, signing_intent_id) REFERENCES app.signing_intents(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id)
);
COMMENT ON TABLE app.signing_intent_documents IS 'Deterministically ordered immutable snapshot of canonical PDF/A documents covered by one BankID approval.';

ALTER TABLE app.identity_transactions
  ADD COLUMN signing_intent_id uuid,
  ADD COLUMN state_ciphertext bytea,
  ADD COLUMN provider_session_ciphertext bytea,
  ADD COLUMN last_polled_at timestamptz,
  ADD COLUMN extended_at timestamptz,
  ADD COLUMN collected_at timestamptz,
  ADD COLUMN verified_at timestamptz;
ALTER TABLE app.identity_transactions ADD CONSTRAINT identity_transactions_signing_intent_fk
  FOREIGN KEY (tenant_id, signing_intent_id) REFERENCES app.signing_intents(tenant_id, id);
CREATE UNIQUE INDEX identity_transactions_active_intent_idx
  ON app.identity_transactions(tenant_id, signing_intent_id)
  WHERE signing_intent_id IS NOT NULL AND status IN ('created','pending','complete_collected');
CREATE INDEX identity_transactions_provider_lookup_idx
  ON app.identity_transactions(tenant_id, provider, provider_reference, status);

CREATE TABLE app.tic_identity_artifacts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_transaction_id uuid NOT NULL,
  signing_intent_id uuid NOT NULL,
  collect_response_object_key text NOT NULL,
  collect_response_sha256 text NOT NULL CHECK (collect_response_sha256 ~ '^[0-9a-f]{64}$'),
  signature_xml_object_key text NOT NULL,
  signature_xml_sha256 text NOT NULL CHECK (signature_xml_sha256 ~ '^[0-9a-f]{64}$'),
  ocsp_response_object_key text NOT NULL,
  ocsp_response_sha256 text NOT NULL CHECK (ocsp_response_sha256 ~ '^[0-9a-f]{64}$'),
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
COMMENT ON TABLE app.tic_identity_artifacts IS 'Append-only standalone TIC XML-DSig, OCSP and verification evidence. This is deliberately separate from PAdES-only signature_artifacts.';

CREATE TABLE app.document_processor_reports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('MALWARE_SCAN','PDF_POLICY','QPDF_CHECK','PDFA_CONVERSION','PDFA_VALIDATION')),
  engine text NOT NULL,
  engine_version text NOT NULL,
  result text NOT NULL CHECK (result IN ('PASS','FAIL','ERROR')),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_version_id, report_type),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id)
);

ALTER TABLE app.document_versions
  ADD COLUMN source_page_count integer,
  ADD COLUMN canonical_page_count integer,
  ADD COLUMN pdf_profile text,
  ADD COLUMN canonicalized_at timestamptz;
ALTER TABLE app.document_versions ADD CONSTRAINT document_versions_page_counts_valid CHECK (
  (source_page_count IS NULL OR source_page_count > 0) AND
  (canonical_page_count IS NULL OR canonical_page_count > 0) AND
  (source_page_count IS NULL OR canonical_page_count IS NULL OR source_page_count = canonical_page_count)
) NOT VALID;
ALTER TABLE app.document_versions VALIDATE CONSTRAINT document_versions_page_counts_valid;
ALTER TABLE app.document_versions ADD CONSTRAINT document_versions_pdf_profile_valid CHECK (pdf_profile IS NULL OR pdf_profile = 'PDF/A-2b') NOT VALID;
ALTER TABLE app.document_versions VALIDATE CONSTRAINT document_versions_pdf_profile_valid;

CREATE TABLE app.provider_webhook_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('tic','resend')),
  provider_event_id text NOT NULL,
  provider_session_id text,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failure_code text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_event_id)
);
CREATE UNIQUE INDEX provider_webhook_session_event_dedupe
  ON app.provider_webhook_events(tenant_id, provider, provider_session_id, event_type, payload_sha256)
  WHERE provider_session_id IS NOT NULL;

ALTER TABLE app.notification_deliveries
  ADD COLUMN provider text,
  ADD COLUMN provider_message_id text,
  ADD COLUMN idempotency_key text,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN delayed_at timestamptz,
  ADD COLUMN failed_at timestamptz;
CREATE UNIQUE INDEX notification_delivery_provider_message_idx
  ON app.notification_deliveries(tenant_id, provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX notification_delivery_idempotency_idx
  ON app.notification_deliveries(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE app.email_messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signer_id uuid,
  signature_case_id uuid,
  template_key text NOT NULL,
  template_version integer NOT NULL DEFAULT 1 CHECK (template_version > 0),
  locale text NOT NULL DEFAULT 'sv-SE',
  recipient_ciphertext bytea NOT NULL,
  message_payload_ciphertext bytea NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','accepted','delivered','delayed','bounced','complained','failed','cancelled')),
  provider text,
  provider_message_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  maximum_attempts integer NOT NULL DEFAULT 10 CHECK (maximum_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id)
);
CREATE UNIQUE INDEX email_messages_provider_message_idx ON app.email_messages(tenant_id,provider,provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;
CREATE INDEX email_messages_retry_idx ON app.email_messages(tenant_id,next_attempt_at) WHERE status IN ('queued','delayed');
COMMENT ON TABLE app.email_messages IS 'Provider-neutral encrypted email outbox. Domain code does not depend on Resend-specific types.';

CREATE TABLE app.email_provider_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email_message_id uuid NOT NULL,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_message_id text NOT NULL,
  normalized_status text NOT NULL CHECK (normalized_status IN ('accepted','delivered','delayed','bounced','complained','failed')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_event_id),
  FOREIGN KEY (tenant_id, email_message_id) REFERENCES app.email_messages(tenant_id, id)
);

ALTER TABLE app.evidence_packages
  ADD COLUMN signer_id uuid,
  ADD COLUMN verification_id text,
  ADD COLUMN package_sha256 text,
  ADD COLUMN ready_at timestamptz;
ALTER TABLE app.evidence_packages ADD CONSTRAINT evidence_packages_signer_fk
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id);
ALTER TABLE app.evidence_packages ADD CONSTRAINT evidence_packages_package_sha_valid CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE app.evidence_packages VALIDATE CONSTRAINT evidence_packages_package_sha_valid;
CREATE UNIQUE INDEX evidence_packages_public_verification_idx ON app.evidence_packages(verification_id) WHERE verification_id IS NOT NULL AND status='ready';
CREATE UNIQUE INDEX evidence_packages_one_case_package_idx ON app.evidence_packages(tenant_id, signature_case_id) WHERE signer_id IS NULL;
CREATE UNIQUE INDEX evidence_packages_one_signer_package_idx ON app.evidence_packages(tenant_id, signature_case_id, signer_id) WHERE signer_id IS NOT NULL;

CREATE TABLE app.evidence_package_files (
  tenant_id uuid NOT NULL,
  evidence_package_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  path text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, evidence_package_id, ordinal),
  UNIQUE (tenant_id, evidence_package_id, path),
  FOREIGN KEY (tenant_id, evidence_package_id) REFERENCES app.evidence_packages(tenant_id, id),
  CHECK (path !~ '(^/|(^|/)\.\.(/|$)|\\)')
);
COMMENT ON TABLE app.evidence_package_files IS 'Append-only deterministic file manifest used to build and independently verify evidence ZIP archives.';

CREATE OR REPLACE FUNCTION app.reject_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cryptographic evidence is append-only'; END $$;
CREATE TRIGGER signing_intents_no_update_after_start
BEFORE UPDATE OR DELETE ON app.signing_intents
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();
CREATE TRIGGER signing_intent_documents_no_mutation
BEFORE UPDATE OR DELETE ON app.signing_intent_documents
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();
CREATE TRIGGER tic_identity_artifacts_no_mutation
BEFORE UPDATE OR DELETE ON app.tic_identity_artifacts
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();
CREATE TRIGGER evidence_package_files_no_mutation
BEFORE UPDATE OR DELETE ON app.evidence_package_files
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

-- Signing intents may only move through server-controlled functions. The immutable payload fields can never change.
CREATE OR REPLACE FUNCTION app.protect_signing_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.signature_case_id <> OLD.signature_case_id OR
     NEW.signer_id <> OLD.signer_id OR NEW.sequence_group <> OLD.sequence_group OR NEW.visible_text <> OLD.visible_text OR
     NEW.visible_text_sha256 <> OLD.visible_text_sha256 OR NEW.non_visible_payload <> OLD.non_visible_payload OR
     NEW.non_visible_payload_sha256 <> OLD.non_visible_payload_sha256 OR NEW.evidence_schema_version <> OLD.evidence_schema_version OR
     NEW.identifier_binding_mode <> OLD.identifier_binding_mode OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'signing intent payload is immutable';
  END IF;
  allowed := (OLD.status='prepared' AND NEW.status IN ('provider_started','cancelled','expired','failed')) OR
             (OLD.status='provider_started' AND NEW.status IN ('evidence_collected','cancelled','expired','failed')) OR
             (OLD.status='evidence_collected' AND NEW.status IN ('verified','failed')) OR
             (OLD.status='verified' AND NEW.status='packaged') OR OLD.status=NEW.status;
  IF NOT allowed THEN RAISE EXCEPTION 'invalid signing intent state transition'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER signing_intents_no_update_after_start ON app.signing_intents;
CREATE TRIGGER signing_intents_protected
BEFORE UPDATE ON app.signing_intents FOR EACH ROW EXECUTE FUNCTION app.protect_signing_intent();
CREATE TRIGGER signing_intents_no_delete BEFORE DELETE ON app.signing_intents FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION app.enforce_bankid_terminal_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='signed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.signing_intents si
      JOIN app.tic_identity_artifacts tia ON tia.tenant_id=si.tenant_id AND tia.signing_intent_id=si.id
      WHERE si.tenant_id=NEW.tenant_id AND si.signer_id=NEW.id AND si.status IN ('verified','packaged') AND tia.verification_result='PASS'
    ) THEN RAISE EXCEPTION 'signed signer requires verified TIC evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signer_bankid_terminal_evidence BEFORE UPDATE OF status ON app.signers
FOR EACH ROW EXECUTE FUNCTION app.enforce_bankid_terminal_evidence();

CREATE OR REPLACE FUNCTION app.enforce_case_package_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF EXISTS (SELECT 1 FROM app.signers s WHERE s.tenant_id=NEW.tenant_id AND s.signature_case_id=NEW.id AND s.required AND s.status<>'signed') THEN
      RAISE EXCEPTION 'completed case requires every required signer signed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.evidence_packages ep WHERE ep.tenant_id=NEW.tenant_id AND ep.signature_case_id=NEW.id AND ep.signer_id IS NULL AND ep.status='ready' AND ep.package_sha256 IS NOT NULL) THEN
      RAISE EXCEPTION 'completed case requires ready evidence package';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_case_package_completion BEFORE UPDATE OF status ON app.signature_cases
FOR EACH ROW EXECUTE FUNCTION app.enforce_case_package_completion();

CREATE OR REPLACE FUNCTION app.resolve_public_invitation(p_token_hash bytea)
RETURNS TABLE(tenant_id uuid, invitation_id uuid, signer_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=app,pg_temp AS $$
  SELECT i.tenant_id,i.id,i.signer_id
  FROM app.signer_invitations i
  WHERE i.token_hash=p_token_hash AND i.revoked_at IS NULL AND i.expires_at>now() AND i.used_at IS NULL
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_public_invitation(bytea) FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_signing_settings','signing_intents','signing_intent_documents','tic_identity_artifacts','document_processor_reports',
    'provider_webhook_events','email_messages','email_provider_events','evidence_package_files'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id())',table_name);
  END LOOP;
END $$;

REVOKE ALL ON app.tenant_signing_settings, app.signing_intents, app.signing_intent_documents, app.tic_identity_artifacts,
  app.document_processor_reports, app.provider_webhook_events, app.email_messages, app.email_provider_events, app.evidence_package_files FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.resolve_tic_identity_transaction(p_provider_reference text)
RETURNS TABLE(tenant_id uuid, identity_transaction_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=app,pg_temp AS $$
  SELECT tenant_id,id FROM app.identity_transactions
  WHERE provider='TIC_BANKID' AND provider_reference=p_provider_reference
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_tic_identity_transaction(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.resolve_email_message(p_provider text, p_provider_message_id text)
RETURNS TABLE(tenant_id uuid, email_message_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=app,pg_temp AS $$
  SELECT tenant_id,id FROM app.email_messages
  WHERE provider=p_provider AND provider_message_id=p_provider_message_id
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_email_message(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.resolve_public_verification(p_verification_id text)
RETURNS TABLE(tenant_id uuid, evidence_package_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=app,pg_temp AS $$
  SELECT tenant_id,id FROM app.evidence_packages
  WHERE verification_id=p_verification_id AND status='ready'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_public_verification(text) FROM PUBLIC;
