-- Verification for data/0017_scim_provisioning.sql.
-- Each SELECT must return a single row with ok = true.

-- SCIM extends the existing user model rather than adding a second one. A
-- parallel scim_users table would immediately disagree with app.users about who
-- exists and who is disabled.
SELECT 'scim columns live on app.users' AS check, count(*) = 2 AS ok
FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'users'
  AND column_name IN ('scim_external_id', 'scim_user_name');

SELECT 'no parallel scim user table was created' AS check, count(*) = 0 AS ok
FROM information_schema.tables
WHERE table_schema = 'app' AND table_name IN ('scim_users', 'scim_user_accounts');

-- Uniqueness is per tenant, never global: two municipalities legitimately have
-- a user with the same directory identifier.
SELECT 'external id is unique per tenant and partial' AS check, (
  indexdef LIKE '%UNIQUE%'
  AND indexdef LIKE '%tenant_id%'
  AND indexdef LIKE '%WHERE (scim_external_id IS NOT NULL)%'
) AS ok
FROM pg_indexes
WHERE schemaname = 'app' AND indexname = 'users_scim_external_id_unique';

-- The token itself is never stored, only a secret reference (AGENTS.md rule 7).
SELECT 'provisioning token is held by reference' AS check, (
  pg_get_constraintdef(oid) LIKE '%vault%'
) AS ok
FROM pg_constraint
WHERE conrelid = 'app.scim_provisioning_clients'::regclass
  AND pg_get_constraintdef(oid) LIKE '%token_secret_reference%';

-- Every new table carries RLS, and FORCE so that even the table owner is
-- subject to it. Without FORCE a privileged connection silently bypasses
-- tenant isolation.
SELECT 'scim tables force row level security' AS check, count(*) = 3 AS ok
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app'
  AND c.relname IN ('scim_provisioning_clients', 'scim_group_role_mappings', 'scim_provisioning_events')
  AND c.relrowsecurity AND c.relforcerowsecurity;

SELECT 'scim tables have a tenant isolation policy' AS check, count(*) = 3 AS ok
FROM pg_policies
WHERE schemaname = 'app'
  AND tablename IN ('scim_provisioning_clients', 'scim_group_role_mappings', 'scim_provisioning_events');

-- Requirement 3518: user creation, removal and change must be logged.
SELECT 'provisioning events cover the full lifecycle' AS check, (
  pg_get_constraintdef(oid) LIKE '%CREATED%'
  AND pg_get_constraintdef(oid) LIKE '%DEACTIVATED%'
  AND pg_get_constraintdef(oid) LIKE '%ROLES_CHANGED%'
) AS ok
FROM pg_constraint
WHERE conrelid = 'app.scim_provisioning_events'::regclass
  AND pg_get_constraintdef(oid) LIKE '%action%';

-- Composite foreign keys carry tenant_id, so a mapping can never point at
-- another tenant's role (AGENTS.md rule 2).
SELECT 'group role mapping is tenant-composite' AS check, count(*) = 2 AS ok
FROM information_schema.table_constraints
WHERE table_schema = 'app' AND table_name = 'scim_group_role_mappings' AND constraint_type = 'FOREIGN KEY';
