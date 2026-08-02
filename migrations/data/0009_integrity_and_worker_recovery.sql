-- Purpose: enforce workflow transitions, server-only evidence states, same-case relations and recover expired worker leases.
-- Impact: Adds digital approval evidence, workflow and same-case guards, audit v2 material and recoverable job leases.
-- Backfill: Normalizes no business data; new audit columns default safely and future events use hash version 2.
-- Rollback: Drop the new triggers/functions/indexes only after rolling back dependent application code in a maintenance window.
-- Verification: Run verify:migrations plus database integration tests for transitions, completion evidence, RLS and expired lease recovery.
-- Rollback: drop the triggers/functions/indexes in a maintenance window; no data is deleted by this migration.

-- Digital approvals are immutable evidence records, separate from cryptographic signature artifacts.
CREATE TABLE app.digital_approval_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  signer_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  authenticated_user_id uuid,
  identity_transaction_id uuid,
  authentication_method text NOT NULL,
  intent_text text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  session_metadata_ciphertext bytea,
  occurred_at timestamptz NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, signer_id, document_version_id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES app.document_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, authenticated_user_id) REFERENCES app.users(tenant_id, id),
  FOREIGN KEY (tenant_id, identity_transaction_id) REFERENCES app.identity_transactions(tenant_id, id),
  CHECK (authenticated_user_id IS NOT NULL OR identity_transaction_id IS NOT NULL)
);
ALTER TABLE app.digital_approval_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.digital_approval_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.digital_approval_evidence
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.prevent_unverified_terminal_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor text := current_setting('app.actor_kind', true);
BEGIN
  IF NEW.status::text IN ('signed','completed','validated','archived')
     AND actor NOT IN ('worker','trusted_service') THEN
    RAISE EXCEPTION 'terminal status requires verified server evidence';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS signature_case_terminal_guard ON app.signature_cases;
DROP TRIGGER IF EXISTS signer_terminal_guard ON app.signers;
DROP TRIGGER IF EXISTS document_terminal_guard ON app.document_versions;
CREATE TRIGGER signature_case_terminal_guard_insert
BEFORE INSERT ON app.signature_cases FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER signature_case_terminal_guard_update
BEFORE UPDATE OF status ON app.signature_cases FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER signer_terminal_guard_insert
BEFORE INSERT ON app.signers FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER signer_terminal_guard_update
BEFORE UPDATE OF status ON app.signers FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER document_terminal_guard_insert
BEFORE INSERT ON app.document_versions FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();
CREATE TRIGGER document_terminal_guard_update
BEFORE UPDATE OF status ON app.document_versions FOR EACH ROW EXECUTE FUNCTION app.prevent_unverified_terminal_status();

CREATE OR REPLACE FUNCTION app.assert_valid_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
  old_status text := OLD.status::text;
  new_status text := NEW.status::text;
BEGIN
  IF old_status = new_status THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'signature_cases' THEN
    allowed := CASE old_status
      WHEN 'draft' THEN ARRAY['preparing','cancelled']
      WHEN 'preparing' THEN ARRAY['ready','failed','cancelled']
      WHEN 'ready' THEN ARRAY['sent','cancelled']
      WHEN 'sent' THEN ARRAY['in_progress','declined','expired','cancelled','failed']
      WHEN 'in_progress' THEN ARRAY['partially_signed','completed','declined','expired','cancelled','failed']
      WHEN 'partially_signed' THEN ARRAY['completed','declined','expired','cancelled','failed']
      WHEN 'completed' THEN ARRAY['archiving']
      WHEN 'declined' THEN ARRAY['archiving']
      WHEN 'expired' THEN ARRAY['archiving']
      WHEN 'cancelled' THEN ARRAY['archiving']
      WHEN 'failed' THEN ARRAY['archiving']
      WHEN 'archiving' THEN ARRAY['archived','failed']
      ELSE ARRAY[]::text[]
    END;
  ELSIF TG_TABLE_NAME = 'signers' THEN
    allowed := CASE old_status
      WHEN 'pending' THEN ARRAY['invited','cancelled']
      WHEN 'invited' THEN ARRAY['opened','identity_started','expired','cancelled','failed']
      WHEN 'opened' THEN ARRAY['identity_started','declined','expired','cancelled','failed']
      WHEN 'identity_started' THEN ARRAY['identity_verified','declined','expired','cancelled','failed']
      WHEN 'identity_verified' THEN ARRAY['signing','declined','expired','cancelled','failed']
      WHEN 'signing' THEN ARRAY['signed','declined','expired','cancelled','failed']
      ELSE ARRAY[]::text[]
    END;
  ELSIF TG_TABLE_NAME = 'document_versions' THEN
    allowed := CASE old_status
      WHEN 'uploaded' THEN ARRAY['quarantined','rejected']
      WHEN 'quarantined' THEN ARRAY['scanning','rejected']
      WHEN 'scanning' THEN ARRAY['canonicalizing','rejected']
      WHEN 'canonicalizing' THEN ARRAY['ready','rejected']
      WHEN 'ready' THEN ARRAY['locked']
      WHEN 'locked' THEN ARRAY['partially_signed','signed']
      WHEN 'partially_signed' THEN ARRAY['signed']
      WHEN 'signed' THEN ARRAY['validated']
      WHEN 'validated' THEN ARRAY['archived']
      ELSE ARRAY[]::text[]
    END;
  ELSE
    RAISE EXCEPTION 'unsupported status transition table: %', TG_TABLE_NAME;
  END IF;

  IF NOT (new_status = ANY(allowed)) THEN
    RAISE EXCEPTION 'invalid % status transition: % -> %', TG_TABLE_NAME, old_status, new_status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signature_cases_status_transition
