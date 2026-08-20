\set ON_ERROR_STOP on
-- Proves app.signing_turn_blocked against a real database.
--
-- Three callers depend on this one answer: the endpoint that starts a
-- signature, the job that invites the next group, and the reminder job. The
-- cases below are the ones where a wrong answer is not merely inconvenient —
-- a skipped mandatory approver, or a decision stalled by someone who was never
-- required in the first place.
--
-- The case where a genuinely signed predecessor opens the next step lives in
-- pades-signature-chain.sql instead. Reaching 'signed' requires a complete
-- evidence chain, and this suite deliberately does not fake one.
--
-- Runs in one transaction and rolls back; it seeds its own tenant.

BEGIN;

SELECT set_config('app.actor_kind', 'trusted_service', true);
SELECT set_config('app.tenant_id', '44444444-4444-4444-8444-444444444444', true);

\set tenant '''44444444-4444-4444-8444-444444444444'''
\set userid '''66666666-6666-4666-8666-666666666666'''
\set policyid '''77777777-7777-4777-8777-777777777777'''
\set seqcase '''55555555-1111-4555-8555-555555555555'''
\set optcase '''55555555-2222-4555-8555-555555555555'''
\set parcase '''55555555-3333-4555-8555-555555555555'''
\set step1 '''aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'''
\set step2 '''aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa'''
\set step3 '''aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa'''
\set optionalFirst '''bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb'''
\set afterOptional '''bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb'''
\set parallelA '''cccccccc-1111-4ccc-8ccc-cccccccccccc'''
\set parallelB '''cccccccc-2222-4ccc-8ccc-cccccccccccc'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '44444444-0000-4444-8444-444444444444', 'Kungalvs kommun');

INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :userid, 'subject-1', 'Handlaggare');

INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'AES', 'ELECTRONIC_SIGNATURE',
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, true, :userid);

INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :seqcase, :userid, 'Sekventiellt beslut', 'ELECTRONIC_SIGNATURE', :policyid, 1,
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, 'draft'),
       (:tenant, :optcase, :userid, 'Beslut med frivillig granskare', 'ELECTRONIC_SIGNATURE', :policyid, 1,
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, 'draft'),
       (:tenant, :parcase, :userid, 'Parallellt beslut', 'ELECTRONIC_SIGNATURE', :policyid, 1,
        '{"requiredPadesLevel":"B","allowedValidationResults":["TOTAL_PASSED"]}'::jsonb, 'draft');

INSERT INTO app.signers (tenant_id, id, signature_case_id, display_name, status, signing_order, required, recipient_reference, identifier_binding_mode, identifier_binding_exception_code, identifier_binding_exception_approved_by, identifier_binding_exception_at)
VALUES
  -- Sequential: nobody has signed yet.
  (:tenant, :step1, :seqcase, 'Steg 1', 'invited', 1, true, 'recipient-1', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now()),
  (:tenant, :step2, :seqcase, 'Steg 2', 'invited', 2, true, 'recipient-2', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now()),
  (:tenant, :step3, :seqcase, 'Steg 3', 'invited', 3, true, 'recipient-3', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now()),
  -- An optional reviewer ahead of a required decision-maker.
  (:tenant, :optionalFirst, :optcase, 'Frivillig granskare', 'invited', 1, false, 'recipient-opt', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now()),
  (:tenant, :afterOptional, :optcase, 'Beslutsfattare', 'invited', 2, true, 'recipient-after', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now()),
  -- Parallel: one group, both may act at once.
  (:tenant, :parallelA, :parcase, 'Parallell A', 'invited', 1, true, 'recipient-pa', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now()),
  (:tenant, :parallelB, :parcase, 'Parallell B', 'invited', 1, true, 'recipient-pb', 'BANKID_DISCOVERED', 'UNKNOWN_AT_INVITATION', :userid, now());

DO $$
BEGIN
  -- The first step is never blocked: there is nothing ahead of it.
  IF app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'the first step must never be blocked';
  END IF;

  -- A valid invitation for step 2 or step 3 proves who the person is, not that
  -- it is their turn. This is the case the reminder job used to get wrong: it
  -- reminded every invited signer, including the ones whose document would
  -- refuse to open.
  IF NOT app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'step 2 must be blocked while step 1 has not signed';
  END IF;
  IF NOT app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'step 3 must be blocked while earlier required steps have not signed';
  END IF;

  -- An optional reviewer who never answers must not stall the decision.
  IF app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb') THEN
    RAISE EXCEPTION 'an unanswered optional signer must not block the next step';
  END IF;

  -- Parallel signers never block each other.
  IF app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'cccccccc-1111-4ccc-8ccc-cccccccccccc')
     OR app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'cccccccc-2222-4ccc-8ccc-cccccccccccc') THEN
    RAISE EXCEPTION 'a parallel case must never block either signer';
  END IF;
END $$;

-- A declined predecessor is not a signed one. The case is closed elsewhere,
-- but the predicate must not treat 'declined' as satisfied: that would make the
-- final step reachable through a refusal.
UPDATE app.signers SET status = 'opened', status_version = status_version + 1
WHERE tenant_id = :tenant AND id = :step1;
UPDATE app.signers SET status = 'declined', status_version = status_version + 1
WHERE tenant_id = :tenant AND id = :step1;

DO $$
BEGIN
  IF NOT app.signing_turn_blocked('44444444-4444-4444-8444-444444444444', 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'a declined predecessor must still block the next step';
  END IF;
END $$;

SELECT 'signing turn predicate: OK';

ROLLBACK;
