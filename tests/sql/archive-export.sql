\set ON_ERROR_STOP on
-- Proves that an archive export cannot claim more than it delivered.
--
-- The failure this guards against is specific: a row saying 'completed' with no
-- record of which bytes left the system, or a package recorded as
-- schema-validated when only its structure was ever checked.

BEGIN;

SELECT set_config('app.actor_kind', 'worker', true);
SELECT set_config('app.tenant_id', '66666666-6666-4666-8666-666666666666', true);

\set tenant '''66666666-6666-4666-8666-666666666666'''
\set caseid '''66666666-1111-4666-8666-666666666666'''
\set userid '''66666666-2222-4666-8666-666666666666'''
\set policyid '''66666666-3333-4666-8666-666666666666'''
\set packageid '''66666666-4444-4666-8666-666666666666'''
\set exportid '''66666666-5555-4666-8666-666666666666'''
\set hash '''1111111111111111111111111111111111111111111111111111111111111111'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '66666666-0000-4666-8666-666666666666', 'Kungalvs kommun');
INSERT INTO app.users (tenant_id, id, external_subject, display_name)
VALUES (:tenant, :userid, 'subject-arch', 'Arkivarie');
INSERT INTO app.signature_policies (tenant_id, id, version, name, decision_mode, policy, active, created_by)
VALUES (:tenant, :policyid, 1, 'AES', 'ELECTRONIC_SIGNATURE', '{"requiredPadesLevel":"B"}'::jsonb, true, :userid);
INSERT INTO app.signature_cases (tenant_id, id, created_by, title, decision_mode, policy_id, policy_version, policy_snapshot, status)
VALUES (:tenant, :caseid, :userid, 'Beslut', 'ELECTRONIC_SIGNATURE', :policyid, 1, '{"requiredPadesLevel":"B"}'::jsonb, 'draft');
INSERT INTO app.evidence_packages (tenant_id, id, signature_case_id, object_key, manifest_sha256, status)
VALUES (:tenant, :packageid, :caseid, 'evidence.zip', :hash, 'ready');

INSERT INTO app.archive_exports (tenant_id, id, signature_case_id, evidence_package_id, archive_profile_version, status)
VALUES (:tenant, :exportid, :caseid, :packageid, 1, 'exporting');

-- ===========================================================================
-- 1. A completed export must name the bytes it delivered.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.archive_exports SET status='completed', completed_at=now()
     WHERE tenant_id='66666666-6666-4666-8666-666666666666' AND id='66666666-5555-4666-8666-666666666666';
    RAISE EXCEPTION 'GUARD FAILED: an export completed without recording what it produced';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('must record its package, descriptor and specification' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 2. A completed export must record when it completed.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.archive_exports
       SET status='completed',
           package_object_key='archive/sip.zip',
           package_sha256='1111111111111111111111111111111111111111111111111111111111111111',
           descriptor_object_key='archive/sip.xml',
           descriptor_sha256='2222222222222222222222222222222222222222222222222222222222222222',
           specification='RAFGS1V1.2',
           profile_uri='http://xml.ra.se/e-arkiv/METS/CommonSpecificationSwedenPackageProfile.xml'
     WHERE tenant_id='66666666-6666-4666-8666-666666666666' AND id='66666666-5555-4666-8666-666666666666';
    RAISE EXCEPTION 'GUARD FAILED: an export completed with no completion time';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('must record when it completed' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 3. A fully described export is allowed, and defaults to not schema-validated.
--    Structural conformance to the published profile is not the same claim as
--    validation against the receiving archive's XSD set.
-- ===========================================================================
UPDATE app.archive_exports
   SET status='completed', completed_at=now(),
       package_object_key='archive/sip.zip',
       package_sha256='1111111111111111111111111111111111111111111111111111111111111111',
       descriptor_object_key='archive/sip.xml',
       descriptor_sha256='2222222222222222222222222222222222222222222222222222222222222222',
       manifest_sha256='3333333333333333333333333333333333333333333333333333333333333333',
       specification='RAFGS1V1.2',
       profile_uri='http://xml.ra.se/e-arkiv/METS/CommonSpecificationSwedenPackageProfile.xml'
 WHERE tenant_id=:tenant AND id=:exportid;

DO $$ BEGIN
  IF (SELECT schema_validated FROM app.archive_exports WHERE tenant_id='66666666-6666-4666-8666-666666666666' AND id='66666666-5555-4666-8666-666666666666') <> false THEN
    RAISE EXCEPTION 'GUARD FAILED: schema validation was assumed rather than recorded';
  END IF;
  IF (SELECT status FROM app.archive_exports WHERE tenant_id='66666666-6666-4666-8666-666666666666' AND id='66666666-5555-4666-8666-666666666666') <> 'completed' THEN
    RAISE EXCEPTION 'GUARD FAILED: a fully described export could not complete';
  END IF;
END $$;

-- ===========================================================================
-- 4. One export per case per profile version: two answers to "what was
--    delivered" would leave nothing to choose between them.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.archive_exports (tenant_id, signature_case_id, evidence_package_id, archive_profile_version, status)
    VALUES ('66666666-6666-4666-8666-666666666666', '66666666-1111-4666-8666-666666666666',
            '66666666-4444-4666-8666-666666666666', 1, 'queued');
    RAISE EXCEPTION 'GUARD FAILED: a second export was created for the same case and profile version';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- A different profile version is a different package and is allowed.
INSERT INTO app.archive_exports (tenant_id, signature_case_id, evidence_package_id, archive_profile_version, status)
VALUES (:tenant, :caseid, :packageid, 2, 'queued');

SELECT 'archive export guards: OK' AS result;

ROLLBACK;
