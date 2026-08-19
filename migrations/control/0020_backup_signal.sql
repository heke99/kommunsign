-- Purpose: Hold the latest reported backup completion, so the backup timestamp series has a value to render.
-- Impact: Adds control.backup_completions, keyed by scope, with a future-timestamp check and a monotonic trigger.
-- Backfill: None; the table is new and starts empty. An empty table renders no sample, which is what BackupFailed alerts on.
-- Rollback: Drop the table in a maintenance window after removing the ingest route; the series then has no source again.
-- Verification: Run the control migration suite and tests/sql/backup-signal.sql.

-- Where a completed backup is recorded.
--
-- Backups are taken by the hosting platform, not by this application, so the
-- application cannot observe one happening. What it can do is accept a report
-- and hold the latest one, which is the difference between an alert rule that
-- watches a series nobody produces and one that watches a real timestamp.
--
-- BackupFailed alerts on the *absence* of a recent value. That is what makes an
-- unfed series indistinguishable from a healthy one to anyone who has not
-- checked, and it is why the two constraints below matter more than they look:
-- a report from the future would silence the alert indefinitely, and a report
-- that moves the timestamp backwards would let a replayed message undo a fresh
-- backup.

CREATE TABLE control.backup_completions (
  scope             text PRIMARY KEY
                    CHECK (scope ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  completed_at      timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  reported_by       text NOT NULL
                    CHECK (length(reported_by) BETWEEN 1 AND 200),
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A backup cannot have completed after now. Clock skew between the platform
  -- and this database is real, so a small allowance, but not an open one.
  CONSTRAINT backup_completions_not_in_the_future
    CHECK (completed_at <= recorded_at + interval '5 minutes')
);

REVOKE ALL ON TABLE control.backup_completions FROM PUBLIC;

-- The timestamp only ever moves forward.
--
-- Enforced here rather than in the application because the guarantee is worth
-- exactly as much as the weakest writer, and a second writer will eventually
-- exist: an operator running the report by hand to test it, a retried delivery,
-- a second region.
CREATE OR REPLACE FUNCTION control.backup_completion_moves_forward()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.completed_at < OLD.completed_at THEN
    RAISE EXCEPTION 'backup completion may not move backwards for scope %', OLD.scope
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER backup_completions_monotonic
  BEFORE UPDATE ON control.backup_completions
  FOR EACH ROW
  EXECUTE FUNCTION control.backup_completion_moves_forward();
