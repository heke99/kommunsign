-- Purpose: repair and verify the durable queue shape required to dispatch organization provisioning jobs.
-- Impact: recreates the durable_jobs table only if absent, restores additive runtime columns, and guarantees a conflict target for idempotent queue writes.
-- Backfill: existing jobs are preserved; missing additive columns receive safe defaults.
-- Rollback: stop API and workers, drain pending jobs, then remove only the additive indexes or columns in a maintenance window.
-- Verification: run migrations/data/verify_organization_creation.sql and enqueue a disposable TENANT_PROVISION job with the platform tenant id.

BEGIN;

CREATE TABLE IF NOT EXISTS app.durable_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status app.job_status NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  maximum_attempts integer NOT NULL DEFAULT 10,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, job_type, idempotency_key)
);

ALTER TABLE app.durable_jobs
  ADD COLUMN IF NOT EXISTS maximum_attempts integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error_code text;

CREATE UNIQUE INDEX IF NOT EXISTS durable_jobs_enqueue_idempotency_idx
  ON app.durable_jobs(tenant_id, job_type, idempotency_key);

CREATE INDEX IF NOT EXISTS durable_jobs_platform_pending_idx
  ON app.durable_jobs(status, available_at, created_at)
  WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
    AND status = 'pending';

ALTER TABLE app.durable_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.durable_jobs FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'app'
       AND tablename = 'durable_jobs'
       AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE 'CREATE POLICY tenant_isolation ON app.durable_jobs USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())';
  END IF;
END
$$;

COMMIT;
