-- Purpose: Add application-driven onboarding, review, provisioning, readiness and two-person activation to the control plane.
-- Impact: Creates additive control-plane tables, constraints, indexes and state guards; no tenant document or signature evidence is stored here.
-- Backfill: Existing tenants remain unchanged. Existing rows require no backfill because all new tables are empty and independently keyed.
-- Rollback: Disable onboarding writes, export application/audit records, then remove the additive objects in reverse dependency order during a maintenance window.
-- Verification: Run the control migration suite, inspect constraints/triggers, and execute concurrent application-reference, self-approval and state-transition tests.

ALTER TYPE control.tenant_status ADD VALUE IF NOT EXISTS 'onboarding' BEFORE 'active';

DO $$ BEGIN
  CREATE TYPE control.onboarding_application_status AS ENUM (
    'draft','email_verification_pending','email_verified','submitted','under_initial_review',
    'additional_information_requested','resubmitted','commercial_review','legal_review',
    'security_review','technical_review','approved','rejected','withdrawn','provisioning',
    'provisioning_failed','onboarding','ready_for_acceptance_test','acceptance_test_failed',
    'ready_for_activation','active','archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE control.onboarding_review_type AS ENUM ('commercial','legal','security','technical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE control.onboarding_review_result AS ENUM ('pending','passed','failed','requires_information');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE control.provisioning_status AS ENUM (
    'requested','validated','queued','running','waiting_for_external_dependency',
    'retry_scheduled','failed','partially_completed','completed','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS control.onboarding_application_reference_seq AS bigint MINVALUE 1;

CREATE TABLE control.onboarding_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_reference text UNIQUE CHECK (application_reference IS NULL OR application_reference ~ '^ONB-[0-9]{4}-[0-9]{6}$'),
  status control.onboarding_application_status NOT NULL DEFAULT 'email_verification_pending',
  status_version bigint NOT NULL DEFAULT 1 CHECK (status_version > 0),
  organization_name text NOT NULL CHECK (length(organization_name) BETWEEN 2 AND 300),
  organization_number text NOT NULL CHECK (organization_number ~ '^[0-9]{10}$'),
  organization_type text NOT NULL CHECK (organization_type IN ('municipality','region','municipal_federation','municipal_company','authority','public_supplier','other_public_body')),
  primary_email_ciphertext bytea NOT NULL,
  primary_email_blind_index bytea NOT NULL,
  primary_contact_name text NOT NULL,
  primary_contact_title text NOT NULL,
  applicant_visible_profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(applicant_visible_profile) = 'object'),
  assigned_to uuid,
  possible_duplicate boolean NOT NULL DEFAULT false,
  duplicate_of_application_id uuid REFERENCES control.onboarding_applications(id),
  linked_tenant_id uuid REFERENCES control.platform_tenants(id),
  email_verified_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_number)
);
CREATE INDEX onboarding_applications_status_created_idx ON control.onboarding_applications(status, created_at DESC);
CREATE INDEX onboarding_applications_org_idx ON control.onboarding_applications(organization_number);
CREATE INDEX onboarding_applications_email_idx ON control.onboarding_applications(primary_email_blind_index);

CREATE TABLE control.onboarding_application_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  version_number bigint NOT NULL CHECK (version_number > 0),
  source text NOT NULL CHECK (source IN ('applicant','platform','system')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, version_number)
);

CREATE TABLE control.onboarding_application_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  contact_type text NOT NULL CHECK (contact_type IN ('primary','technical','legal','privacy','security','billing','procurement','additional')),
  name text NOT NULL,
  title text,
  email_ciphertext bytea,
  email_blind_index bytea,
  phone_ciphertext bytea,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  applicant_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.onboarding_application_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  category text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type = 'application/pdf'),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 104857600),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('quarantined','scanning','rejected','ready')),
  rejection_code text,
  uploaded_by_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz
);

CREATE TABLE control.onboarding_email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  email_blind_index bytea NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX onboarding_email_verifications_application_idx ON control.onboarding_email_verifications(application_id, created_at DESC);

