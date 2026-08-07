-- Purpose: Support attachments (Kungälv F011) by giving each document in a case
--          an explicit role, and record the document bundle that a signing intent
--          was created over so a later change is detectable.
--
--          F010 (several documents signed at once) and F011 (attachments) are the
--          same table with different roles: a signable document receives the
--          signature, an attachment is context the signer saw and which must be
--          provably unchanged, but which is not itself signed.
--
-- Impact:  One new column on app.documents with a default, one ordering column,
--          and one new table. Existing rows become 'signable', which is what they
--          have always been. No column is dropped or retyped, so this applies
--          while the service is running.
--
-- Backfill: The DEFAULT handles existing rows: everything already in app.documents
--          predates attachments and is therefore signable. document_ordinal
--          defaults to 0, which keeps the existing arbitrary ordering stable
--          rather than reshuffling live cases.
--
-- Rollback: Drop app.signing_intent_bundles and the two columns during a
--          maintenance window. Cases created before the rollback keep working;
--          only attachment support is lost.
--
-- Verification: migrations/data/verify_document_attachments.sql

BEGIN;

-- NOT NULL with a default so the column is unambiguous from the first row.
-- A nullable role would mean "unknown", and unknown would have to be treated as
-- signable anyway — better to say so.
ALTER TABLE app.documents
  ADD COLUMN IF NOT EXISTS document_role text NOT NULL DEFAULT 'signable';

ALTER TABLE app.documents DROP CONSTRAINT IF EXISTS documents_document_role_check;
ALTER TABLE app.documents
  ADD CONSTRAINT documents_document_role_check
  CHECK (document_role IN ('signable', 'attachment'));

-- Presentation order within the case. Deterministic ordering matters because
-- the bundle binding material is built from it: an unstable order would change
-- the material without anything actually changing.
ALTER TABLE app.documents
  ADD COLUMN IF NOT EXISTS document_ordinal integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS documents_case_ordinal
  ON app.documents (tenant_id, signature_case_id, document_ordinal, id);

-- What the signer was actually shown, captured when the intent was created.
--
-- Without this row there is nothing to compare against: an attachment added,
-- removed or swapped between the moment the signer looked and the moment they
-- signed would leave no trace, and attachments would become the obvious place
-- to put anything you wanted to change afterwards.
CREATE TABLE IF NOT EXISTS app.signing_intent_bundles (
  tenant_id uuid NOT NULL,
  signing_intent_id uuid NOT NULL,
  -- Ordered, role-tagged entries of the form role:version_id:sha256. Stored as
  -- an array rather than JSON so the ordering is part of the type.
  bundle_material text[] NOT NULL CHECK (cardinality(bundle_material) > 0),
  -- Digest over the whole bundle, so a single comparison answers "unchanged?".
  bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, signing_intent_id),
  FOREIGN KEY (tenant_id, signing_intent_id) REFERENCES app.signing_intents(tenant_id, id)
);

ALTER TABLE app.signing_intent_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.signing_intent_bundles FORCE ROW LEVEL SECURITY;

CREATE POLICY signing_intent_bundles_tenant_isolation ON app.signing_intent_bundles
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

COMMIT;
