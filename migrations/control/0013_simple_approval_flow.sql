-- Purpose: simplify platform onboarding so a submitted application can be approved or rejected directly.
-- Impact: optional specialist reviews remain auditable, but they are no longer mandatory before a superadmin decision.
-- Backfill: none; existing application rows keep their current state.
-- Rollback: restore the prior transition function only after directly approved applications have left review states.
-- Verification: submitted -> approved/rejected and under_initial_review/resubmitted -> approved must return true.

CREATE OR REPLACE FUNCTION control.onboarding_transition_allowed(
  p_from control.onboarding_application_status,
  p_to control.onboarding_application_status
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('draft','email_verification_pending'),('draft','withdrawn'),
    ('email_verification_pending','email_verified'),('email_verification_pending','withdrawn'),
    ('email_verified','submitted'),('email_verified','withdrawn'),
    ('submitted','under_initial_review'),('submitted','approved'),('submitted','rejected'),('submitted','withdrawn'),
    ('under_initial_review','additional_information_requested'),('under_initial_review','commercial_review'),('under_initial_review','legal_review'),('under_initial_review','security_review'),('under_initial_review','technical_review'),('under_initial_review','approved'),('under_initial_review','rejected'),('under_initial_review','withdrawn'),
    ('additional_information_requested','resubmitted'),('additional_information_requested','withdrawn'),
    ('resubmitted','under_initial_review'),('resubmitted','commercial_review'),('resubmitted','legal_review'),('resubmitted','security_review'),('resubmitted','technical_review'),('resubmitted','approved'),('resubmitted','rejected'),('resubmitted','withdrawn'),
    ('commercial_review','legal_review'),('commercial_review','security_review'),('commercial_review','technical_review'),('commercial_review','additional_information_requested'),('commercial_review','approved'),('commercial_review','rejected'),
    ('legal_review','commercial_review'),('legal_review','security_review'),('legal_review','technical_review'),('legal_review','additional_information_requested'),('legal_review','approved'),('legal_review','rejected'),
    ('security_review','commercial_review'),('security_review','legal_review'),('security_review','technical_review'),('security_review','additional_information_requested'),('security_review','approved'),('security_review','rejected'),
    ('technical_review','commercial_review'),('technical_review','legal_review'),('technical_review','security_review'),('technical_review','additional_information_requested'),('technical_review','approved'),('technical_review','rejected'),
    ('approved','provisioning'),('approved','archived'),('rejected','archived'),('withdrawn','archived'),
    ('provisioning','provisioning_failed'),('provisioning','onboarding'),('provisioning_failed','provisioning'),('provisioning_failed','rejected'),('provisioning_failed','archived'),
    ('onboarding','ready_for_acceptance_test'),('onboarding','archived'),('ready_for_acceptance_test','acceptance_test_failed'),('ready_for_acceptance_test','ready_for_activation'),
    ('acceptance_test_failed','onboarding'),('acceptance_test_failed','ready_for_acceptance_test'),('acceptance_test_failed','archived'),
    ('ready_for_activation','active'),('ready_for_activation','onboarding'),('ready_for_activation','archived'),('active','archived')
  )
$$;

DO $$
BEGIN
  IF NOT control.onboarding_transition_allowed('submitted','approved')
     OR NOT control.onboarding_transition_allowed('submitted','rejected')
     OR NOT control.onboarding_transition_allowed('under_initial_review','approved')
     OR NOT control.onboarding_transition_allowed('resubmitted','approved') THEN
    RAISE EXCEPTION 'simple onboarding decision transitions were not installed';
  END IF;
END $$;
