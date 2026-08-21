-- Purpose: Give protected personal data a place to live, so requirement 2028 can be enforced instead of described.
-- Impact: Adds app.signers.protection_level and app.protected_identity_assessments, with RLS FORCE and guards on the assessment.
-- Backfill: Existing signers are stamped 'NONE', which is what they were treated as. No disclosure that was allowed before becomes allowed now.
-- Rollback: Drop the table and the column in a maintenance window. Every signer reverts to unprotected, so do this only if the feature is being withdrawn.
-- Verification: tests/sql/protected-identity.sql covers the level, the assessment guards and the tenant boundary.

-- ---------------------------------------------------------------------------
-- Skatteverket's three levels, kept apart
--
-- Treating protection as a boolean is exactly how a protected person's address
-- ends up in a notification: the three levels protect different things.
-- Sekretessmarkering is a flag that calls for a menprövning before anything is
-- disclosed. Skyddad folkbokföring means the address is never disclosed at all,
-- while the name remains, so a signature stays provable. Fingerade
-- personuppgifter means the former identity is not resolvable on any channel.
--
-- The level lives on the signer rather than on a person: Kommunsign has no
-- population register and must not pretend to. The tenant states it when they
-- add the signer, because they are the ones who hold that knowledge.
-- ---------------------------------------------------------------------------

ALTER TABLE app.signers
  ADD COLUMN IF NOT EXISTS protection_level text NOT NULL DEFAULT 'NONE';

ALTER TABLE app.signers DROP CONSTRAINT IF EXISTS signers_protection_level_check;
ALTER TABLE app.signers
  ADD CONSTRAINT signers_protection_level_check
  CHECK (protection_level IN ('NONE', 'SEKRETESSMARKERING', 'SKYDDAD_FOLKBOKFORING', 'FINGERADE_PERSONUPPGIFTER'));

-- ---------------------------------------------------------------------------
-- Menprövning: a decision, not a checkbox
--
-- Disclosing a field about someone with sekretessmarkering requires a
-- confidentiality assessment under OSL. The value of recording it is that it
-- names who decided, on what ground, and until when — an assessment with no
-- ground is not an assessment, and one with no expiry is a standing permission,
-- which is the thing this is supposed to replace.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.protected_identity_assessments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signer_id uuid NOT NULL,
  assessed_by uuid NOT NULL,
  ground text NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),
  FOREIGN KEY (tenant_id, assessed_by) REFERENCES app.users(tenant_id, id),
  CONSTRAINT protected_assessment_has_ground CHECK (length(btrim(ground)) >= 10),
  CONSTRAINT protected_assessment_expires_after_it_starts CHECK (expires_at > assessed_at),
  -- Twelve hours. An assessment that outlives the handling it was made for is a
  -- standing permission wearing a decision's clothes.
  CONSTRAINT protected_assessment_is_time_limited CHECK (expires_at <= assessed_at + interval '12 hours')
);

CREATE INDEX IF NOT EXISTS protected_identity_assessments_signer_idx
  ON app.protected_identity_assessments (tenant_id, signer_id, expires_at DESC);

ALTER TABLE app.protected_identity_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.protected_identity_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS protected_identity_assessments_tenant_isolation ON app.protected_identity_assessments;
CREATE POLICY protected_identity_assessments_tenant_isolation ON app.protected_identity_assessments
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- An assessment is a record of a decision that was taken. Editing one after the
-- fact would make the record worthless as evidence of what was decided and
-- when; revoking it is a separate act and the only field that may change.
CREATE OR REPLACE FUNCTION app.protect_identity_assessment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a confidentiality assessment may not be deleted';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.signer_id IS DISTINCT FROM OLD.signer_id
     OR NEW.assessed_by IS DISTINCT FROM OLD.assessed_by
     OR NEW.ground IS DISTINCT FROM OLD.ground
     OR NEW.assessed_at IS DISTINCT FROM OLD.assessed_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a confidentiality assessment is immutable; revoke it instead';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protected_identity_assessments_immutable ON app.protected_identity_assessments;
CREATE TRIGGER protected_identity_assessments_immutable
BEFORE UPDATE OR DELETE ON app.protected_identity_assessments
FOR EACH ROW EXECUTE FUNCTION app.protect_identity_assessment();

-- Someone with fingerade personuppgifter has a new identity precisely so the
-- old one cannot be reached. There is no menprövning that unlocks that, so the
-- database refuses to record one rather than leaving the question to whoever
-- writes the next query.
CREATE OR REPLACE FUNCTION app.assert_assessment_is_permissible() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE level text;
BEGIN
  SELECT s.protection_level INTO level
  FROM app.signers s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.signer_id;
  IF level = 'FINGERADE_PERSONUPPGIFTER' THEN
    RAISE EXCEPTION 'fingerade personuppgifter cannot be disclosed by assessment';
  END IF;
  IF level IS NULL OR level = 'NONE' THEN
    RAISE EXCEPTION 'a confidentiality assessment requires a protected signer';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protected_identity_assessments_permissible ON app.protected_identity_assessments;
CREATE TRIGGER protected_identity_assessments_permissible
BEFORE INSERT ON app.protected_identity_assessments
FOR EACH ROW EXECUTE FUNCTION app.assert_assessment_is_permissible();