BEFORE UPDATE OF status ON app.signature_cases FOR EACH ROW EXECUTE FUNCTION app.assert_valid_status_transition();
CREATE TRIGGER signers_status_transition
BEFORE UPDATE OF status ON app.signers FOR EACH ROW EXECUTE FUNCTION app.assert_valid_status_transition();
CREATE TRIGGER document_versions_status_transition
BEFORE UPDATE OF status ON app.document_versions FOR EACH ROW EXECUTE FUNCTION app.assert_valid_status_transition();

CREATE OR REPLACE FUNCTION app.assert_document_field_same_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE document_case uuid; signer_case uuid;
BEGIN
  IF NEW.signer_id IS NULL THEN RETURN NEW; END IF;
  SELECT d.signature_case_id INTO document_case
  FROM app.document_versions dv JOIN app.documents d
    ON d.tenant_id = dv.tenant_id AND d.id = dv.document_id
  WHERE dv.tenant_id = NEW.tenant_id AND dv.id = NEW.document_version_id;
  SELECT s.signature_case_id INTO signer_case FROM app.signers s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.signer_id;
  IF document_case IS DISTINCT FROM signer_case THEN RAISE EXCEPTION 'document field signer belongs to another signature case'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_fields_same_case
BEFORE INSERT OR UPDATE OF document_version_id, signer_id ON app.document_fields
FOR EACH ROW EXECUTE FUNCTION app.assert_document_field_same_case();

CREATE OR REPLACE FUNCTION app.assert_signing_step_same_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE order_case uuid; signer_case uuid;
BEGIN
  SELECT signature_case_id INTO order_case FROM app.signing_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.signing_order_id;
  SELECT signature_case_id INTO signer_case FROM app.signers
  WHERE tenant_id = NEW.tenant_id AND id = NEW.signer_id;
  IF order_case IS DISTINCT FROM signer_case THEN RAISE EXCEPTION 'signing step signer belongs to another signature case'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signing_steps_same_case
BEFORE INSERT OR UPDATE OF signing_order_id, signer_id ON app.signing_steps
FOR EACH ROW EXECUTE FUNCTION app.assert_signing_step_same_case();

CREATE OR REPLACE FUNCTION app.assert_identity_transaction_same_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE signer_case uuid; document_case uuid;
BEGIN
  SELECT signature_case_id INTO signer_case FROM app.signers
  WHERE tenant_id = NEW.tenant_id AND id = NEW.signer_id;
  SELECT d.signature_case_id INTO document_case
  FROM app.document_versions dv JOIN app.documents d
    ON d.tenant_id = dv.tenant_id AND d.id = dv.document_id
  WHERE dv.tenant_id = NEW.tenant_id AND dv.id = NEW.document_version_id;
  IF signer_case IS DISTINCT FROM document_case THEN RAISE EXCEPTION 'identity transaction document and signer belong to different signature cases'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_transactions_same_case
BEFORE INSERT OR UPDATE OF signer_id, document_version_id ON app.identity_transactions
FOR EACH ROW EXECUTE FUNCTION app.assert_identity_transaction_same_case();

CREATE OR REPLACE FUNCTION app.assert_signature_attempt_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  identity_signer uuid;
  identity_document uuid;
  identity_provider app.identity_provider;
  signer_case uuid;
  document_case uuid;
  document_digest text;
  document_state text;
