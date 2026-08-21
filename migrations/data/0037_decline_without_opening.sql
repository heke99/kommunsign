-- Purpose: Let an invited signer decline without opening the document first, which the API already permits and the database refused.
-- Impact: Replaces app.assert_valid_status_transition, adding 'declined' to the transitions allowed from signers.status = 'invited'. No other transition changes.
-- Backfill: Nothing to backfill. No existing row is in a state this changes.
-- Rollback: Re-apply the function body from migrations/data/0009 in a maintenance window. No data depends on the difference.
-- Verification: tests/sql/signing-turn.sql declines straight from 'invited' and expects it to be accepted.

-- ---------------------------------------------------------------------------
-- The endpoint and the table disagreed, and the table won
--
-- `decline` in public-signing-repository.ts accepts a refusal from a signer in
-- 'invited', 'opened' or 'identity_started'. The transition table allowed
-- 'declined' only from 'opened' and later. A signer who followed their
-- invitation link and refused without first opening the document therefore hit
-- a trigger exception, which rolled back the whole transaction: the invitation
-- was not consumed, the case was not closed, and the portal showed a generic
-- failure.
--
-- Refusing to sign something without reading it first is a legitimate act — it
-- is in fact the clearest kind of refusal — so the fix is to allow the
-- transition rather than to narrow the endpoint. The rest of the table is
-- reproduced unchanged; the function is replaced whole because that is how
-- CREATE OR REPLACE works, not because anything else moved.
-- ---------------------------------------------------------------------------

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
      -- 'pending' still cannot decline: that signer has not been invited, so
      -- there is nobody to have refused.
      WHEN 'pending' THEN ARRAY['invited','cancelled']
      WHEN 'invited' THEN ARRAY['opened','identity_started','declined','expired','cancelled','failed']
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
