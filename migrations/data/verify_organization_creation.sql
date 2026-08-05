\set ON_ERROR_STOP on

DO $$
DECLARE
  required_column text;
BEGIN
  IF to_regclass('app.durable_jobs') IS NULL THEN
    RAISE EXCEPTION 'DATABASE_SCHEMA_OUTDATED: app.durable_jobs is missing';
  END IF;

  FOREACH required_column IN ARRAY ARRAY[
    'tenant_id','id','job_type','payload','idempotency_key','status',
    'available_at','maximum_attempts','updated_at'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'app'
         AND table_name = 'durable_jobs'
         AND column_name = required_column
    ) THEN
      RAISE EXCEPTION 'DATABASE_SCHEMA_OUTDATED: app.durable_jobs.% is missing', required_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app'
       AND c.relname = 'durable_jobs'
       AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, job_type, idempotency_key)%'
  ) THEN
    RAISE EXCEPTION 'DATABASE_SCHEMA_OUTDATED: durable job idempotency index is missing';
  END IF;
END
$$;

SELECT 'organization_creation_queue_runtime_ok' AS verification;
