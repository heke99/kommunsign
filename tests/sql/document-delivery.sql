\set ON_ERROR_STOP on
-- Proves the controls on the link that carries a finished document out of the
-- system. The risk is a bearer credential that outlives its purpose: forwarded
-- once, a permanent object URL stays valid forever and leaves no trace of who
-- used it.

BEGIN;

SELECT set_config('app.actor_kind', 'internal_user', true);
SELECT set_config('app.tenant_id', '17171717-1717-4171-8171-171717171717', true);

\set tenant '''17171717-1717-4171-8171-171717171717'''
\set officer '''17171717-1111-4171-8171-171717171717'''
\set policyid '''17171717-2222-4171-8171-171717171717'''
\set opencase '''17171717-3333-4171-8171-171717171717'''
\set donecase '''17171717-4444-4171-8171-171717171717'''
\set grantid '''17171717-5555-4171-8171-171717171717'''
\set hash32 '''\\xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'''
\set hash32b '''\\xbbccddeeff00112233445566778899aabbccddeeff00112233445566778899aa'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '17171717-0000-4171-8171-171717171717', 'Kungalvs kommun');
INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :officer, 'handlaggare', 'Handlaggare');
INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'Godkannande', 'DIGITAL_APPROVAL', '{}'::jsonb, true, :officer);
INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :opencase, :officer, 'Pagaende', 'DIGITAL_APPROVAL', :policyid, 1, '{}'::jsonb, 'in_progress');

-- ===========================================================================
-- 1. A link may only exist for a case that actually completed.
--    Handing out a link to a half-signed document discloses something that is
--    not yet a decision.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.document_download_grants (tenant_id, signature_case_id, artifact, token_hash, expires_at, issued_by)
    VALUES ('17171717-1717-4171-8171-171717171717', '17171717-3333-4171-8171-171717171717', 'SIGNED_DOCUMENT',
            '\xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'::bytea,
            now() + interval '7 days', '17171717-1111-4171-8171-171717171717');
    RAISE EXCEPTION 'GUARD FAILED: a download link was issued for a case that has not completed';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'DOWNLOAD_GRANT_CASE_NOT_COMPLETED%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- A case whose evidence is finished. That -- not the status string -- is the
-- precondition for a link, because the finished package is what makes the link
-- meaningful, and it stays true after the case is archived, where a status
-- check would start refusing links for exactly the documents people come back
-- for.
INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :donecase, :officer, 'Klart beslut', 'DIGITAL_APPROVAL', :policyid, 1, '{}'::jsonb, 'draft');
INSERT INTO app.evidence_packages (tenant_id, signature_case_id, object_key, manifest_sha256, status, package_sha256, ready_at)
VALUES (:tenant, :donecase, 'tenant/cases/done/evidence.zip',
        '3333333333333333333333333333333333333333333333333333333333333333', 'ready',
        '4444444444444444444444444444444444444444444444444444444444444444', now());

-- ===========================================================================
-- 1b. A case cannot be created already completed.
--     Every completion guard was BEFORE UPDATE OF status, so a case inserted
--     with status='completed' met none of them -- no signers, no evidence, no
--     signature chain. Migration 0028 closes that; this is the check that it
--     stays closed.
-- ===========================================================================
DO $$ BEGIN
  SET LOCAL app.actor_kind = 'trusted_service';
  BEGIN
    INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status, completed_at)
    VALUES ('17171717-1717-4171-8171-171717171717', '17171717-8888-4171-8171-171717171717',
            '17171717-1111-4171-8171-171717171717', 'Fodd klar', 'DIGITAL_APPROVAL',
            '17171717-2222-4171-8171-171717171717', 1, '{}'::jsonb, 'completed', now());
    RAISE EXCEPTION 'GUARD FAILED: a case was created already completed, bypassing every completion guard';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'case cannot be created already completed%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
  SET LOCAL app.actor_kind = 'internal_user';
END $$;

-- ===========================================================================
-- 2. The credential is a full hash, and a link always expires.
--    A grant with no end date is a permanent object URL with extra steps.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.document_download_grants (tenant_id, signature_case_id, artifact, token_hash, expires_at, issued_by)
    VALUES ('17171717-1717-4171-8171-171717171717', '17171717-4444-4171-8171-171717171717', 'SIGNED_DOCUMENT',
            '\xaabb'::bytea, now() + interval '7 days', '17171717-1111-4171-8171-171717171717');
    RAISE EXCEPTION 'GUARD FAILED: a truncated token hash was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%token_hash%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO app.document_download_grants (tenant_id, signature_case_id, artifact, token_hash, expires_at, created_at, issued_by)
    VALUES ('17171717-1717-4171-8171-171717171717', '17171717-4444-4171-8171-171717171717', 'SIGNED_DOCUMENT',
            '\xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'::bytea,
            now() - interval '1 second', now(), '17171717-1111-4171-8171-171717171717');
    RAISE EXCEPTION 'GUARD FAILED: a link was issued that had already expired';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%expiry_is_bounded%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

INSERT INTO app.document_download_grants (tenant_id, id, signature_case_id, artifact, token_hash, expires_at, maximum_uses, issued_by)
VALUES (:tenant, :grantid, :donecase, 'SIGNED_DOCUMENT', :hash32::bytea, now() + interval '7 days', 2, :officer);

-- ===========================================================================
-- 3. The use ceiling is a ceiling, and the count only moves forward.
--    A limit that can be reset is advisory, not a limit.
-- ===========================================================================
UPDATE app.document_download_grants SET use_count = use_count + 1 WHERE tenant_id=:tenant AND id=:grantid;
UPDATE app.document_download_grants SET use_count = use_count + 1 WHERE tenant_id=:tenant AND id=:grantid;

DO $$ BEGIN
  BEGIN
    UPDATE app.document_download_grants SET use_count = use_count + 1
     WHERE tenant_id='17171717-1717-4171-8171-171717171717' AND id='17171717-5555-4171-8171-171717171717';
    RAISE EXCEPTION 'GUARD FAILED: a spent download link was used again';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%uses_within_limit%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE app.document_download_grants SET use_count = 0
     WHERE tenant_id='17171717-1717-4171-8171-171717171717' AND id='17171717-5555-4171-8171-171717171717';
    RAISE EXCEPTION 'GUARD FAILED: the use count was rewound to refill a spent link';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'DOWNLOAD_GRANT_USE_COUNT_REWOUND%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE app.document_download_grants SET maximum_uses = 50
     WHERE tenant_id='17171717-1717-4171-8171-171717171717' AND id='17171717-5555-4171-8171-171717171717';
    RAISE EXCEPTION 'GUARD FAILED: the ceiling was raised on a live link';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'DOWNLOAD_GRANT_LIMIT_IMMUTABLE%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE app.document_download_grants SET expires_at = now() + interval '365 days'
     WHERE tenant_id='17171717-1717-4171-8171-171717171717' AND id='17171717-5555-4171-8171-171717171717';
    RAISE EXCEPTION 'GUARD FAILED: a link was extended after issue';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'DOWNLOAD_GRANT_EXPIRY_IMMUTABLE%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

-- ===========================================================================
-- 4. Revocation is one way. Un-revoking would reopen a link somebody closed,
--    usually because it had leaked.
-- ===========================================================================
INSERT INTO app.document_download_grants (tenant_id, id, signature_case_id, artifact, token_hash, expires_at, issued_by)
VALUES (:tenant, '17171717-6666-4171-8171-171717171717', :donecase, 'EVIDENCE_PACKAGE', :hash32b::bytea, now() + interval '1 day', :officer);

UPDATE app.document_download_grants SET revoked_at=now(), revoked_by=:officer
 WHERE tenant_id=:tenant AND id='17171717-6666-4171-8171-171717171717';

DO $$ BEGIN
  BEGIN
    UPDATE app.document_download_grants SET revoked_at=NULL, revoked_by=NULL
     WHERE tenant_id='17171717-1717-4171-8171-171717171717' AND id='17171717-6666-4171-8171-171717171717';
    RAISE EXCEPTION 'GUARD FAILED: a revoked link was reopened';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'DOWNLOAD_GRANT_REVOCATION_IS_FINAL%' THEN RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM; END IF;
  END;
END $$;

-- ===========================================================================
-- 5. Two links cannot share a token, and each use leaves a trail that cannot
--    be rewritten afterwards.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.document_download_grants (tenant_id, signature_case_id, artifact, token_hash, expires_at, issued_by)
    VALUES ('17171717-1717-4171-8171-171717171717', '17171717-4444-4171-8171-171717171717', 'VALIDATION_REPORT',
            '\xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'::bytea,
            now() + interval '1 day', '17171717-1111-4171-8171-171717171717');
    RAISE EXCEPTION 'GUARD FAILED: two links shared one token';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO app.document_download_events (tenant_id, grant_id, client_network, user_agent_family)
VALUES (:tenant, :grantid, '192.0.2.0/24', 'firefox');

DO $$ BEGIN
  BEGIN
    UPDATE app.document_download_events SET client_network='10.0.0.0/24'
     WHERE tenant_id='17171717-1717-4171-8171-171717171717';
    RAISE EXCEPTION 'GUARD FAILED: an access record was rewritten after the fact';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%immutable%' AND SQLERRM NOT LIKE '%evidence%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

SELECT 'document delivery guards: OK' AS result;

ROLLBACK;
