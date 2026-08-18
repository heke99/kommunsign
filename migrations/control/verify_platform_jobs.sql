-- Verification for migrations/control/0018_platform_job_runtime.sql.
--
-- The platform jobs write to the control plane through ordinary SQL, so what
-- protects the record is the schema, not the handler. These checks prove the
-- guarantees the handlers rely on: that an unattended timeout can be recorded
-- as what it was, that it cannot be walked back into the review pipeline
-- afterwards, and that the review states are still untouchable by a timer.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  application_id uuid := 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
BEGIN
  -- The enum value must exist, or the deadline handler's UPDATE fails at
  -- runtime with a cast error rather than expiring anything.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'onboarding_application_status' AND e.enumlabel = 'expired'
  ) THEN
    RAISE EXCEPTION 'onboarding_application_status lacks the expired value';
  END IF;

  -- Exactly the two pre-submission states may expire. An application under
  -- review is someone's active work; a deadline must never close it out.
  IF NOT control.onboarding_transition_allowed('draft','expired')
     OR NOT control.onboarding_transition_allowed('email_verification_pending','expired') THEN
    RAISE EXCEPTION 'Pre-submission applications cannot be expired';
  END IF;
  IF control.onboarding_transition_allowed('under_initial_review','expired')
     OR control.onboarding_transition_allowed('commercial_review','expired')
     OR control.onboarding_transition_allowed('legal_review','expired')
     OR control.onboarding_transition_allowed('security_review','expired')
     OR control.onboarding_transition_allowed('technical_review','expired')
     OR control.onboarding_transition_allowed('approved','expired')
     OR control.onboarding_transition_allowed('submitted','expired') THEN
    RAISE EXCEPTION 'A submitted or reviewed application can be expired by a timer';
  END IF;

  -- Expiry is terminal apart from archiving. Otherwise a later update could
  -- resurrect an application whose contact details were meant to stop being live.
  IF NOT control.onboarding_transition_allowed('expired','archived') THEN
    RAISE EXCEPTION 'An expired application cannot be archived';
  END IF;
  IF control.onboarding_transition_allowed('expired','draft')
     OR control.onboarding_transition_allowed('expired','email_verification_pending')
     OR control.onboarding_transition_allowed('expired','submitted')
     OR control.onboarding_transition_allowed('expired','under_initial_review')
     OR control.onboarding_transition_allowed('expired','active') THEN
    RAISE EXCEPTION 'An expired application can be resurrected';
  END IF;

  -- The existing edges must survive the function being replaced.
  IF NOT control.onboarding_transition_allowed('ready_for_activation','active')
     OR NOT control.onboarding_transition_allowed('email_verification_pending','email_verified')
     OR NOT control.onboarding_transition_allowed('additional_information_requested','resubmitted') THEN
    RAISE EXCEPTION 'Replacing the transition function dropped an existing edge';
  END IF;

  -- And the guard must actually fire, not merely be expressible.
  INSERT INTO control.onboarding_applications (
    id, status, organization_name, organization_number, organization_type,
    primary_email_ciphertext, primary_email_blind_index, primary_contact_name, primary_contact_title
  ) VALUES (
    application_id, 'email_verification_pending', 'Utgangen kommun', '2120009999', 'municipality',
    decode('01','hex'), decode('02','hex'), 'Bo Test', 'Kanslichef'
  );

  UPDATE control.onboarding_applications SET status = 'expired' WHERE id = application_id;
  IF (SELECT status FROM control.onboarding_applications WHERE id = application_id) <> 'expired' THEN
    RAISE EXCEPTION 'Expiring an unverified application was not applied';
  END IF;
  -- The trigger owns status_version, so the handler does not need to set it and
  -- must not be believed if it thinks it did.
  IF (SELECT status_version FROM control.onboarding_applications WHERE id = application_id) <> 2 THEN
    RAISE EXCEPTION 'Expiry did not advance the optimistic version';
  END IF;

  BEGIN
    UPDATE control.onboarding_applications SET status = 'under_initial_review' WHERE id = application_id;
    RAISE EXCEPTION 'An expired application was moved back into review';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'INVALID_APPLICATION_STATE_TRANSITION' THEN RAISE; END IF;
  END;

  -- The sweep indexes the monitor and the deadline job depend on must exist, or
  -- both degrade to a full scan on tables that only grow.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='control' AND indexname='domain_certificate_snapshots_expiry_idx') THEN
    RAISE EXCEPTION 'Certificate expiry sweep index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='control' AND indexname='onboarding_applications_unverified_age_idx') THEN
    RAISE EXCEPTION 'Unverified application age index is missing';
  END IF;

  RAISE NOTICE 'Platform job control-plane verification passed';
END $$;

ROLLBACK;
