\set ON_ERROR_STOP on
-- Proves, against a real database, that the PAdES signature chain cannot be
-- short-circuited. Every assertion here corresponds to a way a case could
-- otherwise be presented as signed when no PDF was signed.
--
-- The whole script runs in one transaction and rolls back; it seeds its own
-- tenant and leaves nothing behind.

BEGIN;

SELECT set_config('app.actor_kind', 'trusted_service', true);
SELECT set_config('app.tenant_id', '44444444-4444-4444-8444-444444444444', true);

\set tenant '''44444444-4444-4444-8444-444444444444'''
\set caseid '''55555555-5555-4555-8555-555555555555'''
\set userid '''66666666-6666-4666-8666-666666666666'''
\set policyid '''77777777-7777-4777-8777-777777777777'''
\set docid '''88888888-8888-4888-8888-888888888888'''
\set versionid '''99999999-9999-4999-8999-999999999999'''
\set signerid '''aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'''
\set signer2id '''aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa'''
\set intentid '''bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb'''
\set itxid '''cccccccc-1111-4ccc-8ccc-cccccccccccc'''
\set attemptid '''dddddddd-1111-4ddd-8ddd-dddddddddddd'''
\set artifactid '''eeeeeeee-1111-4eee-8eee-eeeeeeeeeeee'''

