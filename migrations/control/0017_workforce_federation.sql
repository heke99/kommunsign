-- Purpose: Allow any SAML 2.0 or OIDC workforce IdP to be configured per tenant,
--          and store the assertion replay ledger and group-to-role mapping that
--          packages/federation depends on.
--
--          Kungälv requirement 2079 asks for SAML 2.0 *or* OIDC, and F004 asks for
--          login through the municipality's own IdP. The existing provider_key
--          CHECK only allowed ENTRA_OIDC and ENTRA_SAML, which encoded one vendor
--          into the schema. MobilityGuard — what Kungälv actually runs today — could
--          not be configured at all. This replaces the vendor list with generic
--          protocol keys so onboarding a different IdP is a configuration row.
--
-- Impact:  control.tenant_identity_providers gains two permitted provider_key
--          values. Existing rows keep their current keys and are not rewritten.
--          Two new tables. No existing column is dropped or retyped, so this is
--          additive and safe to apply while the service is running.
--
-- Backfill: None required. Existing ENTRA_OIDC and ENTRA_SAML rows remain valid
--          and continue to work; they may be migrated to the generic keys later
--          per tenant, which is why both spellings stay permitted.
--
-- Rollback: The CHECK constraint can be narrowed again once no row uses the new
--          keys. The two new tables can be dropped; nothing outside
--          packages/federation reads them.
--
-- Verification: migrations/control/verify_workforce_federation.sql

BEGIN;

-- Expand-and-contract: the old vendor-specific keys stay valid so that applying
-- this migration cannot invalidate a row that is currently authenticating users.
ALTER TABLE control.tenant_identity_providers
  DROP CONSTRAINT IF EXISTS tenant_identity_providers_provider_key_check;

ALTER TABLE control.tenant_identity_providers
  ADD CONSTRAINT tenant_identity_providers_provider_key_check
  CHECK (provider_key IN (
    'GENERIC_OIDC', 'GENERIC_SAML',
    'ENTRA_OIDC', 'ENTRA_SAML',
    'SWEDEN_CONNECT', 'TIC_BANKID', 'FREJA_DIRECT'
  ));

-- The mapping that decides which Kommunsign role an IdP group grants.
-- Deliberately a table rather than a JSON blob on the provider row: each grant
-- is then individually auditable, and a role can be revoked without rewriting
-- the whole mapping.
CREATE TABLE IF NOT EXISTS control.tenant_federation_role_mappings (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  provider_key text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production')),
  -- The IdP's own group value, verbatim. Compared exactly, never normalised,
  -- because case folding a distinguished name can collide two distinct groups.
  group_value text NOT NULL CHECK (length(group_value) BETWEEN 1 AND 512),
  role_key text NOT NULL CHECK (role_key <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (tenant_id, provider_key, environment, group_value),
  FOREIGN KEY (tenant_id, provider_key, environment)
    REFERENCES control.tenant_identity_providers (tenant_id, provider_key, environment)
    ON DELETE CASCADE
);

-- Federation is a tenant-scoped decision, so the lookup is tenant-scoped too.
CREATE INDEX IF NOT EXISTS tenant_federation_role_mappings_lookup
  ON control.tenant_federation_role_mappings (tenant_id, provider_key, environment);

-- Consumed assertion IDs. Without this an assertion is accepted every time it
-- is presented inside its validity window, which is the standard SAML replay.
-- The row is the consumption: the primary key is what makes it single-use, so
-- two concurrent replays cannot both win.
CREATE TABLE IF NOT EXISTS control.federation_assertion_ledger (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  assertion_id text NOT NULL CHECK (length(assertion_id) BETWEEN 1 AND 512),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  -- Kept so the ledger can be pruned once every assertion in a window has
  -- expired. Pruning earlier than this would reopen the replay window.
  not_on_or_after timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, assertion_id)
);

CREATE INDEX IF NOT EXISTS federation_assertion_ledger_expiry
  ON control.federation_assertion_ledger (not_on_or_after);

COMMIT;