CREATE TABLE control.onboarding_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  token_hash bytea NOT NULL UNIQUE,
  subject_reference text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE control.onboarding_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  review_type control.onboarding_review_type NOT NULL,
  result control.onboarding_review_result NOT NULL,
  reviewer_id uuid NOT NULL,
  summary text NOT NULL,
  risk_level text CHECK (risk_level IS NULL OR risk_level IN ('low','medium','high','critical')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_reviews_application_idx ON control.onboarding_reviews(application_id, review_type, created_at DESC);

CREATE TABLE control.onboarding_review_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  review_type control.onboarding_review_type NOT NULL,
  assignee_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('assigned','accepted','completed','cancelled')),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE control.onboarding_information_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  category text NOT NULL CHECK (category IN ('commercial','legal','security','technical','organization','other')),
  question text NOT NULL,
  attachment_required boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('open','answered','accepted','rejected','cancelled')),
  requested_by uuid NOT NULL,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE control.onboarding_information_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  information_request_id uuid NOT NULL REFERENCES control.onboarding_information_requests(id),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  answer text NOT NULL,
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  submitted_by_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.onboarding_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected','withdrawn')),
  decided_by uuid NOT NULL,
  second_approver_id uuid,
  external_reason text NOT NULL,
  internal_reason text,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array'),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (second_approver_id IS NULL OR second_approver_id <> decided_by)
);

CREATE TABLE control.onboarding_internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  note_classification text NOT NULL CHECK (note_classification IN ('general','commercial','legal','security','technical')),
  body_ciphertext bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE control.onboarding_external_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  direction text NOT NULL CHECK (direction IN ('applicant_to_platform','platform_to_applicant')),
  body text NOT NULL,
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  sender_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.onboarding_risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  risk_level text NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  risk_factors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(risk_factors) = 'array'),
  assessed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.onboarding_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  tenant_id uuid REFERENCES control.platform_tenants(id),
  environment text NOT NULL CHECK (environment IN ('test','production')),
  status text NOT NULL CHECK (status IN ('not_started','in_progress','blocked','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (application_id, environment)
);

CREATE TABLE control.onboarding_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES control.onboarding_checklists(id),
  item_key text NOT NULL,
  category text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK (status IN ('not_started','in_progress','blocked','passed','failed','waived')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  completed_by uuid,
  completed_at timestamptz,
  UNIQUE (checklist_id, item_key)
);

CREATE TABLE control.onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  tenant_id uuid REFERENCES control.platform_tenants(id),
  task_type text NOT NULL,
  assignee_id uuid,
  status text NOT NULL CHECK (status IN ('queued','in_progress','blocked','completed','cancelled')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE control.onboarding_task_dependencies (
  task_id uuid NOT NULL REFERENCES control.onboarding_tasks(id),
  depends_on_task_id uuid NOT NULL REFERENCES control.onboarding_tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE control.tenant_provisioning_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES control.onboarding_applications(id),
  tenant_id uuid UNIQUE REFERENCES control.platform_tenants(id),
  status control.provisioning_status NOT NULL DEFAULT 'requested',
  deployment_mode control.deployment_mode NOT NULL,
  region text NOT NULL,
  requested_by uuid NOT NULL,
  current_step text,
  blocking_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (application_id, idempotency_key)
);

CREATE TABLE control.tenant_provisioning_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provisioning_request_id uuid NOT NULL REFERENCES control.tenant_provisioning_requests(id),
  step_key text NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  status text NOT NULL CHECK (status IN ('pending','running','waiting','failed','completed','skipped')),
  resource_reference text,
  safe_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (provisioning_request_id, step_key),
  UNIQUE (provisioning_request_id, sequence_number)
);

CREATE TABLE control.tenant_provisioning_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provisioning_request_id uuid NOT NULL REFERENCES control.tenant_provisioning_requests(id),
  step_id uuid REFERENCES control.tenant_provisioning_steps(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  result text NOT NULL CHECK (result IN ('started','succeeded','retryable_failure','permanent_failure')),
  safe_error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (provisioning_request_id, step_id, attempt_number)
);

CREATE TABLE control.tenant_activation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  application_id uuid NOT NULL REFERENCES control.onboarding_applications(id),
  requested_by uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('requested','pending_approval','approved','rejected','activated','cancelled')),
  readiness_snapshot jsonb NOT NULL CHECK (jsonb_typeof(readiness_snapshot) = 'object'),
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_snapshot) = 'object'),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE control.tenant_activation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activation_request_id uuid NOT NULL REFERENCES control.tenant_activation_requests(id),
  approver_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activation_request_id, approver_id)
);

