-- Purpose: Deliver a completed document through an authenticated, time-limited link instead of a permanent object URL or an unprotected email attachment.
-- Impact: Adds app.document_download_grants with expiry, revocation, use limits and an access trail.
-- Backfill: None; the table is new and starts empty. Existing API downloads are unaffected.
-- Rollback: Drop the table in a maintenance window after removing the public download route.
-- Verification: Run verify:migrations and tests/sql/document-delivery.sql.

-- ---------------------------------------------------------------------------
-- A finished document needs a way out that is neither of the two easy options
--
-- A permanent object URL is a bearer credential with no expiry, no revocation
-- and no record of who used it; forwarded once it stays valid forever. An email
-- attachment puts the signed original in every mail server between here and the
-- recipient, and in their mailbox backups afterwards.
--
-- This is the third option: a grant that names exactly one artifact of exactly
-- one case, expires, can be revoked, counts its uses, and leaves a trail of
-- each one. The token is stored only as a hash, the same as every other
-- credential in this schema.
-- ---------------------------------------------------------------------------
CREATE TABLE app.document_download_grants (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  -- Which artifact this grant is for. A grant for the signed document must not
  -- also open the evidence package: they have different audiences.
  artifact text NOT NULL CHECK (artifact IN ('SIGNED_DOCUMENT','VALIDATION_REPORT','EVIDENCE_PACKAGE')),
  -- Who it was issued to, when that is a signer on the case. Null for a grant
  -- issued to a case administrator.
  signer_id uuid,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),

  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  -- A finished document is normally fetched once or twice. A ceiling turns a
  -- leaked link from an open door into a door that closes on its own.
  maximum_uses integer NOT NULL DEFAULT 5 CHECK (maximum_uses BETWEEN 1 AND 50),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),

  issued_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES app.signers(tenant_id, id),

  CONSTRAINT document_download_grants_uses_within_limit CHECK (use_count <= maximum_uses),
  -- A grant that never expires is a permanent object URL with extra steps.
  CONSTRAINT document_download_grants_expiry_is_bounded CHECK (expires_at > created_at)
);
ALTER TABLE app.document_download_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_download_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.document_download_grants
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.document_download_grants FROM PUBLIC;

-- The lookup is by token hash across tenants, because the hash is what
-- establishes which tenant the grant belongs to.
CREATE INDEX document_download_grants_token
  ON app.document_download_grants(token_hash)
  WHERE revoked_at IS NULL;

-- Each use, recorded. Without this a leaked link is indistinguishable from a
-- recipient opening their own document twice.
CREATE TABLE app.document_download_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  -- Truncated to a /24 or /48 before it gets here. A full client address is
  -- personal data being retained for a purpose nobody stated.
  client_network text,
  user_agent_family text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, grant_id) REFERENCES app.document_download_grants(tenant_id, id)
);
ALTER TABLE app.document_download_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_download_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.document_download_events
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.document_download_events FROM PUBLIC;

CREATE TRIGGER document_download_events_append_only
BEFORE UPDATE OR DELETE ON app.document_download_events
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- A grant may only be issued against a case whose evidence is finished.
--
-- The condition is the ready evidence package rather than the status string,
-- and that is deliberate: the package existing is what makes the link
-- meaningful, it is the same fact app.enforce_case_package_completion requires
-- before a case may be called completed, and it stays true after the case is
-- archived — where a status check would start refusing links for cases whose
-- documents are exactly the ones people come back for.
--
-- Handing out a link to a half-signed document would disclose something that is
-- not yet a decision.
CREATE OR REPLACE FUNCTION app.assert_download_grant_case_completed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE case_status text;
BEGIN
  SELECT status::text INTO case_status FROM app.signature_cases
   WHERE tenant_id = NEW.tenant_id AND id = NEW.signature_case_id;
  IF case_status IS NULL THEN
    RAISE EXCEPTION 'DOWNLOAD_GRANT_CASE_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.evidence_packages package
     WHERE package.tenant_id = NEW.tenant_id
       AND package.signature_case_id = NEW.signature_case_id
       AND package.signer_id IS NULL
       AND package.status = 'ready'
       AND package.package_sha256 IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'DOWNLOAD_GRANT_CASE_NOT_COMPLETED: case % has no finished evidence package', case_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_download_grants_case_completed
BEFORE INSERT ON app.document_download_grants
FOR EACH ROW EXECUTE FUNCTION app.assert_download_grant_case_completed();

-- The use count only ever moves forward, and only within the ceiling. Allowing
-- it to be reset would make the limit advisory.
CREATE OR REPLACE FUNCTION app.assert_download_grant_use_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.use_count < OLD.use_count THEN
    RAISE EXCEPTION 'DOWNLOAD_GRANT_USE_COUNT_REWOUND' USING ERRCODE = '23514';
  END IF;
  IF NEW.maximum_uses <> OLD.maximum_uses THEN
    RAISE EXCEPTION 'DOWNLOAD_GRANT_LIMIT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'DOWNLOAD_GRANT_EXPIRY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  -- Revocation is one-way. Un-revoking would reopen a link somebody
  -- deliberately closed, usually because it had leaked.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'DOWNLOAD_GRANT_REVOCATION_IS_FINAL' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_download_grants_use_monotonic
BEFORE UPDATE ON app.document_download_grants
FOR EACH ROW EXECUTE FUNCTION app.assert_download_grant_use_monotonic();
