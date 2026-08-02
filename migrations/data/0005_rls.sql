-- Purpose: deny cross-tenant reads/writes at the database boundary.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE table_record record;
BEGIN
  FOR table_record IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname IN ('app','audit')
      AND tablename NOT IN ('schema_migrations')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', table_record.schemaname, table_record.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', table_record.schemaname, table_record.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      table_record.schemaname,
      table_record.tablename
    );
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA app, audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app, audit FROM PUBLIC;
