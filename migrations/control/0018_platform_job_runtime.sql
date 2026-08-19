-- Transaction: none
-- Purpose: Give the control-plane platform jobs the states and indexes they need: an expired onboarding application must be recorded as expired, not as withdrawn.
-- Impact: Adds one enum value to control.onboarding_application_status, three transition edges and two partial indexes. No table is rewritten and no existing row changes.
-- Backfill: None. Existing applications keep their current status; only future deadline runs can produce 'expired'.
-- Rollback: Restore control.onboarding_transition_allowed from migration 0014 and drop the two indexes. The enum value itself cannot be dropped in PostgreSQL and is harmless if unused.
-- Verification: Run the control migration suite and migrations/control/verify_platform_jobs.sql, which proves an expired application cannot be resurrected, that review states cannot be expired by a timer, and that no earlier edge was lost.

-- An application that nobody verified in time was not withdrawn. 'withdrawn' is
-- an act by the applicant, and recording an unattended timeout as one puts a
-- decision in the record that no human made.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
-- which is why this migration is marked '-- Transaction: none': each statement
-- autocommits, so the function below can reference the new value.
ALTER TYPE control.onboarding_application_status ADD VALUE IF NOT EXISTS 'expired' AFTER 'withdrawn';

-- The full edge set has to be restated because CREATE OR REPLACE takes a whole
-- body. That is a standing hazard: this list is carried forward from migration
-- 0014, and an edge silently dropped here would quietly close a path through
-- the review pipeline. The assertion block below is what makes that loud rather
-- than quiet -- it already caught exactly that regression while this migration
-- was being written, when the list was carried forward from 0006 instead.
--
-- Only the two pre-submission states may expire. An application under review is
-- someone's active work; a timer must never close it out from underneath them.
-- 'expired' is terminal apart from archiving, so an expired application cannot
-- be walked back into the pipeline by a later update.
CREATE OR REPLACE FUNCTION control.onboarding_transition_allowed(
  p_from control.onboarding_application_status,
  p_to control.onboarding_application_status
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('draft','email_verification_pending'),('draft','withdrawn'),('draft','expired'),
    ('email_verification_pending','email_verified'),('email_verification_pending','withdrawn'),('email_verification_pending','expired'),
    ('email_verified','submitted'),('email_verified','withdrawn'),
    ('submitted','under_initial_review'),('submitted','approved'),('submitted','rejected'),('submitted','withdrawn'),
    ('under_initial_review','additional_information_requested'),('under_initial_review','commercial_review'),('under_initial_review','legal_review'),('under_initial_review','security_review'),('under_initial_review','technical_review'),('under_initial_review','approved'),('under_initial_review','rejected'),('under_initial_review','withdrawn'),
    ('additional_information_requested','resubmitted'),('additional_information_requested','approved'),('additional_information_requested','rejected'),('additional_information_requested','withdrawn'),
    ('resubmitted','under_initial_review'),('resubmitted','commercial_review'),('resubmitted','legal_review'),('resubmitted','security_review'),('resubmitted','technical_review'),('resubmitted','approved'),('resubmitted','rejected'),('resubmitted','withdrawn'),
    ('commercial_review','legal_review'),('commercial_review','security_review'),('commercial_review','technical_review'),('commercial_review','additional_information_requested'),('commercial_review','approved'),('commercial_review','rejected'),
    ('legal_review','commercial_review'),('legal_review','security_review'),('legal_review','technical_review'),('legal_review','additional_information_requested'),('legal_review','approved'),('legal_review','rejected'),
    ('security_review','commercial_review'),('security_review','legal_review'),('security_review','technical_review'),('security_review','additional_information_requested'),('security_review','approved'),('security_review','rejected'),
    ('technical_review','commercial_review'),('technical_review','legal_review'),('technical_review','security_review'),('technical_review','additional_information_requested'),('technical_review','approved'),('technical_review','rejected'),
    ('approved','provisioning'),('approved','archived'),('rejected','archived'),('withdrawn','archived'),('expired','archived'),
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
  -- Migrations 0013/0014 installed the simple decision flow. Re-assert it here
  -- so replacing the function can never be the thing that removes it.
  FOREACH decision_state IN ARRAY ARRAY[
    'submitted','under_initial_review','additional_information_requested','resubmitted',
    'commercial_review','legal_review','security_review','technical_review'
  ]::control.onboarding_application_status[] LOOP
    IF NOT control.onboarding_transition_allowed(decision_state,'approved')
       OR NOT control.onboarding_transition_allowed(decision_state,'rejected') THEN
      RAISE EXCEPTION 'decision transition missing for %', decision_state;
    END IF;
    -- And no submitted or reviewed state may be expired by a timer.
    IF control.onboarding_transition_allowed(decision_state,'expired') THEN
      RAISE EXCEPTION 'a timer can expire %, which is someone active work', decision_state;
    END IF;
  END LOOP;

  IF NOT control.onboarding_transition_allowed('draft','expired')
     OR NOT control.onboarding_transition_allowed('email_verification_pending','expired')
     OR NOT control.onboarding_transition_allowed('expired','archived') THEN
    RAISE EXCEPTION 'expiry edges were not installed';
  END IF;
  IF control.onboarding_transition_allowed('expired','draft')
     OR control.onboarding_transition_allowed('expired','under_initial_review')
     OR control.onboarding_transition_allowed('expired','active') THEN
    RAISE EXCEPTION 'an expired application can be resurrected';
  END IF;
  IF NOT control.onboarding_transition_allowed('ready_for_activation','active')
     OR NOT control.onboarding_transition_allowed('provisioning','onboarding')
     OR NOT control.onboarding_transition_allowed('approved','provisioning') THEN
    RAISE EXCEPTION 'replacing the transition function dropped an existing edge';
  END IF;
END $$;

-- The certificate monitor sweeps by expiry across all tenants, and the alert it
-- feeds is only useful if the sweep is cheap enough to run often.
CREATE INDEX IF NOT EXISTS domain_certificate_snapshots_expiry_idx
  ON control.domain_certificate_snapshots(not_after)
  WHERE status = 'issued';

-- The deadline job scans exactly these two states by age.
CREATE INDEX IF NOT EXISTS onboarding_applications_unverified_age_idx
  ON control.onboarding_applications(created_at)
  WHERE status IN ('draft','email_verification_pending');