\set canonical '''1111111111111111111111111111111111111111111111111111111111111111'''
\set revision1 '''2222222222222222222222222222222222222222222222222222222222222222'''
\set revision2 '''3333333333333333333333333333333333333333333333333333333333333333'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '44444444-0000-4444-8444-444444444444', 'Kungalvs kommun');

INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :userid, 'subject-1', 'Handlaggare');

INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'AES', 'ELECTRONIC_SIGNATURE',
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, true, :userid);

INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :caseid, :userid, 'Beslut om bygglov', 'ELECTRONIC_SIGNATURE', :policyid, 1,
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, 'draft');

INSERT INTO app.documents (tenant_id, id, signature_case_id, display_name)
VALUES (:tenant, :docid, :caseid, 'beslut.pdf');

INSERT INTO app.document_versions (tenant_id, id, document_id, version, status, source_object_key, canonical_object_key, mime_type, byte_size, sha256, pdf_profile)
VALUES (:tenant, :versionid, :docid, 1, 'locked', 'source.pdf', 'canonical.pdf', 'application/pdf', 1024, :canonical, 'PDF/A-2b');

INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, status, signing_order, required, recipient_reference, identifier_binding_mode, identifier_binding_exception_code, identifier_binding_exception_approved_by, identifier_binding_exception_at)
VALUES (:tenant, :signerid, :caseid, 'Anna Andersson', 'pending', 1, true, 'recipient-anna-0001', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now());

INSERT INTO app.signing_intents (tenant_id, id, signature_case_id, signer_id, sequence_group, visible_text, visible_text_sha256, non_visible_payload, non_visible_payload_sha256, evidence_schema_version, identifier_binding_mode, status, issued_at, expires_at)
VALUES (:tenant, :intentid, :caseid, :signerid, 1, 'Signera beslut', :canonical, '{}', :canonical,
        'kommunsign.bankid-evidence.v2', 'BANKID_DISCOVERED', 'prepared', now(), now() + interval '1 hour');

INSERT INTO app.signing_intent_documents (tenant_id, signing_intent_id, document_version_id, ordinal, document_sha256, display_name_snapshot, mime_type_snapshot, profile_snapshot, byte_size_snapshot)
VALUES (:tenant, :intentid, :versionid, 1, :canonical, 'beslut.pdf', 'application/pdf', 'PDF/A-2b', 1024);

INSERT INTO app.identity_transactions (tenant_id, id, signer_id, document_version_id, provider, provider_reference, state_hash, nonce_hash, status, expires_at, signing_intent_id)
VALUES (:tenant, :itxid, :signerid, :versionid, 'TIC_BANKID', 'tic-ref-1', '\x00'::bytea, '\x01'::bytea, 'pending', now() + interval '1 hour', :intentid);

-- Verified TIC evidence: identity is proven, and nothing has been signed yet.
UPDATE app.signing_intents SET status='provider_started' WHERE tenant_id=:tenant AND id=:intentid;
UPDATE app.signing_intents SET status='evidence_collected' WHERE tenant_id=:tenant AND id=:intentid;
UPDATE app.signing_intents SET status='verified' WHERE tenant_id=:tenant AND id=:intentid;

INSERT INTO app.tic_identity_artifacts (tenant_id, identity_transaction_id, signing_intent_id, collect_response_object_key, collect_response_sha256, signature_xml_object_key, signature_xml_sha256, ocsp_response_object_key, ocsp_response_sha256, verification_report_object_key, verification_report_sha256, verification_result, verifier_engine, verifier_policy_version, verified_at)
VALUES (:tenant, :itxid, :intentid, 'collect.json', :canonical, 'sig.xml', :canonical, 'ocsp.der', :canonical, 'report.json', :canonical,
        'PASS', 'jdk-xml-dsig/secure-validation-v1', 'kommunsign.bankid-evidence.v2', now());

UPDATE app.signers SET status='invited' WHERE tenant_id=:tenant AND id=:signerid;
UPDATE app.signers SET status='identity_started' WHERE tenant_id=:tenant AND id=:signerid;
UPDATE app.signers SET status='identity_verified' WHERE tenant_id=:tenant AND id=:signerid;
UPDATE app.signers SET status='signing' WHERE tenant_id=:tenant AND id=:signerid;

-- ===========================================================================
-- 1. Verified TIC evidence alone must not be enough to mark a signer signed.
--    This is the defect this whole change exists to make impossible.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.signers SET status='signed'
    WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'GUARD FAILED: a signer was marked signed with only verified identity evidence';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('validated cryptographic signature for every document' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 2. A signature artifact with no certificate or chain supports no level.
--    The check is deferred to commit, so it is exercised in a savepoint.
-- ===========================================================================
INSERT INTO app.signature_attempts (tenant_id, id, signer_id, document_version_id, identity_transaction_id, attempt_number, status, document_sha256, provider)
VALUES (:tenant, :attemptid, :signerid, :versionid, :itxid, 1, 'prepared', :canonical, 'TIC_BANKID');
UPDATE app.signature_attempts SET status='identity_verified' WHERE tenant_id=:tenant AND id=:attemptid;
UPDATE app.signature_attempts SET status='credential_issued' WHERE tenant_id=:tenant AND id=:attemptid;

DO $$ BEGIN
  BEGIN
    INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-9999-4eee-8eee-eeeeeeeeeeee', 'dddddddd-1111-4ddd-8ddd-dddddddddddd',
            'PAdES-B', 'signed.pdf', '2222222222222222222222222222222222222222222222222222222222222222', 'sig.p7s',
            '1111111111111111111111111111111111111111111111111111111111111111');
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'GUARD FAILED: an artifact with no certificate evidence was admitted';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('supports no PAdES level' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;
SET CONSTRAINTS ALL DEFERRED;

-- ===========================================================================
-- 3. The first signature must be applied to the canonical revision.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-8888-4eee-8eee-eeeeeeeeeeee', 'dddddddd-1111-4ddd-8ddd-dddddddddddd',
            'PAdES-B', 'signed.pdf', '2222222222222222222222222222222222222222222222222222222222222222', 'sig.p7s',
            '3333333333333333333333333333333333333333333333333333333333333333');
    RAISE EXCEPTION 'GUARD FAILED: a first signature was accepted over a revision that does not exist';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('must be applied to its canonical revision' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- Now build a complete, honest PAdES-B artifact.
INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
VALUES (:tenant, :artifactid, :attemptid, 'PAdES-B', 'signed-1.pdf', :revision1, 'sig-1.p7s', :canonical);
INSERT INTO app.signature_certificates (tenant_id, signature_artifact_id, subject_summary, issuer_summary, serial_number, not_before, not_after, certificate_object_key, sha256)
VALUES (:tenant, :artifactid, 'CN=Anna Andersson', 'CN=Test CA', '01', now() - interval '1 day', now() + interval '365 days', 'cert.der', :canonical);
INSERT INTO app.certificate_chains (tenant_id, signature_artifact_id, chain_object_key, chain_sha256, trust_anchor_summary)
VALUES (:tenant, :artifactid, 'chain.p7b', :canonical, 'CN=Test CA');

-- ===========================================================================
-- 4. A level above what the evidence supports must be refused.
--    signature_artifacts is append-only, so the claim is made at INSERT and
--    caught when the deferred constraint is checked.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-7777-4eee-8eee-eeeeeeeeeeee', 'dddddddd-1111-4ddd-8ddd-dddddddddddd',
            'PAdES-T', 'signed-t.pdf', '4444444444444444444444444444444444444444444444444444444444444444', 'sig-t.p7s',
            '2222222222222222222222222222222222222222222222222222222222222222');
    INSERT INTO app.signature_certificates (tenant_id, signature_artifact_id, subject_summary, issuer_summary, serial_number, not_before, not_after, certificate_object_key, sha256)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-7777-4eee-8eee-eeeeeeeeeeee', 'CN=Anna Andersson', 'CN=Test CA', '07', now() - interval '1 day', now() + interval '365 days', 'cert7.der', '1111111111111111111111111111111111111111111111111111111111111111');
    INSERT INTO app.certificate_chains (tenant_id, signature_artifact_id, chain_object_key, chain_sha256, trust_anchor_summary)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-7777-4eee-8eee-eeeeeeeeeeee', 'chain7.p7b', '1111111111111111111111111111111111111111111111111111111111111111', 'CN=Test CA');
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'GUARD FAILED: PAdES-T was recorded with no timestamp evidence';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('the collected evidence supports only' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;
SET CONSTRAINTS ALL DEFERRED;

DO $$ BEGIN
  IF app.attained_pades_level('44444444-4444-4444-8444-444444444444', 'eeeeeeee-1111-4eee-8eee-eeeeeeeeeeee') <> 'PAdES-B' THEN
    RAISE EXCEPTION 'GUARD FAILED: certificate and chain alone must attain exactly PAdES-B';
  END IF;
END $$;

-- ===========================================================================
-- 5. A signed artifact that has not been validated is still not enough.
-- ===========================================================================
UPDATE app.signature_attempts SET status='signed' WHERE tenant_id=:tenant AND id=:attemptid;
DO $$ BEGIN
  BEGIN
    UPDATE app.signers SET status='signed'
    WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'GUARD FAILED: a signer was marked signed before independent validation';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('validated cryptographic signature for every document' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 6. A failed validation must not admit the signature either.
-- ===========================================================================
INSERT INTO app.validation_runs (tenant_id, signature_artifact_id, validator, validator_version, indication, machine_report_object_key, human_report_object_key, report_sha256)
VALUES (:tenant, :artifactid, 'swedenconnect-sigval-pdf', '1.3.0', 'TOTAL_FAILED', 'machine.json', 'human.html', :canonical);
UPDATE app.signature_attempts SET status='validated' WHERE tenant_id=:tenant AND id=:attemptid;
DO $$ BEGIN
  BEGIN
    UPDATE app.signers SET status='signed'
    WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'GUARD FAILED: a signer was marked signed on a failed validation';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('validated cryptographic signature for every document' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 7. A re-validation that passes admits the signature.
--    Evidence is append-only, so a later passing run is added rather than the
--    failed one being rewritten: both remain visible in the record.
--    A guard that never lets anything through is not a guard, it is an outage.
-- ===========================================================================
INSERT INTO app.validation_runs (tenant_id, signature_artifact_id, validator, validator_version, indication, machine_report_object_key, human_report_object_key, report_sha256)
VALUES (:tenant, :artifactid, 'swedenconnect-sigval-pdf', '1.3.0', 'TOTAL_PASSED', 'machine-2.json', 'human-2.html', :canonical);
UPDATE app.signers SET status='signed' WHERE tenant_id=:tenant AND id=:signerid;
DO $$ BEGIN
  IF (SELECT status::text FROM app.signers WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa') <> 'signed' THEN
    RAISE EXCEPTION 'GUARD FAILED: a fully evidenced signer could not be marked signed';
  END IF;
END $$;

-- ===========================================================================
-- 8a. A signature must continue from a revision that actually exists.
-- ===========================================================================
INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, status, signing_order, required, recipient_reference, identifier_binding_mode, identifier_binding_exception_code, identifier_binding_exception_approved_by, identifier_binding_exception_at)
VALUES (:tenant, :signer2id, :caseid, 'Bertil Bengtsson', 'pending', 2, true, 'recipient-bertil-0002', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now());
INSERT INTO app.identity_transactions (tenant_id, id, signer_id, document_version_id, provider, provider_reference, state_hash, nonce_hash, status, expires_at)
VALUES (:tenant, 'cccccccc-2222-4ccc-8ccc-cccccccccccc', :signer2id, :versionid, 'TIC_BANKID', 'tic-ref-2', '\x00'::bytea, '\x01'::bytea, 'pending', now() + interval '1 hour');
INSERT INTO app.signature_attempts (tenant_id, id, signer_id, document_version_id, identity_transaction_id, attempt_number, status, document_sha256, provider)
VALUES (:tenant, 'dddddddd-2222-4ddd-8ddd-dddddddddddd', :signer2id, :versionid, 'cccccccc-2222-4ccc-8ccc-cccccccccccc', 1, 'prepared', :canonical, 'TIC_BANKID');

-- The turn predicate, against the one state that is expensive to reach: a
-- signer who is signed because a complete evidence chain says so. Step 2 was
-- blocked before that happened; it must be open now. signing-turn.sql covers
-- the rest of the predicate, which does not need a signature to demonstrate.
DO $$ BEGIN
  IF app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'GUARD FAILED: step 2 stayed blocked after step 1 was fully evidenced and signed';
  END IF;
END $$;

DO $$ BEGIN
  BEGIN
    -- The canonical hash is not any signed revision, so continuing from it once
    -- a signature exists means the second signer never saw the first signature.
    INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-6666-4eee-8eee-eeeeeeeeeeee', 'dddddddd-2222-4ddd-8ddd-dddddddddddd',
            'PAdES-B', 'signed-2.pdf', '3333333333333333333333333333333333333333333333333333333333333333', 'sig-2.p7s',
            '1111111111111111111111111111111111111111111111111111111111111111');
    RAISE EXCEPTION 'GUARD FAILED: a later signature was accepted over a revision that is not a signed revision';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('must continue from an existing signed revision' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- Continuing from the first signed revision is the correct chain and is allowed.
INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'dddddddd-2222-4ddd-8ddd-dddddddddddd', 'PAdES-B', 'signed-2.pdf', :revision2, 'sig-2.p7s', :revision1);
INSERT INTO app.signature_certificates (tenant_id, signature_artifact_id, subject_summary, issuer_summary, serial_number, not_before, not_after, certificate_object_key, sha256)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'CN=Bertil Bengtsson', 'CN=Test CA', '02', now() - interval '1 day', now() + interval '365 days', 'cert2.der', :canonical);
INSERT INTO app.certificate_chains (tenant_id, signature_artifact_id, chain_object_key, chain_sha256, trust_anchor_summary)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'chain.p7b', :canonical, 'CN=Test CA');

-- ===========================================================================
-- 8b. Two signatures must not branch from the same revision.
--     Revision one has now been continued from. A third signer starting from it
--     again would produce a fork in which one of the two signatures is lost.
-- ===========================================================================
INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, status, signing_order, required, recipient_reference, identifier_binding_mode, identifier_binding_exception_code, identifier_binding_exception_approved_by, identifier_binding_exception_at)
VALUES (:tenant, 'aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa', :caseid, 'Cecilia Carlsson', 'pending', 3, false, 'recipient-cecilia-0003', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now());
INSERT INTO app.identity_transactions (tenant_id, id, signer_id, document_version_id, provider, provider_reference, state_hash, nonce_hash, status, expires_at)
VALUES (:tenant, 'cccccccc-3333-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa', :versionid, 'TIC_BANKID', 'tic-ref-3', '\x00'::bytea, '\x01'::bytea, 'pending', now() + interval '1 hour');
INSERT INTO app.signature_attempts (tenant_id, id, signer_id, document_version_id, identity_transaction_id, attempt_number, status, document_sha256, provider)
VALUES (:tenant, 'dddddddd-3333-4ddd-8ddd-dddddddddddd', 'aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa', :versionid, 'cccccccc-3333-4ccc-8ccc-cccccccccccc', 1, 'prepared', :canonical, 'TIC_BANKID');

DO $$ BEGIN
  BEGIN
    INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
    VALUES ('44444444-4444-4444-8444-444444444444', 'eeeeeeee-3333-4eee-8eee-eeeeeeeeeeee', 'dddddddd-3333-4ddd-8ddd-dddddddddddd',
            'PAdES-B', 'signed-3.pdf', '5555555555555555555555555555555555555555555555555555555555555555', 'sig-3.p7s',
            '2222222222222222222222222222222222222222222222222222222222222222');
    RAISE EXCEPTION 'GUARD FAILED: two signatures branched from the same revision';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('cannot branch from the same document revision' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 9. A case must not complete while a required signer is unsigned.
-- ===========================================================================
UPDATE app.signature_cases SET status='preparing' WHERE tenant_id=:tenant AND id=:caseid;
UPDATE app.signature_cases SET status='ready' WHERE tenant_id=:tenant AND id=:caseid;
UPDATE app.signature_cases SET status='sent' WHERE tenant_id=:tenant AND id=:caseid;
UPDATE app.signature_cases SET status='in_progress' WHERE tenant_id=:tenant AND id=:caseid;
DO $$ BEGIN
  BEGIN
    UPDATE app.signature_cases SET status='completed'
    WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'GUARD FAILED: a case completed while a required signer had not signed';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    -- Two guards enforce this rule and either may fire first. Both are correct;
    -- pinning the test to one implementation would make it fail on a reordering
    -- that changed nothing about what the database actually allows.
    IF position('every required participant to be completed' in SQLERRM) = 0
       AND position('required signer signed' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 10. The level ladder, one rung at a time, on the second signer's artifact.
--     Each insert is evidence being collected; the attained level must move
--     only when the evidence that defines that level actually arrives.
-- ===========================================================================
DO $$ BEGIN
  IF app.attained_pades_level('44444444-4444-4444-8444-444444444444', 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee') <> 'PAdES-B' THEN
    RAISE EXCEPTION 'GUARD FAILED: certificate and chain alone must attain exactly PAdES-B';
  END IF;
END $$;

INSERT INTO app.timestamp_tokens (tenant_id, signature_artifact_id, tsa_name, token_object_key, gen_time, sha256, token_type)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'Test TSA', 'tst.der', now(), :canonical, 'SIGNATURE');
DO $$ BEGIN
  IF app.attained_pades_level('44444444-4444-4444-8444-444444444444', 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee') <> 'PAdES-T' THEN
    RAISE EXCEPTION 'GUARD FAILED: a signature timestamp must attain exactly PAdES-T';
  END IF;
END $$;

-- Revocation data without a trust list snapshot still does not reach LT: without
-- a trust anchor set, revocation says the certificate was not revoked by an
-- authority nobody has agreed to trust.
INSERT INTO app.ocsp_evidence (tenant_id, signature_artifact_id, object_key, produced_at, sha256)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'ocsp.der', now(), :canonical);
INSERT INTO app.validation_runs (tenant_id, signature_artifact_id, validator, validator_version, indication, machine_report_object_key, human_report_object_key, report_sha256)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'swedenconnect-sigval-pdf', '1.3.0', 'TOTAL_PASSED', 'm.json', 'h.html', :canonical);
DO $$ BEGIN
  IF app.attained_pades_level('44444444-4444-4444-8444-444444444444', 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee') <> 'PAdES-T' THEN
    RAISE EXCEPTION 'GUARD FAILED: revocation data without a trust list snapshot must not reach PAdES-LT';
  END IF;
END $$;

INSERT INTO app.validation_runs (tenant_id, signature_artifact_id, validator, validator_version, indication, trust_list_snapshot_object_key, machine_report_object_key, human_report_object_key, report_sha256)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'swedenconnect-sigval-pdf', '1.3.0', 'TOTAL_PASSED', 'trust-list.xml', 'm2.json', 'h2.html', :canonical);
DO $$ BEGIN
  IF app.attained_pades_level('44444444-4444-4444-8444-444444444444', 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee') <> 'PAdES-LT' THEN
    RAISE EXCEPTION 'GUARD FAILED: revocation plus trust list must attain PAdES-LT';
  END IF;
END $$;

INSERT INTO app.timestamp_tokens (tenant_id, signature_artifact_id, tsa_name, token_object_key, gen_time, sha256, token_type)
VALUES (:tenant, 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee', 'Test TSA', 'archive-tst.der', now(), :canonical, 'ARCHIVE');
DO $$ BEGIN
  IF app.attained_pades_level('44444444-4444-4444-8444-444444444444', 'eeeeeeee-2222-4eee-8eee-eeeeeeeeeeee') <> 'PAdES-LTA' THEN
    RAISE EXCEPTION 'GUARD FAILED: an archive timestamp must attain PAdES-LTA';
  END IF;
END $$;

-- ===========================================================================
-- 11. Identity evidence: 'verified' requires a passing verification artifact.
-- ===========================================================================
UPDATE app.identity_transactions
SET status='complete_collected', completed_at=now(), collected_at=now(),
    raw_evidence_object_key='collect-2.json',
    evidence_sha256='1111111111111111111111111111111111111111111111111111111111111111'
WHERE tenant_id=:tenant AND id='cccccccc-2222-4ccc-8ccc-cccccccccccc';
DO $$ BEGIN
  BEGIN
    UPDATE app.identity_transactions SET status='verified'
    WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='cccccccc-2222-4ccc-8ccc-cccccccccccc';
    RAISE EXCEPTION 'GUARD FAILED: an identity transaction was verified with no verification artifact';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    -- Confirm the intended guard fired. Without this the block would also pass
    -- when some unrelated constraint rejected the statement first, which is how
    -- a guard test quietly stops testing the guard.
    IF position('without a passing verification artifact' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;


-- ===========================================================================
-- 12. A policy demanding a level the evidence does not reach is refused.
--     This is the tightening that the previous completion guard lacked: it
--     checked that a validated signature existed, never that the signature
--     reached the level the case's own policy asked for.
-- ===========================================================================
\set case2 '''55555555-2222-4555-8555-555555555555'''
\set policy2 '''77777777-2222-4777-8777-777777777777'''
\set doc2 '''88888888-2222-4888-8888-888888888888'''
\set version2 '''99999999-2222-4999-8999-999999999999'''
\set signer4 '''aaaaaaaa-4444-4aaa-8aaa-aaaaaaaaaaaa'''
\set intent2 '''bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb'''
\set itx4 '''cccccccc-4444-4ccc-8ccc-cccccccccccc'''
\set attempt4 '''dddddddd-4444-4ddd-8ddd-dddddddddddd'''
\set artifact4 '''eeeeeeee-4444-4eee-8eee-eeeeeeeeeeee'''
\set canonical2 '''6666666666666666666666666666666666666666666666666666666666666666'''
\set revision4 '''7777777777777777777777777777777777777777777777777777777777777777'''

INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policy2, 1, 'AES LT', 'ELECTRONIC_SIGNATURE',
        '{"requiredPadesLevel":"LT","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, true, :userid);
INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :case2, :userid, 'Beslut som kraver LT', 'ELECTRONIC_SIGNATURE', :policy2, 1,
        '{"requiredPadesLevel":"LT","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, 'draft');
INSERT INTO app.documents (tenant_id, id, signature_case_id, display_name) VALUES (:tenant, :doc2, :case2, 'beslut-lt.pdf');
INSERT INTO app.document_versions (tenant_id, id, document_id, version, status, source_object_key, canonical_object_key, mime_type, byte_size, sha256, pdf_profile)
VALUES (:tenant, :version2, :doc2, 1, 'locked', 's2.pdf', 'c2.pdf', 'application/pdf', 2048, :canonical2, 'PDF/A-2b');
INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, status, signing_order, required, recipient_reference, identifier_binding_mode, identifier_binding_exception_code, identifier_binding_exception_approved_by, identifier_binding_exception_at)
VALUES (:tenant, :signer4, :case2, 'David Davidsson', 'pending', 1, true, 'recipient-david-0004', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now());
INSERT INTO app.signing_intents (tenant_id, id, signature_case_id, signer_id, sequence_group, visible_text, visible_text_sha256, non_visible_payload, non_visible_payload_sha256, evidence_schema_version, identifier_binding_mode, status, issued_at, expires_at)
VALUES (:tenant, :intent2, :case2, :signer4, 1, 'Signera', :canonical2, '{}', :canonical2, 'kommunsign.bankid-evidence.v2', 'BANKID_DISCOVERED', 'prepared', now(), now() + interval '1 hour');
INSERT INTO app.signing_intent_documents (tenant_id, signing_intent_id, document_version_id, ordinal, document_sha256, display_name_snapshot, mime_type_snapshot, profile_snapshot, byte_size_snapshot)
VALUES (:tenant, :intent2, :version2, 1, :canonical2, 'beslut-lt.pdf', 'application/pdf', 'PDF/A-2b', 2048);
INSERT INTO app.identity_transactions (tenant_id, id, signer_id, document_version_id, provider, provider_reference, state_hash, nonce_hash, status, expires_at, signing_intent_id)
VALUES (:tenant, :itx4, :signer4, :version2, 'TIC_BANKID', 'tic-ref-4', '\x00'::bytea, '\x01'::bytea, 'pending', now() + interval '1 hour', :intent2);
UPDATE app.signing_intents SET status='provider_started' WHERE tenant_id=:tenant AND id=:intent2;
UPDATE app.signing_intents SET status='evidence_collected' WHERE tenant_id=:tenant AND id=:intent2;
UPDATE app.signing_intents SET status='verified' WHERE tenant_id=:tenant AND id=:intent2;
INSERT INTO app.tic_identity_artifacts (tenant_id, identity_transaction_id, signing_intent_id, collect_response_object_key, collect_response_sha256, signature_xml_object_key, signature_xml_sha256, ocsp_response_object_key, ocsp_response_sha256, verification_report_object_key, verification_report_sha256, verification_result, verifier_engine, verifier_policy_version, verified_at)
VALUES (:tenant, :itx4, :intent2, 'c.json', :canonical2, 's.xml', :canonical2, 'o.der', :canonical2, 'r.json', :canonical2, 'PASS', 'jdk-xml-dsig/secure-validation-v1', 'kommunsign.bankid-evidence.v2', now());
UPDATE app.signers SET status='invited' WHERE tenant_id=:tenant AND id=:signer4;
UPDATE app.signers SET status='identity_started' WHERE tenant_id=:tenant AND id=:signer4;
UPDATE app.signers SET status='identity_verified' WHERE tenant_id=:tenant AND id=:signer4;
UPDATE app.signers SET status='signing' WHERE tenant_id=:tenant AND id=:signer4;

-- A complete, correctly validated PAdES-B signature. Everything about it is
-- honest; it simply does not reach the level this case's policy requires.
INSERT INTO app.signature_attempts (tenant_id, id, signer_id, document_version_id, identity_transaction_id, attempt_number, status, document_sha256, provider)
VALUES (:tenant, :attempt4, :signer4, :version2, :itx4, 1, 'prepared', :canonical2, 'TIC_BANKID');
UPDATE app.signature_attempts SET status='identity_verified' WHERE tenant_id=:tenant AND id=:attempt4;
UPDATE app.signature_attempts SET status='credential_issued' WHERE tenant_id=:tenant AND id=:attempt4;
INSERT INTO app.signature_artifacts (tenant_id, id, signature_attempt_id, format, signed_document_object_key, signed_document_sha256, signature_value_object_key, input_revision_sha256)
VALUES (:tenant, :artifact4, :attempt4, 'PAdES-B', 'signed-4.pdf', :revision4, 'sig-4.p7s', :canonical2);
INSERT INTO app.signature_certificates (tenant_id, signature_artifact_id, subject_summary, issuer_summary, serial_number, not_before, not_after, certificate_object_key, sha256)
VALUES (:tenant, :artifact4, 'CN=David Davidsson', 'CN=Test CA', '04', now() - interval '1 day', now() + interval '365 days', 'cert4.der', :canonical2);
INSERT INTO app.certificate_chains (tenant_id, signature_artifact_id, chain_object_key, chain_sha256, trust_anchor_summary)
VALUES (:tenant, :artifact4, 'chain4.p7b', :canonical2, 'CN=Test CA');
INSERT INTO app.validation_runs (tenant_id, signature_artifact_id, validator, validator_version, indication, machine_report_object_key, human_report_object_key, report_sha256)
VALUES (:tenant, :artifact4, 'swedenconnect-sigval-pdf', '1.3.0', 'TOTAL_PASSED', 'm4.json', 'h4.html', :canonical2);
UPDATE app.signature_attempts SET status='signed' WHERE tenant_id=:tenant AND id=:attempt4;
UPDATE app.signature_attempts SET status='validated' WHERE tenant_id=:tenant AND id=:attempt4;

DO $$ BEGIN
  BEGIN
    UPDATE app.signers SET status='signed'
    WHERE tenant_id='44444444-4444-4444-8444-444444444444' AND id='aaaaaaaa-4444-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'GUARD FAILED: a PAdES-B signature satisfied a policy requiring PAdES-LT';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('validated cryptographic signature for every document' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

SELECT 'pades signature chain guards: OK' AS result;

ROLLBACK;
