-- Purpose: let a worker be woken the moment a job becomes claimable instead of waiting out its poll backoff.
-- Impact: adds an AFTER INSERT OR UPDATE trigger on app.durable_jobs that issues pg_notify on the 'kommunsign_durable_job'
--   channel when a row is claimable now. Workers LISTEN on that channel and interrupt their sleep. No column, constraint,
--   policy or index changes, and no change to how a job is claimed -- app.claim_durable_jobs is untouched, so the notify
--   is only an optimisation of *when* a worker looks, never of *what* it is allowed to see.
--   Idle poll backoff previously meant a document could sit up to ~36 seconds before the scan job was even picked up.
-- Backfill: none; this adds a trigger and mutates no rows. Jobs already queued are picked up by the existing poll.
-- Rollback: DROP TRIGGER durable_jobs_wakeup ON app.durable_jobs; DROP FUNCTION app.notify_durable_job();
-- Verification: LISTEN kommunsign_durable_job in one session, insert a pending job in another, and observe the
--   notification. Insert inside a transaction that is then rolled back and observe that no notification arrives --
--   pg_notify is transactional, which is what makes this safe.

-- The notify is deliberately driven by a trigger rather than by the nine places that enqueue jobs. A call site that
-- forgets to notify would reintroduce the delay silently and only under load; a trigger cannot be forgotten.
CREATE OR REPLACE FUNCTION app.notify_durable_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only for work that can be claimed right now. A job scheduled into the future is left to the poll, since waking a
  -- worker for something it must then decline is worse than not waking it.
  IF NEW.status = 'pending' AND NEW.available_at <= now() THEN
    -- The payload carries the tenant so a future worker can route by it. Postgres collapses identical notifications
    -- within one transaction, so a batch insert wakes the worker once rather than once per row.
    PERFORM pg_notify('kommunsign_durable_job', NEW.tenant_id::text);
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION app.notify_durable_job() FROM PUBLIC;

CREATE TRIGGER durable_jobs_wakeup
AFTER INSERT OR UPDATE OF status, available_at ON app.durable_jobs
FOR EACH ROW EXECUTE FUNCTION app.notify_durable_job();

COMMENT ON FUNCTION app.notify_durable_job() IS
  'Wakes a listening worker when a durable job becomes claimable. Transactional: a rolled back enqueue notifies nobody.';
