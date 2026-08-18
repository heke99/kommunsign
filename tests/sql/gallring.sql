\set ON_ERROR_STOP on
-- Proves the controls around gallring, which is the one operation in this system
-- that cannot be undone. Each block corresponds to a way an irreversible
-- deletion could happen without the customer having actually authorised it.

BEGIN;

SELECT set_config('app.actor_kind', 'internal_user', true);
SELECT set_config('app.tenant_id', '12121212-1212-4121-8121-121212121212', true);

\set tenant '''12121212-1212-4121-8121-121212121212'''
\set requester '''12121212-1111-4121-8121-121212121212'''
\set approver '''12121212-2222-4121-8121-121212121212'''
\set policyid '''12121212-3333-4121-8121-121212121212'''
\set caseid '''12121212-4444-4121-8121-121212121212'''
\set heldcase '''12121212-5555-4121-8121-121212121212'''
\set jobid '''12121212-6666-4121-8121-121212121212'''
\set heldjob '''12121212-7777-4121-8121-121212121212'''
\set hash '''1111111111111111111111111111111111111111111111111111111111111111'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '12121212-0000-4121-8121-121212121212', 'Kungalvs kommun');
INSERT INTO app.users (tenant_id, id, external_subject, display_name) VALUES
  (:tenant, :requester, 'subject-req', 'Arkivarie'),
  (:tenant, :approver, 'subject-app', 'Dataskyddsombud');
INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'AES', 'ELECTRONIC_SIGNATURE', '{"requiredPadesLevel":"B"}'::jsonb, true, :requester);
INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status, completed_at) VALUES
  (:tenant, :caseid, :requester, 'Gammalt beslut', 'ELECTRONIC_SIGNATURE', :policyid, 1, '{}'::jsonb, 'draft', now() - interval '400 days'),
  (:tenant, :heldcase, :requester, 'Beslut under legal hold', 'ELECTRONIC_SIGNATURE', :policyid, 1, '{}'::jsonb, 'draft', now() - interval '400 days');

-- ===========================================================================
-- 1. A retention policy must exist before anything can be gallrat against it.
-- ===========================================================================
INSERT INTO app.retention_policies (tenant_id, policy_key, version, retention_class, policy, active, created_by)
VALUES (:tenant, 'case_default', 1, 'business_data',
        '{"policyKey":"case_default","version":1,"retentionClass":"business_data","mode":"DELETE_AFTER_PERIOD","periodDays":365,"active":true}'::jsonb,
        true, :requester);

-- Only one active version per key, so "the policy" is never ambiguous.
DO $$ BEGIN
  BEGIN
    INSERT INTO app.retention_policies (tenant_id, policy_key, version, retention_class, policy, active, created_by)
    VALUES ('12121212-1212-4121-8121-121212121212', 'case_default', 2, 'business_data', '{}'::jsonb, true, '12121212-1111-4121-8121-121212121212');
    RAISE EXCEPTION 'GUARD FAILED: two active versions of one retention policy were allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ===========================================================================
-- 2. The approver may not be the person who requested the gallring.
--    Four eyes on an irreversible deletion is the entire control.
-- ===========================================================================
INSERT INTO app.gallring_jobs (tenant_id, id, state, policy_key, policy_version, retention_class, case_ids, queued_decision, planned_targets, requested_by)
VALUES (:tenant, :jobid, 'PLANNED', 'case_default', 1, 'business_data', ARRAY[:caseid]::uuid[], '{}'::jsonb,
        ARRAY['signature_case','documents','document_versions','object_storage','evidence_packages','derived_renders','search_index','cache','notifications'], :requester);

DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_jobs SET state='APPROVED', approved_by='12121212-1111-4121-8121-121212121212', approved_at=now()
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND id='12121212-6666-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a gallring was approved by the person who requested it';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- ===========================================================================
-- 3. An approval must name who approved it.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_jobs SET state='APPROVED'
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND id='12121212-6666-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a gallring reached APPROVED with no approver recorded';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('must record who approved it' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- A different person approving is allowed.
UPDATE app.gallring_jobs SET state='APPROVED', approved_by=:approver, approved_at=now()
 WHERE tenant_id=:tenant AND id=:jobid;

-- ===========================================================================
-- 4. Legal hold stops execution, and it is re-checked at the moment execution
--    begins rather than only when the job was queued.
-- ===========================================================================
INSERT INTO app.gallring_jobs (tenant_id, id, state, policy_key, policy_version, retention_class, case_ids, queued_decision, planned_targets, requested_by, approved_by, approved_at)
VALUES (:tenant, :heldjob, 'APPROVED', 'case_default', 1, 'business_data', ARRAY[:heldcase]::uuid[], '{}'::jsonb,
        ARRAY['signature_case','documents'], :requester, :approver, now());

-- The hold is placed after the job was approved, exactly as it would be in the
-- window between approval and the worker picking the job up.
INSERT INTO app.legal_holds (tenant_id, signature_case_id, reason, placed_by)
VALUES (:tenant, :heldcase, 'Pagaende tillsynsarende', :requester);

DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_jobs SET state='EXECUTING', executed_at=now()
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND id='12121212-7777-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a gallring executed against a case under legal hold';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('legal hold' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 5. Execution requires a declared target plan, so an unaddressed store is
--    detectable in the report rather than merely absent from it.
-- ===========================================================================
UPDATE app.gallring_jobs SET planned_targets='{}' WHERE tenant_id=:tenant AND id=:jobid;
DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_jobs SET state='EXECUTING', executed_at=now()
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND id='12121212-6666-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a gallring executed with no declared targets';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('declared target plan' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

UPDATE app.gallring_jobs
   SET planned_targets=ARRAY['signature_case','documents','document_versions','object_storage','evidence_packages','derived_renders','search_index','cache','notifications']
 WHERE tenant_id=:tenant AND id=:jobid;
UPDATE app.gallring_jobs SET state='EXECUTING', executed_at=now() WHERE tenant_id=:tenant AND id=:jobid;

-- ===========================================================================
-- 6. A run cannot be reported before its report exists.
-- ===========================================================================
UPDATE app.gallring_jobs SET state='VERIFIED' WHERE tenant_id=:tenant AND id=:jobid;
DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_jobs SET state='REPORTED'
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND id='12121212-6666-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a gallring was reported with no stored report';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('must have a stored report' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 7. A report cannot claim completeness while naming unaddressed targets.
--    The report is the one artifact proving gallring happened; it must not be
--    the artifact that says something untrue.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.gallring_reports (tenant_id, gallring_job_id, schema_version, report, report_sha256, object_key, case_count, deleted_total, complete, unverified_targets)
    VALUES ('12121212-1212-4121-8121-121212121212', '12121212-6666-4121-8121-121212121212', 1, '{}'::jsonb,
            '1111111111111111111111111111111111111111111111111111111111111111', 'report.json', 1, 5, true, ARRAY['cache']);
    RAISE EXCEPTION 'GUARD FAILED: a report claimed completeness while naming an unaddressed target';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- An incomplete run must name what it could not verify.
DO $$ BEGIN
  BEGIN
    INSERT INTO app.gallring_reports (tenant_id, gallring_job_id, schema_version, report, report_sha256, object_key, case_count, deleted_total, complete, unverified_targets)
    VALUES ('12121212-1212-4121-8121-121212121212', '12121212-6666-4121-8121-121212121212', 1, '{}'::jsonb,
            '1111111111111111111111111111111111111111111111111111111111111111', 'report.json', 1, 5, false, ARRAY[]::text[]);
    RAISE EXCEPTION 'GUARD FAILED: an incomplete report named no unverified target';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO app.gallring_reports (tenant_id, gallring_job_id, schema_version, report, report_sha256, object_key, case_count, deleted_total, complete, unverified_targets)
VALUES (:tenant, :jobid, 1, '{"schemaVersion":1}'::jsonb, :hash, 'gallringsrapport.json', 1, 12, true, ARRAY[]::text[]);
UPDATE app.gallring_jobs SET state='REPORTED' WHERE tenant_id=:tenant AND id=:jobid;

-- ===========================================================================
-- 8. The report is evidence and cannot be rewritten afterwards.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_reports SET deleted_total=0
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND gallring_job_id='12121212-6666-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a gallring report was rewritten after the fact';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('append-only' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 9. A reported run is terminal; it cannot be walked back to execute again.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.gallring_jobs SET state='EXECUTING'
     WHERE tenant_id='12121212-1212-4121-8121-121212121212' AND id='12121212-6666-4121-8121-121212121212';
    RAISE EXCEPTION 'GUARD FAILED: a reported gallring was returned to EXECUTING';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('invalid gallring state transition' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

SELECT 'gallring guards: OK' AS result;

ROLLBACK;
