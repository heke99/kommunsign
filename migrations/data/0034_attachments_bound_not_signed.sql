-- Purpose: Let an attachment be bound into a signature without having to be signed itself, which is what F011 asks for and the guards refused.
-- Impact: Adds document_role to app.signing_intent_documents and narrows app.assert_signer_signature_evidence to rows whose role is signable.
-- Backfill: Existing rows are stamped 'signable', which is what they were treated as. No case changes meaning, and no completed case becomes invalid.
-- Rollback: Drop the column and restore the function body from migrations/data/0021 in a maintenance window. Attachments would then require signatures again.
-- Verification: tests/sql/pades-signature-chain.sql completes a case whose intent carries an attachment that nobody signed, and still refuses one whose signable document is unsigned.

-- ---------------------------------------------------------------------------
-- The role existed; it just had no consequence
--
-- app.documents.document_role has separated 'signable' from 'attachment' since
-- data/0018. But the send path puts every document in the case into the signing
-- intent, and app.assert_signer_signature_evidence requires a validated
-- signature for every row in that intent. So an attachment was signed like
-- anything else, and the distinction the schema drew was invisible in practice.
--
-- Being in the intent is exactly right: that is what binds the attachment to
-- the signature by digest, so swapping it afterwards is detectable. What was
-- wrong is that binding and signing were the same set. They are now two, and
-- the role is snapshotted onto the intent row rather than read from
-- app.documents at check time, because the question the guard asks is what the
-- signer consented to — and a document reclassified after the intent was
-- created must not change the answer.
-- ---------------------------------------------------------------------------

ALTER TABLE app.signing_intent_documents
  ADD COLUMN IF NOT EXISTS document_role text NOT NULL DEFAULT 'signable';

ALTER TABLE app.signing_intent_documents DROP CONSTRAINT IF EXISTS signing_intent_documents_role_check;
ALTER TABLE app.signing_intent_documents
  ADD CONSTRAINT signing_intent_documents_role_check
  CHECK (document_role IN ('signable', 'attachment'));

CREATE OR REPLACE FUNCTION app.assert_signer_signature_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  policy jsonb;
  required_level text;
  intent uuid;
  missing_count bigint;
  signable_count bigint;
BEGIN
  IF NEW.status::text <> 'signed' OR OLD.status::text = 'signed' THEN RETURN NEW; END IF;

  SELECT c.decision_mode::text, c.policy_snapshot INTO mode, policy
  FROM app.signature_cases c
  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.signature_case_id;

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

  -- An intent made entirely of attachments would otherwise pass this guard
  -- without a single signature, which is a signed signer who signed nothing.
  SELECT count(*) INTO signable_count
  FROM app.signing_intent_documents sid
  WHERE sid.tenant_id = NEW.tenant_id AND sid.signing_intent_id = intent
    AND sid.document_role = 'signable';

  IF signable_count = 0 THEN
    RAISE EXCEPTION 'signed signer requires at least one signable document in the signing intent';
  END IF;

  -- Every signable document the signer consented to must carry its own
  -- validated signature. Attachments are bound by their digest in the intent
  -- and deliberately not signed: the signer approved the decision in the light
  -- of them, so a later swap must be detectable, but they are not the
  -- instrument being executed.
  SELECT count(*) INTO missing_count
  FROM app.signing_intent_documents sid
  WHERE sid.tenant_id = NEW.tenant_id
    AND sid.signing_intent_id = intent
    AND sid.document_role = 'signable'
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
    RAISE EXCEPTION 'signed signer requires a validated cryptographic signature for every signable document in the signing intent';
  END IF;

  RETURN NEW;
END $$;
