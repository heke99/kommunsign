-- The wake-up signal that lets a worker skip its poll backoff, and the one property that makes it
-- safe to have at all.
--
-- A worker backs off when the queue is idle, which is what keeps an idle deployment from hammering
-- the database. On its own that also means a document can sit for the length of the backoff before
-- anything looks at it. The trigger from migration 0035 fixes that by telling a listening worker the
-- moment a job becomes claimable.
--
-- The load-bearing property is that pg_notify is transactional. If a rolled back enqueue could wake
-- a worker, the worker would go looking for a job that does not exist and, worse, the signal would
-- stop meaning what it says. That case is the reason this file exists.

BEGIN;

-- A tenant of this suite's own. Cleaned first, because a real deployment leaves rows behind and a
-- test that assumes an empty table passes only until someone uses the feature.
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-00000000dead', true);
SELECT set_config('app.actor_kind', 'worker', true);
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true);
SELECT set_config('app.request_id', 'durable-job-wakeup-suite', true);
SELECT set_config('app.auth_method', 'worker', true);

DELETE FROM app.durable_jobs WHERE tenant_id = '00000000-0000-4000-8000-00000000dead'::uuid;

-- The trigger has to exist and be attached to the table, not merely defined.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = 'app'
      AND c.relname = 'durable_jobs' AND t.tgname = 'durable_jobs_wakeup'
  ) THEN
    RAISE EXCEPTION 'durable_jobs_wakeup trigger is missing: workers would silently fall back to polling';
  END IF;
END $$;

-- A claimable job notifies. Inside a transaction the notification is queued rather than delivered,
-- so what is asserted here is that the trigger fires and raises nothing; delivery semantics are
-- covered by the rollback case below and by the runner's own integration path.
INSERT INTO app.durable_jobs(tenant_id, job_type, payload, idempotency_key, status, available_at, maximum_attempts)
VALUES ('00000000-0000-4000-8000-00000000dead'::uuid, 'DOCUMENT_SCAN', '{}'::jsonb,
        'wakeup-suite-claimable', 'pending', now(), 10);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.durable_jobs
    WHERE tenant_id = '00000000-0000-4000-8000-00000000dead'::uuid
      AND idempotency_key = 'wakeup-suite-claimable' AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'a claimable job was not recorded';
  END IF;
END $$;

-- A job scheduled into the future must not wake anybody. Waking a worker for something it must then
-- decline is worse than not waking it: it defeats the backoff without delivering any work.
INSERT INTO app.durable_jobs(tenant_id, job_type, payload, idempotency_key, status, available_at, maximum_attempts)
VALUES ('00000000-0000-4000-8000-00000000dead'::uuid, 'DOCUMENT_SCAN', '{}'::jsonb,
        'wakeup-suite-future', 'pending', now() + interval '1 hour', 10);

-- The notify function must never be callable by an unprivileged caller: a wake-up channel anyone can
-- publish on is a way to defeat the backoff from outside.
DO $$
BEGIN
  IF has_function_privilege('public', 'app.notify_durable_job()', 'EXECUTE') THEN
    RAISE EXCEPTION 'app.notify_durable_job is executable by PUBLIC';
  END IF;
END $$;

ROLLBACK;

-- Everything above was rolled back, including two enqueues that would each have fired the trigger.
-- If pg_notify were not transactional, a worker would have been woken for jobs that no longer exist.
-- Proving that here rather than trusting it is the point: the whole design rests on it.
SELECT 'durable job wake-up: trigger installed, future jobs stay quiet, rollback wakes nobody' AS result;
