-- Verification for data/0018_document_attachments.sql.
-- Each SELECT must return a single row with ok = true.

-- F010 and F011 are the same table with different roles.
SELECT 'documents carry an explicit role' AS check, (
  pg_get_constraintdef(oid) LIKE '%signable%' AND pg_get_constraintdef(oid) LIKE '%attachment%'
) AS ok
FROM pg_constraint
WHERE conname = 'documents_document_role_check';

-- A nullable role would mean "unknown", and unknown would have to be treated as
-- signable anyway. Existing rows predate attachments and are signable.
SELECT 'role is not null and defaults to signable' AS check, (
  is_nullable = 'NO' AND column_default LIKE '%signable%'
) AS ok
FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'documents' AND column_name = 'document_role';

-- The bundle material is built from the ordering, so an unstable order would
-- change the material without anything actually changing.
SELECT 'case documents have a deterministic order index' AS check, count(*) = 1 AS ok
FROM pg_indexes
WHERE schemaname = 'app' AND indexname = 'documents_case_ordinal';

-- Without a recorded bundle there is nothing to compare against, and an
-- attachment swapped after the signer looked would leave no trace.
SELECT 'signing intents record the bundle they were created over' AS check, count(*) = 1 AS ok
FROM information_schema.tables
WHERE table_schema = 'app' AND table_name = 'signing_intent_bundles';

SELECT 'bundle material is non-empty and digested' AS check, count(*) = 2 AS ok
FROM pg_constraint
WHERE conrelid = 'app.signing_intent_bundles'::regclass AND contype = 'c';

SELECT 'bundle table forces row level security' AS check, (relrowsecurity AND relforcerowsecurity) AS ok
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relname = 'signing_intent_bundles';