CREATE TABLE control.tenant_readiness_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_key text NOT NULL UNIQUE,
  description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('blocking','warning')),
  active boolean NOT NULL DEFAULT true,
  implementation_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.tenant_readiness_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  activation_request_id uuid REFERENCES control.tenant_activation_requests(id),
  environment text NOT NULL CHECK (environment IN ('test','production')),
  ready boolean NOT NULL,
  blocking_checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocking_checks) = 'array'),
  warning_checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warning_checks) = 'array'),
  completed_checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(completed_checks) = 'array'),
  checked_by text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_readiness_results_latest_idx ON control.tenant_readiness_results(tenant_id, environment, checked_at DESC);

CREATE TABLE control.onboarding_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('public','application','platform','tenant')),
  scope_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_payload_sha256 text NOT NULL CHECK (request_payload_sha256 ~ '^[0-9a-f]{64}$'),
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, operation, idempotency_key)
);

CREATE OR REPLACE FUNCTION control.next_onboarding_application_reference(p_now timestamptz DEFAULT now()) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT 'ONB-' || to_char(p_now AT TIME ZONE 'UTC','YYYY') || '-' || lpad(nextval('control.onboarding_application_reference_seq')::text, 6, '0')
$$;

CREATE OR REPLACE FUNCTION control.onboarding_transition_allowed(p_from control.onboarding_application_status, p_to control.onboarding_application_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('draft','email_verification_pending'),('draft','withdrawn'),
    ('email_verification_pending','email_verified'),('email_verification_pending','withdrawn'),
    ('email_verified','submitted'),('email_verified','withdrawn'),
    ('submitted','under_initial_review'),('submitted','withdrawn'),
    ('under_initial_review','additional_information_requested'),('under_initial_review','commercial_review'),('under_initial_review','legal_review'),('under_initial_review','security_review'),('under_initial_review','technical_review'),('under_initial_review','rejected'),('under_initial_review','withdrawn'),
    ('additional_information_requested','resubmitted'),('additional_information_requested','withdrawn'),
    ('resubmitted','under_initial_review'),('resubmitted','commercial_review'),('resubmitted','legal_review'),('resubmitted','security_review'),('resubmitted','technical_review'),('resubmitted','rejected'),('resubmitted','withdrawn'),
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

CREATE OR REPLACE FUNCTION control.guard_onboarding_application_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT control.onboarding_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'INVALID_APPLICATION_STATE_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('draft','email_verification_pending','email_verified','additional_information_requested','resubmitted') AND NEW.applicant_visible_profile IS DISTINCT FROM OLD.applicant_visible_profile THEN
    RAISE EXCEPTION 'SUBMITTED_APPLICATION_IS_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  NEW.status_version := OLD.status_version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_application_update_guard
BEFORE UPDATE ON control.onboarding_applications
FOR EACH ROW EXECUTE FUNCTION control.guard_onboarding_application_update();

CREATE OR REPLACE FUNCTION control.protect_onboarding_version() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ONBOARDING_VERSION_IS_IMMUTABLE' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER onboarding_application_versions_immutable
BEFORE UPDATE OR DELETE ON control.onboarding_application_versions
FOR EACH ROW EXECUTE FUNCTION control.protect_onboarding_version();

CREATE OR REPLACE FUNCTION control.prevent_activation_self_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE initiator uuid;
BEGIN
  SELECT requested_by INTO initiator FROM control.tenant_activation_requests WHERE id = NEW.activation_request_id FOR UPDATE;
  IF initiator IS NULL THEN RAISE EXCEPTION 'ACTIVATION_REQUEST_NOT_FOUND'; END IF;
  IF initiator = NEW.approver_id THEN RAISE EXCEPTION 'TWO_PERSON_APPROVAL_REQUIRED' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_activation_no_self_approval
BEFORE INSERT ON control.tenant_activation_approvals
FOR EACH ROW EXECUTE FUNCTION control.prevent_activation_self_approval();

REVOKE ALL ON ALL TABLES IN SCHEMA control FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control FROM PUBLIC;
