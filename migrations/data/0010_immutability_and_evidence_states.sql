-- Purpose: protect immutable document, policy, signer, identity and cryptographic evidence bindings.
-- Impact: Blocks mutations that could change what was approved or signed and validates provider/attempt status transitions.
-- Backfill: Validates the identity status vocabulary; no row rewrite is performed.
-- Rollback: Remove these triggers only after rolling back all dependent application code in a maintenance window.
-- Verification: Attempt forbidden mutations and invalid transitions under API, worker and trusted-service actor contexts.

CREATE OR REPLACE FUNCTION app.protect_document_version_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status::text IN ('locked','partially_signed','signed','validated','archived') THEN
      RAISE EXCEPTION 'locked document versions are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status::text IN ('locked','partially_signed','signed','validated','archived')
     AND (NEW.sha256 IS NULL OR NEW.canonical_object_key IS NULL OR NEW.locked_at IS NULL) THEN
    RAISE EXCEPTION 'locked document version requires canonical object, digest and lock timestamp';
  END IF;

  IF OLD.status::text IN ('locked','partially_signed','signed','validated','archived')
     AND (
       NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.source_object_key IS DISTINCT FROM OLD.source_object_key
       OR NEW.canonical_object_key IS DISTINCT FROM OLD.canonical_object_key
       OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
       OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
       OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     ) THEN
    RAISE EXCEPTION 'locked document version binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_versions_binding_immutable
BEFORE UPDATE OR DELETE ON app.document_versions
FOR EACH ROW EXECUTE FUNCTION app.protect_document_version_binding();

CREATE OR REPLACE FUNCTION app.protect_case_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text NOT IN ('draft','preparing','ready')
     AND (
       NEW.decision_mode IS DISTINCT FROM OLD.decision_mode
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
       OR NEW.information_classification IS DISTINCT FROM OLD.information_classification
     ) THEN
    RAISE EXCEPTION 'sent signature case policy snapshot and classification are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_cases_policy_snapshot_immutable
BEFORE UPDATE ON app.signature_cases
FOR EACH ROW EXECUTE FUNCTION app.protect_case_policy_snapshot();

CREATE OR REPLACE FUNCTION app.protect_signer_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text <> 'pending'
     AND (
       NEW.signature_case_id IS DISTINCT FROM OLD.signature_case_id
       OR NEW.expected_identifier_ciphertext IS DISTINCT FROM OLD.expected_identifier_ciphertext
       OR NEW.expected_identifier_blind_index IS DISTINCT FROM OLD.expected_identifier_blind_index
       OR NEW.expected_identifier_type IS DISTINCT FROM OLD.expected_identifier_type
       OR NEW.signing_order IS DISTINCT FROM OLD.signing_order
       OR NEW.required IS DISTINCT FROM OLD.required
     ) THEN
    RAISE EXCEPTION 'invited signer identity and ordering binding are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signers_binding_immutable
BEFORE UPDATE ON app.signers
FOR EACH ROW EXECUTE FUNCTION app.protect_signer_binding();

ALTER TABLE app.identity_transactions
  ADD CONSTRAINT identity_transactions_status_vocabulary
  CHECK (status IN ('PENDING','USER_ACTION_REQUIRED','COMPLETED','CANCELLED','EXPIRED','FAILED')) NOT VALID;
ALTER TABLE app.identity_transactions VALIDATE CONSTRAINT identity_transactions_status_vocabulary;

