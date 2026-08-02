\set ON_ERROR_STOP on
BEGIN;
INSERT INTO app.organizations (tenant_id, id, legal_name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Tenant A'),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Tenant B');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kommunsign_rls_test') THEN
    CREATE ROLE kommunsign_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA app TO kommunsign_rls_test;
GRANT SELECT ON app.organizations TO kommunsign_rls_test;
SET LOCAL ROLE kommunsign_rls_test;
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM app.organizations) <> 1 THEN
    RAISE EXCEPTION 'RLS tenant isolation failed for tenant A';
  END IF;
END $$;
SELECT set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM app.organizations) <> 1 THEN
    RAISE EXCEPTION 'RLS tenant isolation failed for tenant B';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
