\set ON_ERROR_STOP on
-- Proves the controls on key rotation. The failure this guards against is
-- specific and silent: retiring a key while some row still decrypts with it.
-- Nothing breaks at the time. It breaks when somebody needs that row, which is
-- usually years later and usually because a court asked.

BEGIN;

SELECT set_config('app.actor_kind', 'internal_user', true);
SELECT set_config('app.tenant_id', '19191919-1919-4191-8191-191919191919', true);

\set tenant '''19191919-1919-4191-8191-191919191919'''
\set operator '''19191919-1111-4191-8191-191919191919'''
\set rotation '''19191919-2222-4191-8191-191919191919'''
\set second '''19191919-3333-4191-8191-191919191919'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '19191919-0000-4191-8191-191919191919', 'Kungalvs kommun');
INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :operator, 'sakerhetsansvarig', 'Sakerhetsansvarig');

-- ===========================================================================
-- 1. Every ciphertext records which key wrote it.
--    Without this a rotation is a hopeful bulk update: no way to resume one
--    that was interrupted, and no way to know whether retiring the old key
--    will make some row permanently unreadable.
-- ===========================================================================
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(DISTINCT holder.table_name, ', ') INTO missing
    FROM information_schema.columns holder
   WHERE holder.table_schema = 'app'
     AND (holder.column_name LIKE '%\_ciphertext' OR holder.column_name LIKE '%\_blind_index')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns marker
        WHERE marker.table_schema = 'app'
          AND marker.table_name = holder.table_name
          AND marker.column_name = 'key_version'
     );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD FAILED: these tables hold ciphertext with no key version: %', missing;
  END IF;
END $$;

-- ===========================================================================
-- 2. A rotation moves forward, and only one runs per purpose at a time.
--    Two overlapping rotations would each believe they knew the target
--    version, leaving rows split across three keys with no record of which.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.key_rotations (tenant_id, purpose, state, from_version, to_version, reason, requested_by)
    VALUES ('19191919-1919-4191-8191-191919191919', 'signer.identifier', 'PLANNED', 3, 2, 'SCHEDULED',
            '19191919-1111-4191-8191-191919191919');
    RAISE EXCEPTION 'GUARD FAILED: a rotation was recorded that moves backwards';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%moves_forward%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

INSERT INTO app.key_rotations (tenant_id, id, purpose, state, from_version, to_version, reason, requested_by)
VALUES (:tenant, :rotation, 'signer.identifier', 'PLANNED', 1, 2, 'CONFIRMED_EXPOSURE', :operator);

DO $$ BEGIN
  BEGIN
    INSERT INTO app.key_rotations (tenant_id, id, purpose, state, from_version, to_version, reason, requested_by)
    VALUES ('19191919-1919-4191-8191-191919191919', '19191919-3333-4191-8191-191919191919',
            'signer.identifier', 'PLANNED', 1, 3, 'SCHEDULED', '19191919-1111-4191-8191-191919191919');
    RAISE EXCEPTION 'GUARD FAILED: two rotations ran against the same purpose at once';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ===========================================================================
-- 3. The state machine cannot be skipped. Dual-read exists so that rows
--    written under either key stay readable while the re-encryption runs.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.key_rotations SET state='REENCRYPTING'
     WHERE tenant_id='19191919-1919-4191-8191-191919191919' AND id='19191919-2222-4191-8191-191919191919';
    RAISE EXCEPTION 'GUARD FAILED: re-encryption started before dual read was in place';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'KEY_ROTATION_TRANSITION_INVALID%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

UPDATE app.key_rotations SET state='DUAL_READ' WHERE tenant_id=:tenant AND id=:rotation;
UPDATE app.key_rotations SET state='REENCRYPTING' WHERE tenant_id=:tenant AND id=:rotation;

-- ===========================================================================
-- 4. A rotation cannot be called verified while rows still hold the old key.
--    This is the check that stops the silent failure.
-- ===========================================================================
INSERT INTO app.key_rotation_columns (tenant_id, key_rotation_id, table_name, column_name, rows_total, rows_reencrypted)
VALUES (:tenant, :rotation, 'signers', 'verified_identifier_ciphertext', 1000, 400),
       (:tenant, :rotation, 'signers', 'email_ciphertext', 1000, 1000);

DO $$ BEGIN
  BEGIN
    UPDATE app.key_rotations SET state='VERIFIED'
     WHERE tenant_id='19191919-1919-4191-8191-191919191919' AND id='19191919-2222-4191-8191-191919191919';
    RAISE EXCEPTION 'GUARD FAILED: a rotation was verified with 600 rows still on the old key';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'KEY_ROTATION_INCOMPLETE%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

-- ===========================================================================
-- 5. Progress only moves forward. A counter that can be rewound makes the
--    completeness check above mean nothing.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.key_rotation_columns SET rows_reencrypted = 100
     WHERE tenant_id='19191919-1919-4191-8191-191919191919'
       AND key_rotation_id='19191919-2222-4191-8191-191919191919'
       AND column_name='verified_identifier_ciphertext';
    RAISE EXCEPTION 'GUARD FAILED: rotation progress was rewound';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'KEY_ROTATION_PROGRESS_REWOUND%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE app.key_rotation_columns SET rows_reencrypted = 5000
     WHERE tenant_id='19191919-1919-4191-8191-191919191919'
       AND key_rotation_id='19191919-2222-4191-8191-191919191919'
       AND column_name='verified_identifier_ciphertext';
    RAISE EXCEPTION 'GUARD FAILED: more rows were reported re-encrypted than exist';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%within_total%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

-- With every row re-encrypted, verification is allowed and the rotation can
-- complete.
UPDATE app.key_rotation_columns SET rows_reencrypted = 1000
 WHERE tenant_id=:tenant AND key_rotation_id=:rotation AND column_name='verified_identifier_ciphertext';
UPDATE app.key_rotations SET state='VERIFIED' WHERE tenant_id=:tenant AND id=:rotation;
UPDATE app.key_rotations SET state='COMPLETED', completed_at=now() WHERE tenant_id=:tenant AND id=:rotation;

-- ===========================================================================
-- 6. A rotation that recorded no columns verified nothing. Treating that as
--    success is how a rotation reports itself finished without running.
-- ===========================================================================
INSERT INTO app.key_rotations (tenant_id, id, purpose, state, from_version, to_version, reason, requested_by)
VALUES (:tenant, :second, 'user.email', 'PLANNED', 1, 2, 'SCHEDULED', :operator);
UPDATE app.key_rotations SET state='DUAL_READ' WHERE tenant_id=:tenant AND id=:second;
UPDATE app.key_rotations SET state='REENCRYPTING' WHERE tenant_id=:tenant AND id=:second;

DO $$ BEGIN
  BEGIN
    UPDATE app.key_rotations SET state='VERIFIED'
     WHERE tenant_id='19191919-1919-4191-8191-191919191919' AND id='19191919-3333-4191-8191-191919191919';
    RAISE EXCEPTION 'GUARD FAILED: a rotation with no recorded columns reported itself verified';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'KEY_ROTATION_NOTHING_VERIFIED%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

-- ===========================================================================
-- 7. A rollback must say why. "It was rolled back" with no reason is not a
--    record anybody can act on six months later.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.key_rotations SET state='ROLLED_BACK', rolled_back_reason='  '
     WHERE tenant_id='19191919-1919-4191-8191-191919191919' AND id='19191919-3333-4191-8191-191919191919';
    RAISE EXCEPTION 'GUARD FAILED: a rotation was rolled back with no stated reason';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%rollback_has_reason%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

UPDATE app.key_rotations SET state='ROLLED_BACK', rolled_back_reason='Ny nyckel kunde inte laddas i HSM'
 WHERE tenant_id=:tenant AND id=:second;

-- ===========================================================================
-- 8. A row written while the session names a key version must carry it.
--
--    The column defaulted to 1 and nothing set it, so after activating version
--    2 every new row still claimed the old key — and the question the column
--    exists to answer, "what is left to re-encrypt", could never reach zero.
-- ===========================================================================
SELECT set_config('app.key_version', '2', true);
INSERT INTO app.users (tenant_id, id, external_subject, display_name, email_ciphertext)
VALUES (:tenant, '19191919-8888-4191-8191-191919191919', 'rotated-subject', 'Rotated', '\x01'::bytea);

DO $$ BEGIN
  IF (SELECT key_version FROM app.users
       WHERE tenant_id='19191919-1919-4191-8191-191919191919'
         AND id='19191919-8888-4191-8191-191919191919') <> 2 THEN
    RAISE EXCEPTION 'GUARD FAILED: a row written under key version 2 did not record it';
  END IF;
END $$;

-- A session that names no version is writing under version 1, which is what
-- the column already defaults to. Refusing the write would be worse than
-- recording the version that is actually in use.
SELECT set_config('app.key_version', '', true);
INSERT INTO app.users (tenant_id, id, external_subject, display_name, email_ciphertext)
VALUES (:tenant, '19191919-9999-4191-8191-191919191919', 'unversioned-subject', 'Unversioned', '\x01'::bytea);

DO $$ BEGIN
  IF (SELECT key_version FROM app.users
       WHERE tenant_id='19191919-1919-4191-8191-191919191919'
         AND id='19191919-9999-4191-8191-191919191919') <> 1 THEN
    RAISE EXCEPTION 'GUARD FAILED: a session with no key version must write version 1';
  END IF;
END $$;

SELECT 'key rotation guards: OK' AS result;

ROLLBACK;
