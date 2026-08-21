-- Purpose: Make key_version tell the truth. It defaulted to 1 on every insert, so after a rotation new rows claimed the old key.
-- Impact: Adds app.stamp_key_version() and a BEFORE INSERT trigger on every table carrying key_version. No column is added or changed.
-- Backfill: None. Existing rows were written under version 1 and correctly say so; the trigger only affects rows inserted from now on.
-- Rollback: Drop the triggers and the function in a maintenance window. Rows keep whatever version they were stamped with, which stays correct.
-- Verification: tests/sql/key-rotation.sql inserts under a session key version and expects the row to carry it.

-- ---------------------------------------------------------------------------
-- A column that always said 1
--
-- data/0029 added key_version to every table holding a ciphertext or a blind
-- index, so a rotation could answer the only question that matters while it
-- runs: which rows are still on the old key. The column defaulted to 1 and
-- nothing ever set it, so after activating version 2 the answer was always
-- "all of them", including the rows just written under version 2.
--
-- That is worse than no answer. app.assert_key_rotation_complete refuses to
-- mark a rotation verified while a column reports outstanding rows, so the
-- operator sees a count that never reaches zero — or, having re-encrypted
-- everything and stamped it by hand, a count that reaches zero while new
-- writes keep landing mislabelled behind them.
--
-- Stamped by a trigger rather than by each INSERT because there are dozens of
-- write paths across the API and the workers, and the failure mode of
-- forgetting one is silent. The value comes from the same per-transaction
-- settings withTenantTransaction already establishes for tenant and actor.
-- An explicit value in the INSERT still wins: re-encryption sets the column
-- directly, and that is an UPDATE, which this trigger does not touch.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.stamp_key_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- coalesce, not a required setting: a session that never set one is writing
  -- under version 1, which is what the column already defaults to. Failing
  -- closed here would take down every insert from any path that does not go
  -- through withTenantTransaction, and refusing to write is not safer than
  -- writing the version that is actually in use.
  NEW.key_version := coalesce(nullif(current_setting('app.key_version', true), '')::integer, 1);
  RETURN NEW;
END $$;

DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT table_name
      FROM information_schema.columns
     WHERE table_schema = 'app' AND column_name = 'key_version'
     ORDER BY table_name
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON app.%I',
      target.table_name || '_stamp_key_version', target.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_key_version()',
      target.table_name || '_stamp_key_version', target.table_name);
  END LOOP;
END $$;
