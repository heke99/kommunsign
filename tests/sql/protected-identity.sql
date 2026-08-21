\set ON_ERROR_STOP on
-- Proves the guards behind requirement 2028 against a real database.
--
-- The disclosure rules themselves live in packages/protected-identity and are
-- covered by unit tests. What cannot be proven in TypeScript is that the
-- database refuses the two things a wrong caller would otherwise be able to
-- do: record a menprövning where none may exist, and edit one after the fact.
-- The third case is the audit log, which is an output channel like any other
-- and now refuses an identifying payload at the one function every handler
-- goes through.
--
-- Runs in one transaction and rolls back; it seeds its own tenant.

BEGIN;

SELECT set_config('app.actor_kind', 'trusted_service', true);
SELECT set_config('app.tenant_id', '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', true);

\set tenant '''4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a'''
\set userid '''6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b'''
\set policyid '''7c7c7c7c-7777-4777-8777-7c7c7c7c7c7c'''
\set caseid '''5d5d5d5d-5555-4555-8555-5d5d5d5d5d5d'''
\set plain '''e1e1e1e1-1111-4eee-8eee-e1e1e1e1e1e1'''
\set flagged '''e2e2e2e2-2222-4eee-8eee-e2e2e2e2e2e2'''
\set hidden '''e3e3e3e3-3333-4eee-8eee-e3e3e3e3e3e3'''
\set fake '''e4e4e4e4-4444-4eee-8eee-e4e4e4e4e4e4'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '4a4a4a4a-0000-4444-8444-4a4a4a4a4a4a', 'Kungalvs kommun');

INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :userid, 'subject-protected', 'Handlaggare');

INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'AES', 'ELECTRONIC_SIGNATURE',
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, true, :userid);

INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :caseid, :userid, 'Beslut med skyddade uppgifter', 'ELECTRONIC_SIGNATURE', :policyid, 1,
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, 'draft');

INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, status, signing_order, required, recipient_reference, identifier_binding_mode, identifier_binding_exception_code, identifier_binding_exception_approved_by, identifier_binding_exception_at, protection_level)
VALUES
  (:tenant, :plain,   :caseid, 'Oskyddad',   'invited', 1, true, 'recipient-plain',   'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now(), 'NONE'),
  (:tenant, :flagged, :caseid, 'Markerad',   'invited', 2, true, 'recipient-flagged', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now(), 'SEKRETESSMARKERING'),
  (:tenant, :hidden,  :caseid, 'Skyddad',    'invited', 3, true, 'recipient-hidden',  'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now(), 'SKYDDAD_FOLKBOKFORING'),
  (:tenant, :fake,    :caseid, 'Fingerad',   'invited', 4, true, 'recipient-fake',    'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now(), 'FINGERADE_PERSONUPPGIFTER');

-- An unknown level is not a level. The column refuses it rather than leaving
-- normaliseProtectionLevel as the only thing standing between a typo and an
-- unprotected signer.
DO $$
BEGIN
  BEGIN
    UPDATE app.signers SET protection_level = 'SKYDDAD'
     WHERE tenant_id = '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a'
       AND id = 'e1e1e1e1-1111-4eee-8eee-e1e1e1e1e1e1';
    RAISE EXCEPTION 'an unknown protection level must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- A menprövning is a decision about a protected person. There is nothing to
-- assess for someone unprotected, and no assessment can unlock a fingerad
-- identity.
DO $$
BEGIN
  BEGIN
    INSERT INTO app.protected_identity_assessments (tenant_id, signer_id, assessed_by, ground, expires_at)
    VALUES ('4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'e1e1e1e1-1111-4eee-8eee-e1e1e1e1e1e1',
            '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'Handlaggning av arendet kraver namnet', now() + interval '1 hour');
    RAISE EXCEPTION 'an assessment for an unprotected signer must be refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'a confidentiality assessment requires a protected signer' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO app.protected_identity_assessments (tenant_id, signer_id, assessed_by, ground, expires_at)
    VALUES ('4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'e4e4e4e4-4444-4eee-8eee-e4e4e4e4e4e4',
            '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'Handlaggning av arendet kraver namnet', now() + interval '1 hour');
    RAISE EXCEPTION 'an assessment for fingerade personuppgifter must be refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'fingerade personuppgifter cannot be disclosed by assessment' THEN RAISE; END IF;
  END;
END $$;

-- A ground is what makes it an assessment, and an expiry is what keeps it from
-- becoming a standing permission.
DO $$
BEGIN
  BEGIN
    INSERT INTO app.protected_identity_assessments (tenant_id, signer_id, assessed_by, ground, expires_at)
    VALUES ('4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'e2e2e2e2-2222-4eee-8eee-e2e2e2e2e2e2',
            '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'kort', now() + interval '1 hour');
    RAISE EXCEPTION 'an assessment without a real ground must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO app.protected_identity_assessments (tenant_id, signer_id, assessed_by, ground, expires_at)
    VALUES ('4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'e2e2e2e2-2222-4eee-8eee-e2e2e2e2e2e2',
            '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'Handlaggning av arendet kraver namnet', now() + interval '3 days');
    RAISE EXCEPTION 'an assessment that outlives the handling must be refused';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO app.protected_identity_assessments (tenant_id, id, signer_id, assessed_by, ground, expires_at)
VALUES (:tenant, 'f1f1f1f1-1111-4fff-8fff-f1f1f1f1f1f1', :flagged, :userid,
        'Motparten har ratt att veta vem som fattat beslutet', now() + interval '2 hours');

-- The record of a decision is worthless if the decision can be rewritten.
DO $$
BEGIN
  BEGIN
    UPDATE app.protected_identity_assessments SET ground = 'Nagot annat'
     WHERE tenant_id = '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a'
       AND id = 'f1f1f1f1-1111-4fff-8fff-f1f1f1f1f1f1';
    RAISE EXCEPTION 'a recorded assessment must not be editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'a confidentiality assessment is immutable; revoke it instead' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM app.protected_identity_assessments
     WHERE tenant_id = '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a'
       AND id = 'f1f1f1f1-1111-4fff-8fff-f1f1f1f1f1f1';
    RAISE EXCEPTION 'a recorded assessment must not be deletable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'a confidentiality assessment may not be deleted' THEN RAISE; END IF;
  END;
END $$;

-- Revocation is the one field that may change, because withdrawing a decision
-- is itself a decision and has to be possible.
UPDATE app.protected_identity_assessments SET revoked_at = now()
 WHERE tenant_id = :tenant AND id = 'f1f1f1f1-1111-4fff-8fff-f1f1f1f1f1f1';

-- The audit log is an output channel: it takes the case identifiers it always
-- took, and refuses the identifying field a future handler might add.
DO $$
DECLARE ok boolean;
BEGIN
  PERFORM audit.append_event(
    '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'BUSINESS', 'signer.invited', 'worker',
    '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'signature_case', '5d5d5d5d-5555-4555-8555-5d5d5d5d5d5d',
    '{"signerId":"e2e2e2e2-2222-4eee-8eee-e2e2e2e2e2e2","signingOrder":2}'::jsonb, now());

  BEGIN
    PERFORM audit.append_event(
      '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'BUSINESS', 'signer.invited', 'worker',
      '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'signature_case', '5d5d5d5d-5555-4555-8555-5d5d5d5d5d5d',
      '{"signerId":"e2e2e2e2-2222-4eee-8eee-e2e2e2e2e2e2","recipient":"nagon@exempel.se"}'::jsonb, now());
    RAISE EXCEPTION 'an audit payload with an identifying field must be refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'audit payload must not carry an identifying field%' THEN RAISE; END IF;
  END;

  -- Nested, because the field that leaks is rarely at the top level.
  BEGIN
    PERFORM audit.append_event(
      '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a', 'BUSINESS', 'signer.invited', 'worker',
      '6b6b6b6b-6666-4666-8666-6b6b6b6b6b6b', 'signature_case', '5d5d5d5d-5555-4555-8555-5d5d5d5d5d5d',
      '{"signers":[{"id":"e2e2e2e2-2222-4eee-8eee-e2e2e2e2e2e2","displayName":"Markerad"}]}'::jsonb, now());
    RAISE EXCEPTION 'a nested identifying field must be refused too';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'audit payload must not carry an identifying field%' THEN RAISE; END IF;
  END;
END $$;

SELECT 'protected personal data: OK';

ROLLBACK;
