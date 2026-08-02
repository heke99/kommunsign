-- Run per tenant session after migrations.
SELECT app.current_tenant_id();
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname IN ('app','audit') AND rowsecurity IS NOT TRUE;
SELECT conrelid::regclass AS table_name, conname
FROM pg_constraint
WHERE contype = 'f' AND connamespace IN ('app'::regnamespace, 'audit'::regnamespace)
  AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%';
