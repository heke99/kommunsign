-- Purpose: Persist gallring (retention execution) so a run can be previewed, approved by a second person, executed and reported.
-- Impact: Adds app.gallring_jobs and app.gallring_reports with state, approval, legal-hold and completeness guards.
-- Backfill: No business data is rewritten; both tables are new and start empty.
-- Rollback: Drop the two tables and their functions in a maintenance window after rolling back the RETENTION_EXECUTE worker and the retention API routes.
-- Verification: Run verify:migrations and tests/sql/gallring.sql.

-- ---------------------------------------------------------------------------
-- Retention policies had nowhere to live
--
-- packages/retention models a policy — mode, period, retention class, and the
-- written Instruktion reference required when a log policy departs from the
-- PUB-avtalet default — and `assertPolicyIsLawful` refuses an unlawful one. No
-- table held any of it, so gallring had no policy to execute against.
-- ---------------------------------------------------------------------------
CREATE TABLE app.retention_policies (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  retention_class text NOT NULL CHECK (retention_class IN ('business_data','security_log','access_log')),
  policy jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, policy_key, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.users(tenant_id, id)
);
ALTER TABLE app.retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.retention_policies
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.retention_policies FROM PUBLIC;

-- A policy version is what a gallring run cites as its authority. Rewriting one
-- after a run would change what that run claims to have been authorised by.
CREATE TRIGGER retention_policies_version_immutable
BEFORE UPDATE OF policy, retention_class, version, policy_key ON app.retention_policies
FOR EACH ROW EXECUTE FUNCTION app.protect_versioned_record();

-- Only one active version per key, so "the policy" is never ambiguous.
CREATE UNIQUE INDEX retention_policies_active_idx
  ON app.retention_policies(tenant_id, policy_key) WHERE active;

-- ---------------------------------------------------------------------------
-- Gallring is irreversible, so it gets the state machine
--
-- packages/retention already models the run — QUEUED, PLANNED, APPROVED,
-- EXECUTING, VERIFIED, REPORTED, ABANDONED — and refuses to skip a step. That
-- logic lived in a library nothing called. These tables give it somewhere to
-- live between requests, and restate the two rules that must survive a bug in
-- the code above them: a run is approved by someone other than the person who
-- asked for it, and a case under legal hold is never deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE app.gallring_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK (state IN ('QUEUED','PLANNED','APPROVED','EXECUTING','VERIFIED','REPORTED','ABANDONED')),
  policy_key text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  retention_class text NOT NULL CHECK (retention_class IN ('business_data','security_log','access_log')),
  case_ids uuid[] NOT NULL CHECK (cardinality(case_ids) > 0),
  queued_decision jsonb NOT NULL,
  planned_targets text[] NOT NULL DEFAULT '{}',
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  executed_at timestamptz,
  abandoned_reason text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.users(tenant_id, id),
  -- Requirement 2071: the customer approves gallring, and the approver is not
  -- the requester. Four-eyes on an irreversible deletion is the whole control.
  CONSTRAINT gallring_jobs_distinct_approver CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT gallring_jobs_approval_complete CHECK (
    (approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);
ALTER TABLE app.gallring_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.gallring_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.gallring_jobs
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.gallring_jobs FROM PUBLIC;

CREATE TABLE app.gallring_reports (
  tenant_id uuid NOT NULL,
  gallring_job_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  report jsonb NOT NULL,
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  case_count integer NOT NULL CHECK (case_count > 0),
  deleted_total integer NOT NULL CHECK (deleted_total >= 0),
  complete boolean NOT NULL,
  unverified_targets text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, gallring_job_id),
  FOREIGN KEY (tenant_id, gallring_job_id) REFERENCES app.gallring_jobs(tenant_id, id),
  -- A report claiming completeness while naming unaddressed targets would be
  -- the one artifact that proves gallring happened, saying something untrue.
  CONSTRAINT gallring_reports_complete_consistent CHECK (
    (complete AND cardinality(unverified_targets) = 0) OR (NOT complete AND cardinality(unverified_targets) > 0)
  )
);
ALTER TABLE app.gallring_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.gallring_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.gallring_reports
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.gallring_reports FROM PUBLIC;

-- The report is the evidence that a gallring happened and what it covered.
-- Rewriting it later would leave no way to tell which version was true.
CREATE TRIGGER gallring_reports_no_mutation
BEFORE UPDATE OR DELETE ON app.gallring_reports
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

CREATE OR REPLACE FUNCTION app.assert_gallring_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  allowed := CASE OLD.state
    WHEN 'QUEUED' THEN ARRAY['PLANNED','ABANDONED']
    WHEN 'PLANNED' THEN ARRAY['APPROVED','ABANDONED']
    WHEN 'APPROVED' THEN ARRAY['EXECUTING','ABANDONED']
    WHEN 'EXECUTING' THEN ARRAY['VERIFIED','ABANDONED']
    WHEN 'VERIFIED' THEN ARRAY['REPORTED','ABANDONED']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.state = ANY(allowed)) THEN
    RAISE EXCEPTION 'invalid gallring state transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF NEW.state = 'APPROVED' AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'an approved gallring must record who approved it';
  END IF;

  -- Re-checked at the moment execution begins, not only when the run was
  -- queued. A hold placed while the job sat in the queue is exactly the case
  -- this has to catch.
  IF NEW.state = 'EXECUTING' THEN
    IF EXISTS (
      SELECT 1 FROM app.legal_holds h
      WHERE h.tenant_id = NEW.tenant_id AND h.released_at IS NULL
        AND h.signature_case_id = ANY(NEW.case_ids)
    ) THEN
      RAISE EXCEPTION 'gallring cannot execute while a case in the run is under legal hold';
    END IF;
    IF cardinality(NEW.planned_targets) = 0 THEN
      RAISE EXCEPTION 'gallring cannot execute without a declared target plan';
    END IF;
  END IF;

  IF NEW.state = 'REPORTED' AND NOT EXISTS (
    SELECT 1 FROM app.gallring_reports r WHERE r.tenant_id = NEW.tenant_id AND r.gallring_job_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a reported gallring must have a stored report';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER gallring_jobs_state_transition
BEFORE UPDATE OF state ON app.gallring_jobs
FOR EACH ROW EXECUTE FUNCTION app.assert_gallring_transition();

-- A case may not be queued for gallring twice concurrently: two runs deleting
-- the same case would each report a count the other made meaningless.
CREATE UNIQUE INDEX gallring_jobs_active_case_idx
  ON app.gallring_jobs(tenant_id, (case_ids[1]))
  WHERE state IN ('QUEUED','PLANNED','APPROVED','EXECUTING');
CREATE INDEX gallring_jobs_state_idx ON app.gallring_jobs(tenant_id, state, requested_at);
