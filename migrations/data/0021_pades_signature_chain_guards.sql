-- Purpose: Connect the PAdES signature chain to the database guarantees that make it impossible to record a signature the evidence does not support.
-- Impact: Adds a signing-intent manifest table, a PAdES level ladder mirrored from packages/pades, a revision-chain guard, a per-signer signature-evidence guard, and a stricter case-completion guard.
-- Backfill: No business data is rewritten. app.timestamp_tokens gains token_type defaulting to 'SIGNATURE' and app.signature_artifacts gains a nullable input_revision_sha256; both are additive and safe on an empty or populated table.
-- Rollback: Drop the new triggers, functions and table, then the two added columns, in a maintenance window and only after rolling back the worker code that writes them.
-- Verification: Run verify:migrations, then migrations/data/verify_pades_signature_chain.sql, plus the negative signing-chain tests in tests/run.mjs.

-- ---------------------------------------------------------------------------
-- Why this migration exists
--
-- Until now a signer could be marked 'signed' on the strength of verified
-- TIC/BankID evidence alone. That evidence proves who was present and what they
-- consented to; it is not a signature, and no PDF had been signed at the point
-- the status was set. The application code that did this is being fixed in the
-- same change, but application code is one bug away from doing it again, so the
-- rule is stated here as well. Every guard below is a rule the database will
-- enforce even if every line of TypeScript above it is wrong.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Repair: app.identity_transactions could never hold a real BankID session
--
-- Migration 0010 added a status vocabulary of PENDING / USER_ACTION_REQUIRED /
-- COMPLETED / CANCELLED / EXPIRED / FAILED. The application writes lowercase and
-- uses two states the vocabulary never contained: 'complete_collected' (evidence
-- downloaded but not yet verified) and 'verified' (evidence independently
-- verified). The very first INSERT of a BankID session writes 'pending' and is
-- rejected by the CHECK constraint, so the TIC flow could not complete against
-- any database with 0010 applied.
--
-- The lowercase vocabulary is the canonical one: every other status column in
-- this schema — signature_cases, signers, document_versions, signature_attempts,
-- signing_intents — is lowercase snake_case, and 0010's uppercase set is the
-- outlier. The two missing states are load-bearing, because the difference
-- between "evidence collected" and "evidence verified" is exactly the difference
-- this release exists to enforce.
--
-- 'created' is deliberately absent. Nothing ever wrote it; it survived only in
-- guard clauses, and carrying a state no writer produces invites the belief that
-- some path does produce it.
-- ---------------------------------------------------------------------------
ALTER TABLE app.identity_transactions DROP CONSTRAINT identity_transactions_status_vocabulary;

UPDATE app.identity_transactions SET status = CASE status
  WHEN 'PENDING' THEN 'pending'
  WHEN 'USER_ACTION_REQUIRED' THEN 'user_action_required'
  WHEN 'COMPLETED' THEN 'complete_collected'
  WHEN 'CANCELLED' THEN 'cancelled'
  WHEN 'EXPIRED' THEN 'expired'
  WHEN 'FAILED' THEN 'failed'
  WHEN 'created' THEN 'pending'
  ELSE status
END
WHERE status IN ('PENDING','USER_ACTION_REQUIRED','COMPLETED','CANCELLED','EXPIRED','FAILED','created');

ALTER TABLE app.identity_transactions
  ADD CONSTRAINT identity_transactions_status_vocabulary
  CHECK (status IN ('pending','user_action_required','complete_collected','verified','cancelled','expired','failed')) NOT VALID;
ALTER TABLE app.identity_transactions VALIDATE CONSTRAINT identity_transactions_status_vocabulary;