BEGIN
  SELECT signer_id, document_version_id, provider
  INTO identity_signer, identity_document, identity_provider
  FROM app.identity_transactions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.identity_transaction_id;

  IF identity_signer IS DISTINCT FROM NEW.signer_id
     OR identity_document IS DISTINCT FROM NEW.document_version_id
     OR identity_provider IS DISTINCT FROM NEW.provider THEN
    RAISE EXCEPTION 'signature attempt does not match its verified identity transaction';
  END IF;

  SELECT signature_case_id INTO signer_case FROM app.signers
  WHERE tenant_id = NEW.tenant_id AND id = NEW.signer_id;
  SELECT d.signature_case_id, dv.sha256, dv.status::text
  INTO document_case, document_digest, document_state
  FROM app.document_versions dv JOIN app.documents d
    ON d.tenant_id = dv.tenant_id AND d.id = dv.document_id
  WHERE dv.tenant_id = NEW.tenant_id AND dv.id = NEW.document_version_id;

  IF signer_case IS DISTINCT FROM document_case THEN RAISE EXCEPTION 'signature attempt document and signer belong to different signature cases'; END IF;
  IF document_digest IS NULL OR document_digest IS DISTINCT FROM NEW.document_sha256 THEN RAISE EXCEPTION 'signature attempt digest does not match immutable document digest'; END IF;
  IF document_state NOT IN ('locked','partially_signed','signed') THEN RAISE EXCEPTION 'signature attempt requires a locked document version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_attempts_consistent
BEFORE INSERT OR UPDATE OF signer_id, document_version_id, identity_transaction_id, document_sha256, provider
ON app.signature_attempts FOR EACH ROW EXECUTE FUNCTION app.assert_signature_attempt_consistency();

CREATE OR REPLACE FUNCTION app.assert_digital_approval_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  signer_case uuid;
  document_case uuid;
  document_digest text;
  identity_signer uuid;
  identity_document uuid;
BEGIN
  SELECT signature_case_id INTO signer_case FROM app.signers
  WHERE tenant_id = NEW.tenant_id AND id = NEW.signer_id;
  SELECT d.signature_case_id, dv.sha256 INTO document_case, document_digest
  FROM app.document_versions dv JOIN app.documents d
    ON d.tenant_id = dv.tenant_id AND d.id = dv.document_id
  WHERE dv.tenant_id = NEW.tenant_id AND dv.id = NEW.document_version_id;
  IF signer_case IS DISTINCT FROM NEW.signature_case_id OR document_case IS DISTINCT FROM NEW.signature_case_id THEN
    RAISE EXCEPTION 'digital approval evidence references another signature case';
  END IF;
  IF document_digest IS NULL OR document_digest IS DISTINCT FROM NEW.document_sha256 THEN
    RAISE EXCEPTION 'digital approval digest does not match immutable document digest';
  END IF;
  IF NEW.identity_transaction_id IS NOT NULL THEN
    SELECT signer_id, document_version_id INTO identity_signer, identity_document
    FROM app.identity_transactions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.identity_transaction_id;
    IF identity_signer IS DISTINCT FROM NEW.signer_id OR identity_document IS DISTINCT FROM NEW.document_version_id THEN
      RAISE EXCEPTION 'digital approval identity transaction does not match signer and document';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER digital_approval_evidence_consistent
BEFORE INSERT ON app.digital_approval_evidence
FOR EACH ROW EXECUTE FUNCTION app.assert_digital_approval_consistency();
CREATE TRIGGER digital_approval_evidence_no_mutation
BEFORE UPDATE OR DELETE ON app.digital_approval_evidence
FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

CREATE OR REPLACE FUNCTION app.assert_signer_session_invitation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE invited_signer uuid;
BEGIN
  SELECT signer_id INTO invited_signer FROM app.signer_invitations
  WHERE tenant_id = NEW.tenant_id AND id = NEW.invitation_id;
  IF invited_signer IS DISTINCT FROM NEW.signer_id THEN RAISE EXCEPTION 'signer session invitation belongs to another signer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signer_sessions_invitation_matches
BEFORE INSERT OR UPDATE OF signer_id, invitation_id ON app.signer_sessions
FOR EACH ROW EXECUTE FUNCTION app.assert_signer_session_invitation();

