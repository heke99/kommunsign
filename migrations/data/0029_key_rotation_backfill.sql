-- Purpose: Make key rotation an operation that can be run, tracked and verified, instead of a library with nothing to drive it.
-- Impact: Adds app.key_rotations and app.key_rotation_columns, plus a key_version column on every table holding ciphertext or a blind index.
-- Backfill: Existing rows are stamped key_version=1, which is what they were encrypted under. No ciphertext is read or rewritten by this migration.
-- Rollback: Drop the two tables and the added columns in a maintenance window. No existing column is altered, so ciphertext is unaffected either way.
-- Verification: Run verify:migrations and tests/sql/key-rotation.sql.

-- ---------------------------------------------------------------------------
-- Rotation needs to know which rows are still on the old key
--
-- packages/crypto/src/key-rotation.ts already models the whole thing: the key
-- ring, the dual-read window, the progress accounting, and a completion check
-- that refuses to retire a key while rows still decrypt with it. What it could
-- not do is answer "which rows?", because no column recorded which key version
-- any given ciphertext was written under.
--
-- Without that, a rotation is a hopeful bulk update: there is no way to resume
-- one that was interrupted, no way to verify one finished, and no way to know
-- whether retiring the old key will make some row permanently unreadable. That
-- last one is the reason this exists — the failure is silent until someone
-- needs the data.
--
-- The rotation itself remains an operator action. This gives it a ledger.
-- ---------------------------------------------------------------------------

DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT DISTINCT table_name
      FROM information_schema.columns
     WHERE table_schema = 'app'
       AND (column_name LIKE '%\_ciphertext' OR column_name LIKE '%\_blind_index')
  LOOP
    -- Defaulted to 1 rather than left null: every existing ciphertext was
    -- written under the first key, and a null would be indistinguishable from
    -- "we do not know", which is the state this column exists to eliminate.
    EXECUTE format(
      'ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 1',
      target.table_name);
    EXECUTE format(
      'ALTER TABLE app.%I DROP CONSTRAINT IF EXISTS %I',
      target.table_name, target.table_name || '_key_version_positive');
    EXECUTE format(
      'ALTER TABLE app.%I ADD CONSTRAINT %I CHECK (key_version > 0)',
      target.table_name, target.table_name || '_key_version_positive');
    -- Partial index on the trailing versions, so "what is left to re-encrypt"
    -- stays cheap on tables that only grow.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON app.%I (key_version) WHERE key_version < 2147483647',
      target.table_name || '_key_version_idx', target.table_name);
  END LOOP;
END $$;

-- One row per rotation, following the state machine in packages/crypto.
CREATE TABLE app.key_rotations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose <> ''),
  state text NOT NULL CHECK (state IN ('PLANNED','DUAL_READ','REENCRYPTING','VERIFIED','COMPLETED','ROLLED_BACK')),
  from_version integer NOT NULL CHECK (from_version > 0),
  to_version integer NOT NULL CHECK (to_version > 0),
  -- Why the key is being rotated. A scheduled rotation and a rotation because
  -- the key was exposed have different urgency and different evidence needs,
  -- and six months later nobody remembers which this was.
  reason text NOT NULL CHECK (reason IN ('SCHEDULED','SUSPECTED_EXPOSURE','CONFIRMED_EXPOSURE','ALGORITHM_CHANGE','OPERATOR_REQUEST')),
  requested_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_reason text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.users(tenant_id, id),
  CONSTRAINT key_rotations_moves_forward CHECK (to_version > from_version),
  CONSTRAINT key_rotations_completion_has_time CHECK (state <> 'COMPLETED' OR completed_at IS NOT NULL),
  CONSTRAINT key_rotations_rollback_has_reason
    CHECK (state <> 'ROLLED_BACK' OR (rolled_back_reason IS NOT NULL AND length(btrim(rolled_back_reason)) > 0))
);
ALTER TABLE app.key_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.key_rotations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.key_rotations
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.key_rotations FROM PUBLIC;

-- Only one rotation per purpose at a time. Two overlapping rotations would each
-- believe they knew the target version, and rows would end up split across
-- three keys with no record of which.
CREATE UNIQUE INDEX key_rotations_one_live_per_purpose
  ON app.key_rotations(tenant_id, purpose)
  WHERE state NOT IN ('COMPLETED','ROLLED_BACK');

