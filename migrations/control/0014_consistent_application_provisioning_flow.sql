-- Purpose: make approval and organization provisioning recoverable and consistent.
-- Impact: every submitted/review application state can be decided directly; existing
-- provisioning rows are reconciled with the application state without duplicate requests.
-- Backfill: repairs applications that already have a provisioning request but still show
-- an earlier approval/provisioning state.
-- Rollback: remove only after all repaired applications have reached onboarding or later.
-- Verification: all decision-pending states allow approve/reject and durable provisioning rows reconcile the application status.

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
    ('additional_information_requested','resubmitted'),('additional_information_requested','approved'),('additional_information_requested','rejected'),('additional_information_requested','withdrawn'),
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
DECLARE
  decision_state control.onboarding_application_status;
BEGIN
  FOREACH decision_state IN ARRAY ARRAY[
    'submitted','under_initial_review','additional_information_requested','resubmitted',
    'commercial_review','legal_review','security_review','technical_review'
  ]::control.onboarding_application_status[] LOOP
    IF NOT control.onboarding_transition_allowed(decision_state,'approved')
       OR NOT control.onboarding_transition_allowed(decision_state,'rejected') THEN
      RAISE EXCEPTION 'decision transition missing for %', decision_state;
    END IF;
  END LOOP;
END $$;

-- A request may have been inserted before an earlier API response was interrupted.
-- Keep the application status aligned with the durable provisioning request.
UPDATE control.onboarding_applications application
   SET status='provisioning',updated_at=now()
  FROM control.tenant_provisioning_requests request
 WHERE request.application_id=application.id
   AND application.status='approved';

UPDATE control.onboarding_applications application
   SET status='onboarding',linked_tenant_id=coalesce(application.linked_tenant_id,request.tenant_id),updated_at=now()
  FROM control.tenant_provisioning_requests request
 WHERE request.application_id=application.id
   AND application.status='provisioning'
   AND request.status='completed'
   AND request.tenant_id IS NOT NULL;

UPDATE control.onboarding_applications application
   SET status='provisioning_failed',updated_at=now()
  FROM control.tenant_provisioning_requests request
 WHERE request.application_id=application.id
   AND application.status='provisioning'
   AND request.status IN ('failed','partially_completed');
