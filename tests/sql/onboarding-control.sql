\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  ref_one text;
  ref_two text;
  application_id uuid := 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  tenant_id uuid := 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  initiator uuid := 'cccccccc-3333-4333-8333-cccccccccccc';
  activation_id uuid := 'dddddddd-4444-4444-8444-dddddddddddd';
BEGIN
  ref_one := control.next_onboarding_application_reference('2026-08-02T12:00:00Z');
  ref_two := control.next_onboarding_application_reference('2026-08-02T12:00:00Z');
  IF ref_one !~ '^ONB-2026-[0-9]{6}$' OR ref_one = ref_two THEN
    RAISE EXCEPTION 'Atomic onboarding reference generation failed: %, %', ref_one, ref_two;
  END IF;

  INSERT INTO control.onboarding_applications (
    id, status, organization_name, organization_number, organization_type,
    primary_email_ciphertext, primary_email_blind_index, primary_contact_name, primary_contact_title
  ) VALUES (
    application_id, 'email_verification_pending', 'Testkommun', '2120001234', 'municipality',
    decode('01','hex'), decode('02','hex'), 'Anna Test', 'IT-chef'
  );

  IF NOT control.onboarding_transition_allowed('additional_information_requested','approved')
     OR NOT control.onboarding_transition_allowed('additional_information_requested','rejected') THEN
    RAISE EXCEPTION 'Simple decision transitions are not installed for requested information';
  END IF;

  UPDATE control.onboarding_applications SET status = 'email_verified' WHERE id = application_id;
  IF (SELECT status_version FROM control.onboarding_applications WHERE id = application_id) <> 2 THEN
    RAISE EXCEPTION 'Onboarding optimistic version was not advanced';
  END IF;

  BEGIN
    UPDATE control.onboarding_applications SET status = 'active' WHERE id = application_id;
    RAISE EXCEPTION 'Invalid application transition was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'INVALID_APPLICATION_STATE_TRANSITION' THEN RAISE; END IF;
  END;

  INSERT INTO control.platform_tenants (id, slug, legal_name, organization_number, status)
  VALUES (tenant_id, 'onboarding-test', 'Testkommun', '2120001234', 'onboarding');

  INSERT INTO control.tenant_activation_requests (
    id, tenant_id, application_id, requested_by, status, readiness_snapshot, idempotency_key
  ) VALUES (
    activation_id, tenant_id, application_id, initiator, 'pending_approval',
    '{"ready":true,"environment":"production"}'::jsonb, 'activation-test-0001'
  );

  BEGIN
    INSERT INTO control.tenant_activation_approvals (activation_request_id, approver_id, decision, reason)
    VALUES (activation_id, initiator, 'approved', 'Must be blocked');
    RAISE EXCEPTION 'Self approval was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'TWO_PERSON_APPROVAL_REQUIRED' THEN RAISE; END IF;
  END;

  INSERT INTO control.tenant_activation_approvals (activation_request_id, approver_id, decision, reason)
  VALUES (activation_id, 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'approved', 'Distinct approver');
END $$;

ROLLBACK;