CREATE OR REPLACE FUNCTION app.protect_identity_transaction_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF (
    NEW.signer_id IS DISTINCT FROM OLD.signer_id
    OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
    OR NEW.state_hash IS DISTINCT FROM OLD.state_hash
    OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'identity transaction binding is immutable';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'PENDING' THEN ARRAY['USER_ACTION_REQUIRED','COMPLETED','CANCELLED','EXPIRED','FAILED']
    WHEN 'USER_ACTION_REQUIRED' THEN ARRAY['COMPLETED','CANCELLED','EXPIRED','FAILED']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'invalid identity transaction status transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'COMPLETED'
     AND (NEW.completed_at IS NULL OR NEW.raw_evidence_object_key IS NULL OR NEW.evidence_sha256 IS NULL) THEN
    RAISE EXCEPTION 'completed identity transaction requires immutable provider evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_transactions_binding_immutable
BEFORE UPDATE ON app.identity_transactions
FOR EACH ROW EXECUTE FUNCTION app.protect_identity_transaction_binding();

CREATE OR REPLACE FUNCTION app.assert_signature_attempt_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'prepared' THEN ARRAY['identity_verified','failed','cancelled']
    WHEN 'identity_verified' THEN ARRAY['credential_issued','failed','cancelled']
    WHEN 'credential_issued' THEN ARRAY['signed','failed','cancelled']
    WHEN 'signed' THEN ARRAY['validated','failed']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'invalid signature attempt status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_attempts_status_transition
BEFORE UPDATE OF status ON app.signature_attempts
FOR EACH ROW EXECUTE FUNCTION app.assert_signature_attempt_transition();
CREATE TRIGGER signature_attempts_terminal_guard_insert
BEFORE INSERT ON app.signature_attempts
FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER signature_attempts_terminal_guard_update
BEFORE UPDATE OF status ON app.signature_attempts
FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();

CREATE OR REPLACE FUNCTION app.require_evidence_writer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor text := current_setting('app.actor_kind', true);
BEGIN
  IF actor NOT IN ('worker','trusted_service') THEN
    RAISE EXCEPTION 'evidence records may only be created by a verified worker or trusted service';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.require_trusted_cryptographic_service() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.actor_kind', true) <> 'trusted_service' THEN
    RAISE EXCEPTION 'cryptographic evidence may only be created by a trusted service';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER identity_transactions_terminal_guard_insert
BEFORE INSERT ON app.identity_transactions
FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER identity_transactions_terminal_guard_update
BEFORE UPDATE OF status ON app.identity_transactions
FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER archive_exports_terminal_guard_insert
BEFORE INSERT ON app.archive_exports
FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER archive_exports_terminal_guard_update
BEFORE UPDATE OF status ON app.archive_exports
FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER digital_approval_evidence_writer
BEFORE INSERT ON app.digital_approval_evidence
FOR EACH ROW EXECUTE FUNCTION app.require_evidence_writer();
CREATE TRIGGER bankid_transactions_writer
BEFORE INSERT ON app.bankid_transactions
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER freja_transactions_writer
BEFORE INSERT ON app.freja_transactions
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER signature_artifacts_writer
BEFORE INSERT ON app.signature_artifacts
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER signature_certificates_writer
BEFORE INSERT ON app.signature_certificates
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER certificate_chains_writer
BEFORE INSERT ON app.certificate_chains
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER ocsp_evidence_writer
BEFORE INSERT ON app.ocsp_evidence
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER crl_evidence_writer
BEFORE INSERT ON app.crl_evidence
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER timestamp_tokens_writer
BEFORE INSERT ON app.timestamp_tokens
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER trust_list_snapshots_writer
BEFORE INSERT ON app.trust_list_snapshots
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER validation_runs_writer
BEFORE INSERT ON app.validation_runs
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER validation_results_writer
BEFORE INSERT ON app.validation_results
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();
CREATE TRIGGER validation_reports_writer
BEFORE INSERT ON app.validation_reports
FOR EACH ROW EXECUTE FUNCTION app.require_trusted_cryptographic_service();

CREATE OR REPLACE FUNCTION app.protect_versioned_record() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'versioned records cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'versioned record content is immutable; create a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_policies_version_immutable
BEFORE UPDATE OR DELETE ON app.signature_policies
FOR EACH ROW EXECUTE FUNCTION app.protect_versioned_record();
CREATE TRIGGER notification_templates_version_immutable
BEFORE UPDATE OR DELETE ON app.notification_templates
FOR EACH ROW EXECUTE FUNCTION app.protect_versioned_record();

CREATE TRIGGER document_hashes_append_only
BEFORE UPDATE OR DELETE ON app.document_hashes FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER document_scan_results_append_only
BEFORE UPDATE OR DELETE ON app.document_scan_results FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER document_render_snapshots_append_only
BEFORE UPDATE OR DELETE ON app.document_render_snapshots FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER signature_artifacts_append_only
BEFORE UPDATE OR DELETE ON app.signature_artifacts FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER signature_certificates_append_only
BEFORE UPDATE OR DELETE ON app.signature_certificates FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER certificate_chains_append_only
BEFORE UPDATE OR DELETE ON app.certificate_chains FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER ocsp_evidence_append_only
BEFORE UPDATE OR DELETE ON app.ocsp_evidence FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER crl_evidence_append_only
BEFORE UPDATE OR DELETE ON app.crl_evidence FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER timestamp_tokens_append_only
BEFORE UPDATE OR DELETE ON app.timestamp_tokens FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER trust_list_snapshots_append_only
BEFORE UPDATE OR DELETE ON app.trust_list_snapshots FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER validation_runs_append_only
BEFORE UPDATE OR DELETE ON app.validation_runs FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER validation_results_append_only
BEFORE UPDATE OR DELETE ON app.validation_results FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER validation_reports_append_only
BEFORE UPDATE OR DELETE ON app.validation_reports FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
