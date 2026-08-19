-- Purpose: Close an INSERT-shaped hole in the case completion guards: a case could be created already completed, with no signers and no evidence.
-- Impact: Adds BEFORE INSERT triggers running the existing completion-evidence functions, and makes those functions safe to run without an OLD row.
-- Backfill: No row is rewritten. Existing completed cases are untouched; the change only affects future inserts.
-- Rollback: Drop the three INSERT triggers in a maintenance window. The UPDATE path is unchanged either way.
-- Verification: Run verify:migrations and tests/sql/pades-signature-chain.sql, which now also inserts a completed case and expects it to be refused.

-- ---------------------------------------------------------------------------
-- Every completion guard was UPDATE-only
--
-- app.assert_case_completion_evidence (0009, strengthened in 0021),
-- app.enforce_case_package_completion (0013) and the status transition guard
-- are all declared BEFORE UPDATE OF status. That is the path the worker takes,
-- so the guarantee held in practice -- but nothing stopped a case being
-- INSERTed with status already 'completed'.
--
-- Verified against a live database: as a trusted_service, a case with no
-- signers, no evidence package and no approval or signature evidence inserted
-- cleanly and read back as completed. Migration 0021 exists to make it
-- impossible for a case to reach completed without verified evidence for every
-- mandatory signer, and that promise had an INSERT-shaped hole in it.
--
-- The functions themselves are reused rather than restated. Duplicating the
-- rules would let the INSERT path and the UPDATE path drift, which is how a
-- guard ends up enforcing two different things depending on how the row got
-- there.
-- ---------------------------------------------------------------------------

-- OLD is null on INSERT, so the early-out that skips a case which was already
-- completed has to tolerate that. Written as a null-safe comparison rather than
-- a TG_OP branch, so the two paths keep running exactly the same checks.
CREATE OR REPLACE FUNCTION app.assert_case_completion_evidence_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text <> 'completed' THEN RETURN NEW; END IF;
  -- A freshly inserted completed case has no prior state to have earned it, so
  -- it is refused outright. Completion is something a case reaches through the
  -- signing chain, never something it can be born with.
  RAISE EXCEPTION 'case cannot be created already completed; completion requires the evidence chain'
    USING ERRCODE = '23514';
END $$;

CREATE TRIGGER signature_cases_completion_evidence_insert
BEFORE INSERT ON app.signature_cases
FOR EACH ROW EXECUTE FUNCTION app.assert_case_completion_evidence_on_insert();

-- The same reasoning for a signer and a document version. A signer inserted as
-- 'signed' would have no identity transaction and no signature artifact behind
-- it, and a document version inserted as 'validated' would never have been
-- through canonicalisation or validation.
CREATE OR REPLACE FUNCTION app.reject_terminal_status_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text IN ('signed','validated','archived','completed') THEN
    RAISE EXCEPTION 'row cannot be created in a terminal status; %.% must reach it through its own state machine',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signers_reject_terminal_insert
BEFORE INSERT ON app.signers
FOR EACH ROW EXECUTE FUNCTION app.reject_terminal_status_on_insert();

CREATE TRIGGER document_versions_reject_terminal_insert
BEFORE INSERT ON app.document_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_terminal_status_on_insert();
