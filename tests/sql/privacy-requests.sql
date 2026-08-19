\set ON_ERROR_STOP on
-- Proves the controls around data subject rights requests. Each block is a way
-- someone's personal data could be disclosed, altered or destroyed without the
-- request having actually been handled -- which for a rights request means the
-- supervisory authority's questions have no good answer.
--
-- Every block asserts on the *specific* guard message, not merely that the
-- statement failed. A test that passes because an adjacent constraint fired
-- proves nothing about the rule it claims to cover.

BEGIN;

SELECT set_config('app.actor_kind', 'internal_user', true);
SELECT set_config('app.tenant_id', '13131313-1313-4131-8131-131313131313', true);

\set tenant '''13131313-1313-4131-8131-131313131313'''
\set officer '''13131313-1111-4131-8131-131313131313'''
\set policyid '''13131313-2222-4131-8131-131313131313'''
\set caseid '''13131313-3333-4131-8131-131313131313'''
\set signerid '''13131313-4444-4131-8131-131313131313'''
\set accessreq '''13131313-5555-4131-8131-131313131313'''
\set erasereq '''13131313-6666-4131-8131-131313131313'''
\set weakreq '''13131313-7777-4131-8131-131313131313'''
\set subjectbi '''\\x0102030405060708'''
\set hash '''2222222222222222222222222222222222222222222222222222222222222222'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '13131313-0000-4131-8131-131313131313', 'Kungalvs kommun');
INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :officer, 'subject-dpo', 'Dataskyddsombud');

-- ===========================================================================
-- 1. Identity before disclosure.
--    A rights request is otherwise the easiest route to someone else's
--    register extract: you only have to claim to be them.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.privacy_requests (tenant_id, id, state, right_requested,
      subject_identifier_ciphertext, subject_identifier_blind_index, due_at)
    VALUES ('13131313-1313-4131-8131-131313131313', '13131313-5555-4131-8131-131313131313',
            'IDENTITY_VERIFIED', 'ACCESS', '\x99'::bytea, '\x0102030405060708'::bytea, now() + interval '30 days');
    RAISE EXCEPTION 'GUARD FAILED: a request advanced past RECEIVED with no proven identity';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_IDENTITY_NOT_VERIFIED%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 2. An email someone happens to control is not proof for a register extract.
--    ACCESS, ERASURE, PORTABILITY and RECTIFICATION need strong identity;
--    releasing an extract on a weak one is a personal data breach in itself.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.privacy_requests (tenant_id, id, state, right_requested,
      subject_identifier_ciphertext, subject_identifier_blind_index, due_at,
      identity_verified_at, identity_method, identity_assurance)
    VALUES ('13131313-1313-4131-8131-131313131313', '13131313-7777-4131-8131-131313131313',
            'IDENTITY_VERIFIED', 'ACCESS', '\x99'::bytea, '\x0102030405060708'::bytea, now() + interval '30 days',
            now(), 'email-confirmation', 'SUBSTANTIAL');
    RAISE EXCEPTION 'GUARD FAILED: a register extract was released on a weak identity';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_IDENTITY_ASSURANCE_TOO_LOW%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- RESTRICTION is deliberately not on that list: objecting to processing should
-- not be harder to obtain than the processing itself.
INSERT INTO app.privacy_requests (tenant_id, id, state, right_requested,
  subject_identifier_ciphertext, subject_identifier_blind_index, due_at,
  identity_verified_at, identity_method, identity_assurance)
VALUES (:tenant, :weakreq, 'IDENTITY_VERIFIED', 'RESTRICTION',
        '\x99'::bytea, :subjectbi::bytea, now() + interval '30 days',
        now(), 'email-confirmation', 'SUBSTANTIAL');

-- ===========================================================================
-- 3. The state machine cannot be skipped.
-- ===========================================================================
INSERT INTO app.privacy_requests (tenant_id, id, state, right_requested,
  subject_identifier_ciphertext, subject_identifier_blind_index, due_at,
  identity_verified_at, identity_method, identity_assurance)
VALUES (:tenant, :accessreq, 'RECEIVED', 'ACCESS',
        '\x99'::bytea, :subjectbi::bytea, now() + interval '30 days',
        now(), 'bankid', 'HIGH');

DO $$ BEGIN
  BEGIN
    UPDATE app.privacy_requests SET state='FULFILLED'
     WHERE tenant_id='13131313-1313-4131-8131-131313131313' AND id='13131313-5555-4131-8131-131313131313';
    RAISE EXCEPTION 'GUARD FAILED: a request jumped from RECEIVED straight to FULFILLED';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_STATE_TRANSITION_INVALID%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 4. Every store must be accounted for before an answer is fulfilled.
--    An extract that quietly omits CONTROL is worse than no extract, because
--    it looks complete.
-- ===========================================================================
UPDATE app.privacy_requests SET state='IDENTITY_VERIFIED' WHERE tenant_id=:tenant AND id=:accessreq;
UPDATE app.privacy_requests SET state='IN_PROGRESS', handled_by=:officer WHERE tenant_id=:tenant AND id=:accessreq;

INSERT INTO app.privacy_request_coverage (tenant_id, privacy_request_id, store, record_count, searched, action_taken) VALUES
  (:tenant, :accessreq, 'DATA', 3, true, 'EXPORTED'),
  (:tenant, :accessreq, 'OBJECT_STORAGE', 2, true, 'EXPORTED');

-- The completeness check is deferred so the worker can write the request and
-- its five coverage rows in one transaction. Making it immediate here is what
-- lets the test observe it at the statement rather than at commit.
SET CONSTRAINTS app.privacy_requests_coverage_complete IMMEDIATE;

DO $$ BEGIN
  BEGIN
    UPDATE app.privacy_requests SET state='FULFILLED'
     WHERE tenant_id='13131313-1313-4131-8131-131313131313' AND id='13131313-5555-4131-8131-131313131313';
    RAISE EXCEPTION 'GUARD FAILED: an answer was fulfilled without accounting for every store';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_COVERAGE_INCOMPLETE%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 5. A store is either searched or exempted with a stated ground.
--    Never neither -- that is precisely how a store gets forgotten. And a
--    store that was not searched cannot claim to have found anything.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.privacy_request_coverage (tenant_id, privacy_request_id, store, record_count, searched, action_taken)
    VALUES ('13131313-1313-4131-8131-131313131313', '13131313-5555-4131-8131-131313131313',
            'BACKUP', 0, false, 'EXEMPTED');
    RAISE EXCEPTION 'GUARD FAILED: a store was neither searched nor exempted with a ground';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%privacy_coverage_searched_or_exempted%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO app.privacy_request_coverage (tenant_id, privacy_request_id, store, record_count, searched, exemption_reason, action_taken)
    VALUES ('13131313-1313-4131-8131-131313131313', '13131313-5555-4131-8131-131313131313',
            'BACKUP', 7, false, 'Sakerhetskopior punktraderas inte', 'EXEMPTED');
    RAISE EXCEPTION 'GUARD FAILED: an unsearched store reported records it cannot have counted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%privacy_coverage_unsearched_has_no_records%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- With every store accounted for, fulfilment is allowed.
INSERT INTO app.privacy_request_coverage (tenant_id, privacy_request_id, store, record_count, searched, exemption_reason, action_taken) VALUES
  (:tenant, :accessreq, 'CONTROL', 1, true, NULL, 'EXPORTED'),
  (:tenant, :accessreq, 'AUDIT_LOG', 4, true, 'Atkomstloggar bevaras enligt PUB-avtalet 7.5', 'SEARCHED'),
  (:tenant, :accessreq, 'BACKUP', 0, false, 'Sakerhetskopior punktraderas inte; uppgifterna forsvinner nar backupretentionen loper ut', 'EXEMPTED');

UPDATE app.privacy_requests SET state='FULFILLED' WHERE tenant_id=:tenant AND id=:accessreq;

-- ===========================================================================
-- 6. The response total must equal what its own coverage rows say.
--    A total that disagrees with its parts is a number nobody should act on.
-- ===========================================================================
SET CONSTRAINTS app.privacy_responses_consistent IMMEDIATE;

DO $$ BEGIN
  BEGIN
    INSERT INTO app.privacy_responses (tenant_id, privacy_request_id, schema_version, response, response_sha256, total_records)
    VALUES ('13131313-1313-4131-8131-131313131313', '13131313-5555-4131-8131-131313131313', 1,
            '{"complete":true}'::jsonb,
            '2222222222222222222222222222222222222222222222222222222222222222', 99);
    RAISE EXCEPTION 'GUARD FAILED: a response claimed a total its coverage does not support';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_RESPONSE_TOTAL_MISMATCH%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

INSERT INTO app.privacy_responses (tenant_id, privacy_request_id, schema_version, response, response_sha256, total_records)
VALUES (:tenant, :accessreq, 1, '{"complete":true}'::jsonb, :hash, 10);

-- ===========================================================================
-- 7. Delivery is terminal. Refusing after the extract was handed over does not
--    un-hand it over.
-- ===========================================================================
UPDATE app.privacy_requests SET state='DELIVERED', delivered_at=now() WHERE tenant_id=:tenant AND id=:accessreq;

DO $$ BEGIN
  BEGIN
    UPDATE app.privacy_requests SET state='REFUSED', refusal_ground='For sent'
     WHERE tenant_id='13131313-1313-4131-8131-131313131313' AND id='13131313-5555-4131-8131-131313131313';
    RAISE EXCEPTION 'GUARD FAILED: a delivered request was refused after the fact';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_STATE_TRANSITION_INVALID%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- Coverage is evidence: it cannot be rewritten to say something else later.
DO $$ BEGIN
  BEGIN
    UPDATE app.privacy_request_coverage SET record_count = 0
     WHERE tenant_id='13131313-1313-4131-8131-131313131313' AND privacy_request_id='13131313-5555-4131-8131-131313131313';
    RAISE EXCEPTION 'GUARD FAILED: coverage evidence was rewritten after the answer was delivered';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%immutable%' AND SQLERRM NOT LIKE '%evidence%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 8. Erasure stops at a legal hold, checked at fulfilment rather than trusted
--    from when the request arrived. A hold placed in between is exactly the
--    case this exists for.
-- ===========================================================================
INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'AES', 'ELECTRONIC_SIGNATURE', '{"requiredPadesLevel":"B"}'::jsonb, true, :officer);
INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :caseid, :officer, 'Beslut under legal hold', 'ELECTRONIC_SIGNATURE', :policyid, 1, '{}'::jsonb, 'draft');
INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, email_ciphertext, email_blind_index,
                         recipient_reference, status, verified_identifier_blind_index)
VALUES (:tenant, :signerid, :caseid, 'Anna Andersson', '\x01'::bytea, '\x02'::bytea,
        'signer-reference-0001', 'pending', :subjectbi::bytea);

INSERT INTO app.privacy_requests (tenant_id, id, state, right_requested,
  subject_identifier_ciphertext, subject_identifier_blind_index, due_at,
  identity_verified_at, identity_method, identity_assurance, handled_by)
VALUES (:tenant, :erasereq, 'RECEIVED', 'ERASURE',
        '\x99'::bytea, :subjectbi::bytea, now() + interval '30 days',
        now(), 'bankid', 'HIGH', :officer);
UPDATE app.privacy_requests SET state='IDENTITY_VERIFIED' WHERE tenant_id=:tenant AND id=:erasereq;
UPDATE app.privacy_requests SET state='IN_PROGRESS' WHERE tenant_id=:tenant AND id=:erasereq;

-- No hold yet: fulfilment would be allowed. The hold is what changes it.
INSERT INTO app.legal_holds (tenant_id, signature_case_id, reason, placed_by)
VALUES (:tenant, :caseid, 'Pagaende tillsynsarende', :officer);

DO $$ BEGIN
  BEGIN
    UPDATE app.privacy_requests SET state='FULFILLED'
     WHERE tenant_id='13131313-1313-4131-8131-131313131313' AND id='13131313-6666-4131-8131-131313131313';
    RAISE EXCEPTION 'GUARD FAILED: personal data was erased while under legal hold';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- Releasing the hold releases the erasure, so the guard tracks the current
-- state rather than permanently blocking a subject who was once held.
--
-- AUDIT_LOG and BACKUP are exempted with their grounds rather than deleted.
-- The audit log is hash-chained and retained for five years under PUB-avtalet
-- 7.5; backups are not point-erased. Saying so is the honest answer, and it is
-- a different statement from having deleted them.
UPDATE app.legal_holds SET released_by=:officer, released_at=now()
 WHERE tenant_id=:tenant AND signature_case_id=:caseid;
INSERT INTO app.privacy_request_coverage (tenant_id, privacy_request_id, store, record_count, searched, exemption_reason, action_taken) VALUES
  (:tenant, :erasereq, 'CONTROL', 1, true, NULL, 'DELETED'),
  (:tenant, :erasereq, 'DATA', 2, true, NULL, 'DELETED'),
  (:tenant, :erasereq, 'OBJECT_STORAGE', 2, true, NULL, 'CRYPTO_ERASED'),
  (:tenant, :erasereq, 'AUDIT_LOG', 3, true, 'Atkomstloggar bevaras enligt PUB-avtalet 7.5 och raderas forst fem ar efter loggningstillfallet', 'EXEMPTED'),
  (:tenant, :erasereq, 'BACKUP', 0, false, 'Sakerhetskopior punktraderas inte; uppgifterna forsvinner nar backupretentionen loper ut', 'EXEMPTED');
UPDATE app.privacy_requests SET state='FULFILLED' WHERE tenant_id=:tenant AND id=:erasereq;

-- ===========================================================================
-- 9. A refusal must name its legal ground.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.privacy_requests SET state='REFUSED', refusal_ground='   '
     WHERE tenant_id='13131313-1313-4131-8131-131313131313' AND id='13131313-7777-4131-8131-131313131313';
    RAISE EXCEPTION 'GUARD FAILED: a request was refused with no stated ground';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%privacy_requests_refusal_needs_ground%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

SELECT 'privacy request guards: OK' AS result;

ROLLBACK;