CREATE OR REPLACE FUNCTION app.assert_reminder_same_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE signer_case uuid;
BEGIN
  IF NEW.signer_id IS NULL THEN RETURN NEW; END IF;
  SELECT signature_case_id INTO signer_case FROM app.signers
  WHERE tenant_id = NEW.tenant_id AND id = NEW.signer_id;
  IF signer_case IS DISTINCT FROM NEW.signature_case_id THEN RAISE EXCEPTION 'reminder signer belongs to another signature case'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reminder_schedules_same_case
BEFORE INSERT OR UPDATE OF signature_case_id, signer_id ON app.reminder_schedules
FOR EACH ROW EXECUTE FUNCTION app.assert_reminder_same_case();

CREATE OR REPLACE FUNCTION app.assert_archive_export_same_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE package_case uuid;
BEGIN
  SELECT signature_case_id INTO package_case FROM app.evidence_packages
  WHERE tenant_id = NEW.tenant_id AND id = NEW.evidence_package_id;
  IF package_case IS DISTINCT FROM NEW.signature_case_id THEN RAISE EXCEPTION 'archive export evidence package belongs to another signature case'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER archive_exports_same_case
BEFORE INSERT OR UPDATE OF signature_case_id, evidence_package_id ON app.archive_exports
FOR EACH ROW EXECUTE FUNCTION app.assert_archive_export_same_case();

CREATE OR REPLACE FUNCTION app.assert_case_completion_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  missing_count bigint;
BEGIN
  IF NEW.status::text <> 'completed' OR OLD.status::text = 'completed' THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.signers s
    WHERE s.tenant_id = NEW.tenant_id AND s.signature_case_id = NEW.id AND s.required
  ) THEN
    RAISE EXCEPTION 'signature case cannot complete without a required participant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.signers s
    WHERE s.tenant_id = NEW.tenant_id AND s.signature_case_id = NEW.id AND s.required AND s.status::text <> 'signed'
  ) THEN
    RAISE EXCEPTION 'signature case completion requires every required participant to be completed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.documents d WHERE d.tenant_id = NEW.tenant_id AND d.signature_case_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'signature case cannot complete without a document';
  END IF;

  IF NEW.decision_mode::text = 'DIGITAL_APPROVAL' THEN
    SELECT count(*) INTO missing_count
    FROM app.signers s
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (d.id) dv.id AS document_version_id
      FROM app.documents d
      JOIN app.document_versions dv ON dv.tenant_id = d.tenant_id AND dv.document_id = d.id
      WHERE d.tenant_id = NEW.tenant_id AND d.signature_case_id = NEW.id
      ORDER BY d.id, dv.version DESC
    ) latest
    WHERE s.tenant_id = NEW.tenant_id AND s.signature_case_id = NEW.id AND s.required
      AND NOT EXISTS (
        SELECT 1 FROM app.digital_approval_evidence dae
        WHERE dae.tenant_id = NEW.tenant_id
          AND dae.signature_case_id = NEW.id
          AND dae.signer_id = s.id
          AND dae.document_version_id = latest.document_version_id
      );
    IF missing_count > 0 THEN RAISE EXCEPTION 'digital approval completion lacks immutable approval evidence'; END IF;
  ELSE
    SELECT count(*) INTO missing_count
    FROM app.signers s
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (d.id) dv.id AS document_version_id
      FROM app.documents d
      JOIN app.document_versions dv ON dv.tenant_id = d.tenant_id AND dv.document_id = d.id
      WHERE d.tenant_id = NEW.tenant_id AND d.signature_case_id = NEW.id
      ORDER BY d.id, dv.version DESC
    ) latest
    WHERE s.tenant_id = NEW.tenant_id AND s.signature_case_id = NEW.id AND s.required
      AND NOT EXISTS (
        SELECT 1
        FROM app.signature_attempts sa
        JOIN app.signature_artifacts artifact
          ON artifact.tenant_id = sa.tenant_id AND artifact.signature_attempt_id = sa.id
        JOIN app.validation_runs vr
          ON vr.tenant_id = artifact.tenant_id AND vr.signature_artifact_id = artifact.id
        WHERE sa.tenant_id = NEW.tenant_id
          AND sa.signer_id = s.id
          AND sa.document_version_id = latest.document_version_id
          AND sa.status = 'validated'
          AND (
            vr.indication = 'TOTAL_PASSED'
            OR (
              vr.indication = 'INDETERMINATE'
              AND COALESCE(NEW.policy_snapshot->'allowedValidationResults', '["TOTAL_PASSED"]'::jsonb) ? 'INDETERMINATE'
            )
          )
      );
    IF missing_count > 0 THEN RAISE EXCEPTION 'electronic signature completion lacks validated cryptographic evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signature_cases_completion_evidence
