-- Purpose: apply forced tenant RLS to tables introduced after the initial RLS migration.
DO $$
DECLARE table_record record;
BEGIN
  FOR table_record IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname IN ('app','audit') AND tablename NOT IN ('schema_migrations')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', table_record.schemaname, table_record.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', table_record.schemaname, table_record.tablename);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = table_record.schemaname
        AND tablename = table_record.tablename AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', table_record.schemaname, table_record.tablename);
    END IF;
  END LOOP;
END $$;
