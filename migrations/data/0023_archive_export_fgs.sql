-- Purpose: Record what an archive export actually produced, so an FGS claim can be checked rather than trusted.
-- Impact: Adds package and descriptor columns to app.archive_exports plus a guard that a completed export must name its artifacts.
-- Backfill: No business data is rewritten. Existing rows keep NULL descriptor columns; none can be 'completed' without them going forward.
-- Rollback: Drop the trigger and the added columns in a maintenance window after rolling back the ARCHIVE_EXPORT worker.
-- Verification: Run verify:migrations and tests/sql/archive-export.sql.

-- ---------------------------------------------------------------------------
-- An export that cannot be identified cannot be audited
--
-- app.archive_exports recorded only a status and an optional external reference.
-- That is enough to say an export happened and nothing about what left the
-- system. For a preservation package the identity of the delivered bytes is the
-- whole point: a municipality asked later "what did you send the archive" needs
-- an answer stronger than a row saying 'completed'.
-- ---------------------------------------------------------------------------
ALTER TABLE app.archive_exports
  ADD COLUMN package_object_key text,
  ADD COLUMN package_sha256 text CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN descriptor_object_key text,
  ADD COLUMN descriptor_sha256 text CHECK (descriptor_sha256 IS NULL OR descriptor_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN specification text,
  ADD COLUMN profile_uri text,
  -- Deliberately separate from "we produced an FGS-shaped package". Structure
  -- following the published profile and validation against the XSD set the
  -- receiving archive mandates are different claims, and only the first is
  -- something this system can establish on its own.
  ADD COLUMN schema_validated boolean NOT NULL DEFAULT false,
  ADD COLUMN failure_code text;

COMMENT ON COLUMN app.archive_exports.schema_validated IS
  'True only when the package was validated against the receiving archive''s FGS schema set. Structural conformance to the published profile is not the same claim.';

CREATE OR REPLACE FUNCTION app.assert_archive_export_completeness() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF NEW.package_object_key IS NULL OR NEW.package_sha256 IS NULL
       OR NEW.descriptor_object_key IS NULL OR NEW.descriptor_sha256 IS NULL
       OR NEW.specification IS NULL OR NEW.profile_uri IS NULL THEN
      RAISE EXCEPTION 'a completed archive export must record its package, descriptor and specification';
    END IF;
    IF NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'a completed archive export must record when it completed';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER archive_exports_completeness
BEFORE UPDATE ON app.archive_exports
FOR EACH ROW EXECUTE FUNCTION app.assert_archive_export_completeness();

-- One export per case per profile version. A second row for the same case would
-- leave two answers to "what was delivered" with nothing to choose between them.
CREATE UNIQUE INDEX archive_exports_case_profile_idx
  ON app.archive_exports(tenant_id, signature_case_id, archive_profile_version);