BEFORE UPDATE OF status ON app.signature_cases
FOR EACH ROW EXECUTE FUNCTION app.assert_case_completion_evidence();

ALTER TABLE audit.audit_events ADD COLUMN hash_version integer NOT NULL DEFAULT 1;
ALTER TABLE audit.audit_events ADD COLUMN hash_material text;

CREATE OR REPLACE FUNCTION audit.append_event(
  p_tenant_id uuid,
  p_category text,
  p_event_type text,
  p_actor_type text,
  p_actor_id uuid,
  p_resource_type text,
  p_resource_id uuid,
  p_payload jsonb,
  p_occurred_at timestamptz DEFAULT now()
) RETURNS audit.audit_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, app, pg_temp AS $$
DECLARE
  head audit.audit_chain_heads;
  next_hash text;
  next_sequence bigint;
  canonical_payload jsonb;
  inserted audit.audit_events;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'tenant mismatch'; END IF;
  IF p_category NOT IN ('TECHNICAL','BUSINESS') THEN RAISE EXCEPTION 'invalid audit category'; END IF;
  INSERT INTO audit.audit_chain_heads(tenant_id) VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO head FROM audit.audit_chain_heads WHERE tenant_id = p_tenant_id FOR UPDATE;
  next_sequence := head.last_sequence + 1;
  canonical_payload := jsonb_build_object(
    'hashVersion', 2,
    'previousEventHash', head.last_event_hash,
    'tenantId', p_tenant_id,
    'sequence', next_sequence,
    'category', p_category,
    'eventType', p_event_type,
    'actorType', p_actor_type,
    'actorId', p_actor_id,
    'resourceType', p_resource_type,
    'resourceId', p_resource_id,
    'payload', p_payload,
    'occurredAt', to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
  next_hash := encode(digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex');
  INSERT INTO audit.audit_events(
    tenant_id, sequence, category, event_type, actor_type, actor_id, resource_type, resource_id,
    payload, occurred_at, previous_event_hash, event_hash, hash_version, hash_material
  ) VALUES (
    p_tenant_id, next_sequence, p_category, p_event_type, p_actor_type, p_actor_id, p_resource_type,
    p_resource_id, p_payload, p_occurred_at, head.last_event_hash, next_hash, 2, canonical_payload::text
  ) RETURNING * INTO inserted;
  UPDATE audit.audit_chain_heads
  SET last_sequence = inserted.sequence, last_event_hash = inserted.event_hash, updated_at = now()
  WHERE tenant_id = p_tenant_id;
  RETURN inserted;
END $$;
REVOKE ALL ON FUNCTION audit.append_event(uuid,text,text,text,uuid,text,uuid,jsonb,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.claim_durable_jobs(p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS SETOF app.durable_jobs
LANGUAGE plpgsql AS $$
BEGIN
  IF p_worker IS NULL OR btrim(p_worker) = '' THEN RAISE EXCEPTION 'worker identity is required'; END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'job claim limit must be between 1 and 1000'; END IF;
  IF p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'job lease must be between 5 and 3600 seconds'; END IF;

  RETURN QUERY
  UPDATE app.durable_jobs j
  SET status = 'leased',
      lease_owner = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      updated_at = now()
  WHERE (j.tenant_id, j.id) IN (
    SELECT candidate.tenant_id, candidate.id
    FROM app.durable_jobs candidate
    WHERE candidate.tenant_id = app.current_tenant_id()
      AND candidate.available_at <= now()
      AND candidate.attempts < candidate.maximum_attempts
      AND (
        candidate.status = 'pending'
        OR (candidate.status = 'leased' AND candidate.lease_expires_at < now())
      )
    ORDER BY candidate.available_at, candidate.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING j.*;
END $$;

CREATE INDEX durable_jobs_claimable_idx
  ON app.durable_jobs (tenant_id, status, available_at, lease_expires_at)
  WHERE status IN ('pending','leased');
CREATE INDEX identity_provider_events_unprocessed_idx
  ON app.identity_provider_events (tenant_id, received_at)
  WHERE processed_at IS NULL;
CREATE UNIQUE INDEX signature_policies_one_active_version
  ON app.signature_policies (tenant_id, id) WHERE active;
CREATE UNIQUE INDEX notification_templates_one_active_version
  ON app.notification_templates (tenant_id, template_key, locale) WHERE active;
