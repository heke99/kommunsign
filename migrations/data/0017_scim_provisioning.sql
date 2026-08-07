-- Purpose: Add SCIM 2.0 provisioning on top of the existing identity model, for
--          Kungälv requirements 2082-2085 (automatic provisioning covering
--          creation, update, permission change and deactivation, driven from the
--          municipality's central identity source, with automatic role assignment).
--
--          Deliberately extends app.users rather than introducing a parallel
--          "scim_users" table. A second user model would immediately disagree
--          with the first about who exists and who is disabled, and every
--          signature already references app.users.
--
-- Impact:  Two nullable columns on app.users, one partial unique index, one new
--          table for provisioning clients and one for the provisioning audit.
--          No column is dropped or retyped and no existing row is rewritten, so
--          this applies while the service is running.
--
-- Backfill: None required. scim_external_id and user_name stay NULL for users
--          that were not provisioned over SCIM; the partial unique indexes
--          ignore NULLs, so existing users are unaffected. A later sync fills
--          them in as the directory claims each user.
--
-- Rollback: Drop the two new tables and the two columns during a maintenance
--          window. Nothing outside packages/scim reads them, and app.users
--          works exactly as before without them.
--
-- Verification: migrations/data/verify_scim_provisioning.sql

BEGIN;

-- The directory's own stable identifier. This is the idempotency key: without
-- it, every provisioning retry either creates a duplicate account or fails with
-- a conflict and stalls the sync.
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS scim_external_id text;

-- SCIM userName is a distinct concept from external_subject: external_subject
-- is how the IdP identifies the person at login, userName is the directory's
-- login name. They are usually equal and are not required to be.
ALTER TABLE app.users ADD COLUMN IF NOT EXISTS scim_user_name text;

ALTER TABLE app.users
  DROP CONSTRAINT IF EXISTS users_scim_external_id_format;
ALTER TABLE app.users
  ADD CONSTRAINT users_scim_external_id_format
  CHECK (scim_external_id IS NULL OR length(scim_external_id) BETWEEN 1 AND 256);

-- Uniqueness is per tenant, never global: two municipalities legitimately have
-- a user with the same directory identifier. Partial, so the many users that
-- were never provisioned over SCIM do not collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS users_scim_external_id_unique
  ON app.users (tenant_id, scim_external_id)
  WHERE scim_external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_scim_user_name_unique
  ON app.users (tenant_id, lower(scim_user_name))
  WHERE scim_user_name IS NOT NULL;

-- One provisioning credential per tenant per environment. The token itself is
-- never stored: only a secret reference (AGENTS.md rule 7) and a hash for
-- lookup.
CREATE TABLE IF NOT EXISTS app.scim_provisioning_clients (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (display_name <> ''),
  token_secret_reference text NOT NULL
    CHECK (token_secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://'),
  token_hash bytea NOT NULL,
  -- Least privilege for the provisioning credential itself. A directory admin
  -- adding someone to a group must not be able to grant a role beyond what this
  -- client was scoped for.
  assignable_roles text[] NOT NULL DEFAULT '{}'::text[],
  enabled boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash)
);

-- Directory group to Kommunsign role. A table rather than JSON so each grant is
-- individually auditable and revocable.
CREATE TABLE IF NOT EXISTS app.scim_group_role_mappings (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  group_value text NOT NULL CHECK (length(group_value) BETWEEN 1 AND 512),
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, client_id, group_value),
  FOREIGN KEY (tenant_id, client_id) REFERENCES app.scim_provisioning_clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.roles(tenant_id, id)
);

-- Requirement 3518: the authorisation system must log when a user was created,
-- removed or changed. Provisioning is the main way that happens once the
-- directory is connected, so it gets its own trail rather than relying on the
-- caller to remember to write one.
CREATE TABLE IF NOT EXISTS app.scim_provisioning_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  user_id uuid,
  action text NOT NULL CHECK (action IN ('CREATED','UPDATED','ACTIVATED','DEACTIVATED','DELETED','ROLES_CHANGED')),
  -- What changed, with values already masked by the application. Never the raw
  -- payload: it carries directory attributes we have no reason to retain.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES app.scim_provisioning_clients(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS scim_provisioning_events_user
  ON app.scim_provisioning_events (tenant_id, user_id, occurred_at DESC);

-- RLS on every new table, consistent with migrations/data/0005 and 0008. FORCE
-- so that even the table owner is subject to the policy: without it, a
-- privileged connection silently bypasses tenant isolation.
ALTER TABLE app.scim_provisioning_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scim_provisioning_clients FORCE ROW LEVEL SECURITY;
ALTER TABLE app.scim_group_role_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scim_group_role_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.scim_provisioning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scim_provisioning_events FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['scim_provisioning_clients','scim_group_role_mappings','scim_provisioning_events']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON app.%I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      target, target
    );
  END LOOP;
END $$;

COMMIT;
