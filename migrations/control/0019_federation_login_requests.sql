-- Purpose: Remember the login requests we started, so a federated assertion can be required to answer one of them.
-- Impact: Adds control.federation_login_requests with single-use consumption, expiry and the binding the ACS must match.
-- Backfill: None; the table is new and starts empty.
-- Rollback: Drop the table in a maintenance window after removing the federation router.
-- Verification: Run the control migration suite and tests/sql/federation-replay.sql.

-- ---------------------------------------------------------------------------
-- An assertion must answer a request we started
--
-- verifyWorkforceAssertion already refuses an assertion whose InResponseTo (or
-- OIDC state) does not match the binding it was given, and refuses one with no
-- InResponseTo at all — IdP-initiated flows are rejected because a stolen
-- assertion could otherwise be posted at any time. That check is only worth
-- anything if the binding comes from somewhere durable. Held in process memory
-- it would be lost on restart and unknown to every other instance, so a login
-- would fail on whichever pod did not start it.
--
-- The row is also the single-use record: consuming it is what stops the same
-- request id being answered twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control.federation_login_requests (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 16 AND 256),
  provider_key text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production')),
  -- The ACS or redirect URI this login was started against. Compared exactly:
  -- an assertion captured at a different endpoint must not be usable at ours.
  redirect_uri text NOT NULL CHECK (redirect_uri LIKE 'https://%'),
  -- Where to send the user afterwards. Stored rather than carried in the
  -- request, because a return URL the caller supplies at the ACS is an open
  -- redirect with extra steps.
  return_path text NOT NULL DEFAULT '/' CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, provider_key, environment)
    REFERENCES control.tenant_identity_providers (tenant_id, provider_key, environment)
    ON DELETE CASCADE,
  CONSTRAINT federation_login_requests_expiry_bounded CHECK (expires_at > created_at)
);

-- The lookup at the ACS is by request id alone, because the request id is what
-- establishes which tenant started the login.
CREATE UNIQUE INDEX IF NOT EXISTS federation_login_requests_by_id
  ON control.federation_login_requests(request_id);

CREATE INDEX IF NOT EXISTS federation_login_requests_expiry
  ON control.federation_login_requests(expires_at) WHERE consumed_at IS NULL;

-- Consumption is one way. Un-consuming would let one assertion be replayed
-- against the same request, which is the protection the ledger and this table
-- exist to provide between them.
CREATE OR REPLACE FUNCTION control.assert_login_request_consumption_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'FEDERATION_LOGIN_REQUEST_ALREADY_CONSUMED' USING ERRCODE = '23514';
  END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.redirect_uri <> OLD.redirect_uri
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'FEDERATION_LOGIN_REQUEST_IS_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER federation_login_requests_consumption_final
BEFORE UPDATE ON control.federation_login_requests
FOR EACH ROW EXECUTE FUNCTION control.assert_login_request_consumption_final();