-- Per-column progress. Resumability is the point: a rotation over a large table
-- will be interrupted, and starting again from the beginning is how a rotation
-- never finishes.
CREATE TABLE app.key_rotation_columns (
  tenant_id uuid NOT NULL,
  key_rotation_id uuid NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  rows_total bigint NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
  rows_reencrypted bigint NOT NULL DEFAULT 0 CHECK (rows_reencrypted >= 0),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_rotation_id, table_name, column_name),
  FOREIGN KEY (tenant_id, key_rotation_id) REFERENCES app.key_rotations(tenant_id, id) ON DELETE CASCADE,
  -- More re-encrypted than exist means the count is wrong, and a rotation that
  -- miscounts is a rotation that will report itself finished early.
  CONSTRAINT key_rotation_columns_within_total CHECK (rows_reencrypted <= rows_total)
);
ALTER TABLE app.key_rotation_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.key_rotation_columns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.key_rotation_columns
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.key_rotation_columns FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- The state machine from packages/crypto, restated where it cannot be skipped.
CREATE OR REPLACE FUNCTION app.assert_key_rotation_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  allowed := CASE OLD.state
    -- Rollback is reachable until the rotation is done, because the reason to
    -- roll back usually appears while re-encrypting.
    WHEN 'PLANNED'      THEN ARRAY['DUAL_READ','ROLLED_BACK']
    WHEN 'DUAL_READ'    THEN ARRAY['REENCRYPTING','ROLLED_BACK']
    WHEN 'REENCRYPTING' THEN ARRAY['VERIFIED','ROLLED_BACK']
    WHEN 'VERIFIED'     THEN ARRAY['COMPLETED','ROLLED_BACK']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.state = ANY (allowed)) THEN
    RAISE EXCEPTION 'KEY_ROTATION_TRANSITION_INVALID: % -> %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER key_rotations_transition_guard
BEFORE UPDATE ON app.key_rotations
FOR EACH ROW EXECUTE FUNCTION app.assert_key_rotation_transition();

-- A rotation may not be called verified while any column still has rows on the
-- old key. This is the check that stops the old key being retired while some
-- row still needs it — the failure that is silent until someone reads the data.
CREATE OR REPLACE FUNCTION app.assert_key_rotation_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE outstanding bigint;
BEGIN
  IF NEW.state NOT IN ('VERIFIED','COMPLETED') THEN RETURN NEW; END IF;

  SELECT coalesce(sum(rows_total - rows_reencrypted), 0) INTO outstanding
    FROM app.key_rotation_columns
   WHERE tenant_id = NEW.tenant_id AND key_rotation_id = NEW.id;

  IF outstanding > 0 THEN
    RAISE EXCEPTION 'KEY_ROTATION_INCOMPLETE: % row(s) still hold the previous key', outstanding
      USING ERRCODE = '23514';
  END IF;
  -- A rotation that recorded no columns at all verified nothing. Treating that
  -- as success is how a rotation reports itself finished without running.
  IF NOT EXISTS (SELECT 1 FROM app.key_rotation_columns
                  WHERE tenant_id = NEW.tenant_id AND key_rotation_id = NEW.id) THEN
    RAISE EXCEPTION 'KEY_ROTATION_NOTHING_VERIFIED: no columns were recorded for this rotation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER key_rotations_completeness_guard
BEFORE UPDATE OF state ON app.key_rotations
FOR EACH ROW EXECUTE FUNCTION app.assert_key_rotation_complete();

-- Progress only moves forward. A counter that can be rewound makes the
-- completeness check above meaningless.
CREATE OR REPLACE FUNCTION app.assert_key_rotation_progress_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rows_reencrypted < OLD.rows_reencrypted THEN
    RAISE EXCEPTION 'KEY_ROTATION_PROGRESS_REWOUND' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER key_rotation_columns_progress_monotonic
BEFORE UPDATE ON app.key_rotation_columns
FOR EACH ROW EXECUTE FUNCTION app.assert_key_rotation_progress_monotonic();