-- The transition map added in 0010 is uppercase for the same reason the CHECK
-- constraint was, and it fails harder: with lowercase statuses no CASE branch
-- matches, so `allowed` is empty and *every* status change is rejected. Between
-- this and the CHECK constraint, no BankID session could start, collect evidence
-- or be verified. The map below is the lowercase vocabulary with the two states
-- the evidence chain actually needs.
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
    WHEN 'pending' THEN ARRAY['user_action_required','complete_collected','cancelled','expired','failed']
    WHEN 'user_action_required' THEN ARRAY['pending','complete_collected','cancelled','expired','failed']
    WHEN 'complete_collected' THEN ARRAY['verified','failed']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'invalid identity transaction status transition: % -> %', OLD.status, NEW.status;
  END IF;
  -- Collected means the provider evidence is durably stored, not merely that the
  -- provider said "done". Without the object key and its hash there is nothing
  -- an independent verifier could later be pointed at.
  IF NEW.status = 'complete_collected'
     AND (NEW.completed_at IS NULL OR NEW.raw_evidence_object_key IS NULL OR NEW.evidence_sha256 IS NULL) THEN
    RAISE EXCEPTION 'collected identity transaction requires immutable provider evidence';
  END IF;
  RETURN NEW;
END $$;

-- 'verified' is the state that says an independent verifier confirmed the
-- evidence. It must never be reachable without a PASS artifact recorded.
CREATE OR REPLACE FUNCTION app.assert_identity_transaction_verification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'verified' AND OLD.status IS DISTINCT FROM 'verified' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.tic_identity_artifacts a
      WHERE a.tenant_id = NEW.tenant_id AND a.identity_transaction_id = NEW.id AND a.verification_result = 'PASS'
    ) AND NOT EXISTS (
      SELECT 1 FROM app.freja_identity_artifacts a
      WHERE a.tenant_id = NEW.tenant_id AND a.identity_transaction_id = NEW.id AND a.verification_result = 'PASS'
    ) THEN
      RAISE EXCEPTION 'identity transaction cannot be verified without a passing verification artifact';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER identity_transactions_verification_evidence
BEFORE UPDATE OF status ON app.identity_transactions
FOR EACH ROW EXECUTE FUNCTION app.assert_identity_transaction_verification();


-- A timestamp over the signature and a timestamp over the archive are different
-- claims: the first gets a signature to PAdES-T, the second to LTA. Storing both
-- in one table with no way to tell them apart made the ladder unknowable.
ALTER TABLE app.timestamp_tokens
  ADD COLUMN token_type text NOT NULL DEFAULT 'SIGNATURE'
  CHECK (token_type IN ('SIGNATURE', 'ARCHIVE'));

-- Which revision this signature was applied on top of. For the first signer this
-- is the canonical document hash; for every later signer it is the previous
-- signed revision. Without it there is no way to prove signatures form a chain
-- rather than a fork.
ALTER TABLE app.signature_artifacts
  ADD COLUMN input_revision_sha256 text
  CHECK (input_revision_sha256 IS NULL OR input_revision_sha256 ~ '^[0-9a-f]{64}$');


