-- Verification for control/0017_workforce_federation.sql.
-- Each SELECT must return a single row with ok = true.

-- Generic protocol keys are accepted, so an IdP other than Entra can be configured.
SELECT 'generic provider keys permitted' AS check, (
  pg_get_constraintdef(oid) LIKE '%GENERIC_OIDC%'
  AND pg_get_constraintdef(oid) LIKE '%GENERIC_SAML%'
) AS ok
FROM pg_constraint
WHERE conname = 'tenant_identity_providers_provider_key_check';

-- The previously valid vendor keys still pass, so applying this migration
-- cannot invalidate a row that is currently authenticating users.
SELECT 'existing entra keys still permitted' AS check, (
  pg_get_constraintdef(oid) LIKE '%ENTRA_OIDC%'
  AND pg_get_constraintdef(oid) LIKE '%ENTRA_SAML%'
) AS ok
FROM pg_constraint
WHERE conname = 'tenant_identity_providers_provider_key_check';

SELECT 'role mapping table exists' AS check, count(*) = 1 AS ok
FROM information_schema.tables
WHERE table_schema = 'control' AND table_name = 'tenant_federation_role_mappings';

-- The composite foreign key is what stops a mapping from surviving the removal
-- of the provider it belongs to.
SELECT 'role mapping is bound to its provider row' AS check, count(*) = 1 AS ok
FROM information_schema.table_constraints
WHERE table_schema = 'control'
  AND table_name = 'tenant_federation_role_mappings'
  AND constraint_type = 'FOREIGN KEY'
  AND constraint_name LIKE '%provider%';

-- The primary key is the single-use guarantee: two concurrent replays of the
-- same assertion cannot both insert.
SELECT 'assertion ledger is single-use per tenant' AS check, (
  array_agg(a.attname ORDER BY a.attname) = ARRAY['assertion_id','tenant_id']
) AS ok
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
WHERE n.nspname = 'control' AND c.relname = 'federation_assertion_ledger' AND i.indisprimary;
