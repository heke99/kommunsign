-- The two ways a reported backup could lie, refused by the database.
--
-- BackupFailed alerts on the absence of a recent timestamp. That makes both of
-- these silent failures rather than loud ones: a future timestamp silences the
-- alert for as long as it stays in the future, and a backwards move lets a
-- replayed or out-of-order report undo a backup that really happened.

BEGIN;

-- Scopes of its own, and cleared first. A real deployment -- or the
-- application-chain E2E, which reports a backup against the same database --
-- leaves rows behind, and a suite that assumes an empty table passes only
-- until someone uses the feature.
DELETE FROM control.backup_completions WHERE scope LIKE 'suite-%';

-- A normal report is accepted and readable.
INSERT INTO control.backup_completions(scope, completed_at, reported_by)
VALUES ('suite-control', now() - interval '2 hours', 'platform-backup-job');

DO $$
DECLARE recorded timestamptz;
BEGIN
  SELECT completed_at INTO recorded FROM control.backup_completions WHERE scope = 'suite-control';
  IF recorded IS NULL THEN RAISE EXCEPTION 'a reported backup was not recorded'; END IF;
END $$;

-- Moving forward is the whole point, and must work.
UPDATE control.backup_completions
   SET completed_at = now() - interval '1 hour'
 WHERE scope = 'suite-control';

-- Moving backwards must not.
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    UPDATE control.backup_completions
       SET completed_at = now() - interval '10 hours'
     WHERE scope = 'suite-control';
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'a backup completion was allowed to move backwards, which lets a replay undo a fresh backup';
  END IF;
END $$;

-- A completion in the future must not be accepted at all: it would silence the
-- alert for as long as it stays ahead of the clock.
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO control.backup_completions(scope, completed_at, reported_by)
    VALUES ('suite-data', now() + interval '3 days', 'platform-backup-job');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'a backup completion in the future was accepted, which silences BackupFailed indefinitely';
  END IF;
END $$;

-- Small clock skew between the platform and this database is normal and must
-- not be treated as a lie.
INSERT INTO control.backup_completions(scope, completed_at, reported_by)
VALUES ('suite-data', now() + interval '1 minute', 'platform-backup-job');

-- The scope is a slug, not free text: it becomes a metric label.
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO control.backup_completions(scope, completed_at, reported_by)
    VALUES ('Suite Database; DROP', now(), 'platform-backup-job');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'an unbounded scope was accepted as a metric label'; END IF;
END $$;

SELECT 'backup signal guards: OK' AS result;

ROLLBACK;
