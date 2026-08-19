-- Purpose: Let a SCIM provisioning credential actually be issued, by removing the requirement for a secret-manager reference no deployment has.
-- Impact: Makes app.scim_provisioning_clients.token_secret_reference nullable and keeps its format check for deployments that do use a secret manager.
-- Backfill: No row is rewritten. Existing clients keep whatever reference they carry.
-- Rollback: Re-add the NOT NULL after populating the column, in a maintenance window.
-- Verification: Run verify:migrations and tests/sql/scim-provisioning.sql.

-- ---------------------------------------------------------------------------
-- A credential nobody can issue
--
-- The column was NOT NULL with a `vault://` format check, so issuing a SCIM
-- token required a secret manager that no deployment of this system has. The
-- result was a table that could not be written to, which is why no issuance
-- path existed.
--
-- This is the same shape of problem the webhook secret had before migration
-- 0022, but the fix is different, and deliberately so. A webhook secret must be
-- recoverable to sign with, so it is stored encrypted. A SCIM token never needs
-- to be recovered — only *verified* — so token_hash is the whole requirement
-- and the plaintext should not be retained anywhere. The token is generated at
-- creation, returned exactly once, and thereafter exists only as its hash.
--
-- The reference column stays, and keeps its format check when populated: it is
-- how a deployment that does run a secret manager records where the operator's
-- copy lives.
-- ---------------------------------------------------------------------------
ALTER TABLE app.scim_provisioning_clients
  ALTER COLUMN token_secret_reference DROP NOT NULL;

COMMENT ON COLUMN app.scim_provisioning_clients.token_secret_reference IS
  'Where an operator-held copy of the token lives, when a secret manager is in use. Null is normal: the token is returned once at creation and kept only as token_hash.';

-- The hash is the credential. Anything shorter than a full SHA-256 digest would
-- mean the lookup was matching on something else.
ALTER TABLE app.scim_provisioning_clients
  DROP CONSTRAINT IF EXISTS scim_clients_token_hash_length;
ALTER TABLE app.scim_provisioning_clients
  ADD CONSTRAINT scim_clients_token_hash_length CHECK (octet_length(token_hash) = 32);

-- Authentication looks the client up by hash across tenants, because the hash
-- is what establishes which tenant it belongs to.
CREATE INDEX IF NOT EXISTS scim_provisioning_clients_token_lookup
  ON app.scim_provisioning_clients(token_hash) WHERE enabled;