-- ---------------------------------------------------------------------------
-- Deterministic multi-document manifest
--
-- A signing intent may cover several documents. The signer consents once, to the
-- set. The manifest is the canonical record of exactly which document versions
-- and which hashes that set contained, so the set cannot be reinterpreted later.
-- ---------------------------------------------------------------------------
CREATE TABLE app.signing_intent_manifests (
  tenant_id uuid NOT NULL,
  signing_intent_id uuid NOT NULL,
  manifest_schema text NOT NULL CHECK (manifest_schema = 'kommunsign.signing-intent-manifest.v1'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_object_key text NOT NULL,
  document_count integer NOT NULL CHECK (document_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, signing_intent_id),
  FOREIGN KEY (tenant_id, signing_intent_id) REFERENCES app.signing_intents(tenant_id, id)
);
ALTER TABLE app.signing_intent_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.signing_intent_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.signing_intent_manifests
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.signing_intent_manifests FROM PUBLIC;

CREATE TRIGGER signing_intent_manifests_no_mutation
BEFORE UPDATE OR DELETE ON app.signing_intent_manifests
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

CREATE TRIGGER signing_intent_manifests_writer
BEFORE INSERT ON app.signing_intent_manifests
FOR EACH ROW EXECUTE FUNCTION app.require_evidence_writer();

COMMENT ON TABLE app.signing_intent_manifests IS
  'Append-only deterministic manifest binding every document version SHA-256 covered by one signing intent.';


-- ---------------------------------------------------------------------------
-- The PAdES level ladder
--
-- This mirrors attainedPadesLevel() in packages/pades. Two implementations of
-- one rule is a real cost, and it is paid deliberately: the TypeScript gate is
-- what produces a good error message, and this one is what remains true when a
-- future caller forgets to go through that gate. They are tested against each
-- other rather than trusted to agree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.pades_level_rank(level text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE replace(coalesce(level, 'NONE'), 'PAdES-', '')
    WHEN 'NONE' THEN 0
    WHEN 'B' THEN 1
    WHEN 'T' THEN 2
    WHEN 'LT' THEN 3
    WHEN 'LTA' THEN 4
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION app.attained_pades_level(p_tenant_id uuid, p_artifact_id uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  has_certificate boolean;
  has_chain boolean;
  has_signature_timestamp boolean;
  has_revocation boolean;
  has_trust_list boolean;
  has_archive_timestamp boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM app.signature_certificates c
                  WHERE c.tenant_id = p_tenant_id AND c.signature_artifact_id = p_artifact_id)
    INTO has_certificate;
  SELECT EXISTS (SELECT 1 FROM app.certificate_chains ch
                  WHERE ch.tenant_id = p_tenant_id AND ch.signature_artifact_id = p_artifact_id)
    INTO has_chain;

  -- Without the signer's certificate and its chain there is no level at all:
  -- a signature nobody can attribute is not an advanced electronic signature.
  IF NOT (has_certificate AND has_chain) THEN RETURN NULL; END IF;

  SELECT EXISTS (SELECT 1 FROM app.timestamp_tokens t
                  WHERE t.tenant_id = p_tenant_id AND t.signature_artifact_id = p_artifact_id
                    AND t.token_type = 'SIGNATURE')
    INTO has_signature_timestamp;
  IF NOT has_signature_timestamp THEN RETURN 'PAdES-B'; END IF;

  SELECT EXISTS (SELECT 1 FROM app.ocsp_evidence o
                  WHERE o.tenant_id = p_tenant_id AND o.signature_artifact_id = p_artifact_id)
      OR EXISTS (SELECT 1 FROM app.crl_evidence c
                  WHERE c.tenant_id = p_tenant_id AND c.signature_artifact_id = p_artifact_id)
    INTO has_revocation;
  SELECT EXISTS (SELECT 1 FROM app.validation_runs v
                  WHERE v.tenant_id = p_tenant_id AND v.signature_artifact_id = p_artifact_id
                    AND v.trust_list_snapshot_object_key IS NOT NULL)
    INTO has_trust_list;
  IF NOT (has_revocation AND has_trust_list) THEN RETURN 'PAdES-T'; END IF;

  SELECT EXISTS (SELECT 1 FROM app.timestamp_tokens t
                  WHERE t.tenant_id = p_tenant_id AND t.signature_artifact_id = p_artifact_id
                    AND t.token_type = 'ARCHIVE')
    INTO has_archive_timestamp;
  IF NOT has_archive_timestamp THEN RETURN 'PAdES-LT'; END IF;

  RETURN 'PAdES-LTA';
END $$;


-- Checked at COMMIT, not at INSERT. The evidence rows reference the artifact, so
-- they cannot exist before it; an immediate check would see an artifact with no
-- evidence yet and force every signature down to nothing.
CREATE OR REPLACE FUNCTION app.assert_pades_level_not_overclaimed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attained text;
BEGIN
  attained := app.attained_pades_level(NEW.tenant_id, NEW.id);
  IF attained IS NULL THEN
    RAISE EXCEPTION 'signature artifact % has no signing certificate and chain, so it supports no PAdES level', NEW.id;
  END IF;
  IF app.pades_level_rank(NEW.format) > app.pades_level_rank(attained) THEN
    RAISE EXCEPTION 'signature artifact claims % but the collected evidence supports only %', NEW.format, attained;
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER signature_artifacts_level_not_overclaimed
AFTER INSERT OR UPDATE ON app.signature_artifacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.assert_pades_level_not_overclaimed();


-- ---------------------------------------------------------------------------
-- Incremental revision chain
--
-- Multi-signer PAdES works by appending revisions, so every signature after the
-- first must be applied to the previous signed revision. Signing the canonical
-- document twice would produce two signatures each valid in isolation and each
-- silently discarding the other.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_signature_revision_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  document_version uuid;
  canonical_hash text;
  existing_count bigint;
BEGIN
  IF NEW.input_revision_sha256 IS NULL THEN
    RAISE EXCEPTION 'signature artifact must record the revision it was applied to';
  END IF;

  SELECT sa.document_version_id INTO document_version
  FROM app.signature_attempts sa
  WHERE sa.tenant_id = NEW.tenant_id AND sa.id = NEW.signature_attempt_id;
  IF document_version IS NULL THEN
    RAISE EXCEPTION 'signature artifact is not attached to a signature attempt';
  END IF;

  SELECT dv.sha256 INTO canonical_hash
  FROM app.document_versions dv
  WHERE dv.tenant_id = NEW.tenant_id AND dv.id = document_version;

  SELECT count(*) INTO existing_count
  FROM app.signature_artifacts artifact
  JOIN app.signature_attempts attempt
    ON attempt.tenant_id = artifact.tenant_id AND attempt.id = artifact.signature_attempt_id
  WHERE artifact.tenant_id = NEW.tenant_id
    AND attempt.document_version_id = document_version
    AND artifact.id <> NEW.id;

  IF existing_count = 0 THEN
    IF NEW.input_revision_sha256 IS DISTINCT FROM canonical_hash THEN
      RAISE EXCEPTION 'the first signature on a document must be applied to its canonical revision';
    END IF;
    RETURN NEW;
  END IF;

  -- A later signature must continue from a revision that already exists, and
  -- that revision must not already have been continued from — otherwise two
  -- signers branch from the same point and one of them is lost.
  IF NOT EXISTS (
    SELECT 1
    FROM app.signature_artifacts previous
    JOIN app.signature_attempts attempt
      ON attempt.tenant_id = previous.tenant_id AND attempt.id = previous.signature_attempt_id
    WHERE previous.tenant_id = NEW.tenant_id
      AND attempt.document_version_id = document_version
      AND previous.signed_document_sha256 = NEW.input_revision_sha256
  ) THEN
    RAISE EXCEPTION 'signature must continue from an existing signed revision of the same document';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app.signature_artifacts sibling
    JOIN app.signature_attempts attempt
      ON attempt.tenant_id = sibling.tenant_id AND attempt.id = sibling.signature_attempt_id
    WHERE sibling.tenant_id = NEW.tenant_id
      AND attempt.document_version_id = document_version
      AND sibling.id <> NEW.id
      AND sibling.input_revision_sha256 = NEW.input_revision_sha256
  ) THEN
    RAISE EXCEPTION 'two signatures cannot branch from the same document revision';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER signature_artifacts_revision_chain
BEFORE INSERT ON app.signature_artifacts
FOR EACH ROW EXECUTE FUNCTION app.assert_signature_revision_chain();


-- ---------------------------------------------------------------------------
-- A signer is 'signed' only with a validated signature over every document
--
-- This is the guard that makes the original defect unrepeatable. Verified
-- identity evidence remains necessary — app.enforce_bankid_terminal_evidence
-- still applies — but it is no longer sufficient.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_signer_signature_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  policy jsonb;
  required_level text;
  intent uuid;
  missing_count bigint;
BEGIN
  IF NEW.status::text <> 'signed' OR OLD.status::text = 'signed' THEN RETURN NEW; END IF;

  SELECT c.decision_mode::text, c.policy_snapshot INTO mode, policy
  FROM app.signature_cases c
  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.signature_case_id;

  -- Digital approval is a different instrument with its own evidence model,
  -- guarded by app.assert_case_completion_evidence. It is deliberately not
  -- held to the cryptographic bar, and must never be presented as if it were.
  IF mode IS DISTINCT FROM 'ELECTRONIC_SIGNATURE' THEN RETURN NEW; END IF;

  required_level := coalesce(policy->>'requiredPadesLevel', 'B');

  SELECT si.id INTO intent
  FROM app.signing_intents si
  WHERE si.tenant_id = NEW.tenant_id AND si.signer_id = NEW.id
    AND si.status IN ('verified', 'packaged')
  ORDER BY si.created_at DESC
  LIMIT 1;

  IF intent IS NULL THEN
    RAISE EXCEPTION 'signed signer requires a verified signing intent';
  END IF;

  -- Every document the signer consented to must carry its own validated
  -- signature. Checking only the latest document would let a multi-document
  -- intent complete with one document signed and the rest merely approved.
  SELECT count(*) INTO missing_count
  FROM app.signing_intent_documents sid
  WHERE sid.tenant_id = NEW.tenant_id
    AND sid.signing_intent_id = intent
    AND NOT EXISTS (
      SELECT 1
      FROM app.signature_attempts attempt
      JOIN app.signature_artifacts artifact
        ON artifact.tenant_id = attempt.tenant_id AND artifact.signature_attempt_id = attempt.id
      JOIN app.validation_runs run
        ON run.tenant_id = artifact.tenant_id AND run.signature_artifact_id = artifact.id
      WHERE attempt.tenant_id = NEW.tenant_id
        AND attempt.signer_id = NEW.id
        AND attempt.document_version_id = sid.document_version_id
        AND attempt.status = 'validated'
        AND app.pades_level_rank(artifact.format) >= app.pades_level_rank(required_level)
        AND (
          run.indication = 'TOTAL_PASSED'
          OR (
            run.indication = 'INDETERMINATE'
            AND coalesce(policy->'allowedValidationResults', '["TOTAL_PASSED"]'::jsonb) ? 'INDETERMINATE'
          )
        )
    );

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'signed signer requires a validated cryptographic signature for every document in the signing intent';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER signers_signature_evidence
BEFORE UPDATE OF status ON app.signers
FOR EACH ROW EXECUTE FUNCTION app.assert_signer_signature_evidence();


-- ---------------------------------------------------------------------------
-- Case completion: every required signer against every document
--
-- The previous version checked only the latest version of each document, and did
-- not check the attained level against the policy. Both gaps let a case complete
-- with less evidence than its own policy demanded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_case_completion_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  missing_count bigint;
  required_level text;
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
    RETURN NEW;
  END IF;

  required_level := coalesce(NEW.policy_snapshot->>'requiredPadesLevel', 'B');

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
        AND app.pades_level_rank(artifact.format) >= app.pades_level_rank(required_level)
        AND (
          vr.indication = 'TOTAL_PASSED'
          OR (
            vr.indication = 'INDETERMINATE'
            AND coalesce(NEW.policy_snapshot->'allowedValidationResults', '["TOTAL_PASSED"]'::jsonb) ? 'INDETERMINATE'
          )
        )
    );
  IF missing_count > 0 THEN RAISE EXCEPTION 'electronic signature completion lacks validated cryptographic evidence'; END IF;
  RETURN NEW;
END $$;

CREATE INDEX signature_artifacts_attempt_idx ON app.signature_artifacts(tenant_id, signature_attempt_id);
CREATE INDEX signature_attempts_signer_document_idx ON app.signature_attempts(tenant_id, signer_id, document_version_id, status);
CREATE INDEX signing_intent_documents_version_idx ON app.signing_intent_documents(tenant_id, document_version_id);
