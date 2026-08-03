-- Run per tenant session after migrations.
SELECT app.current_tenant_id();
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname IN ('app','audit') AND rowsecurity IS NOT TRUE;
SELECT conrelid::regclass AS table_name, conname
FROM pg_constraint
WHERE contype = 'f' AND connamespace IN ('app'::regnamespace, 'audit'::regnamespace)
  AND pg_get_constraintdef(oid) NOT LIKE '%tenant_id%';

-- BankID production foundation invariants. These checks intentionally return zero rows on success.
SELECT schemaname, tablename, rowsecurity, forcrowsecurity
FROM pg_tables
WHERE schemaname='app'
  AND tablename IN ('signing_intents','signing_intent_documents','tic_identity_artifacts','document_processor_reports','provider_webhook_events','email_provider_events','evidence_package_files')
  AND (rowsecurity IS NOT TRUE OR forcrowsecurity IS NOT TRUE);

SELECT 'tenantless_signing_intent' AS violation, id::text AS resource_id
FROM app.signing_intents WHERE tenant_id IS NULL;

SELECT 'multiple_active_signing_intents' AS violation, signer_id::text AS resource_id
FROM app.signing_intents
WHERE status IN ('prepared','provider_started','evidence_collected')
GROUP BY tenant_id,signature_case_id,signer_id HAVING count(*)>1;

SELECT 'locked_document_without_canonical_hash' AS violation, id::text AS resource_id
FROM app.document_versions
WHERE status IN ('locked','partially_signed','signed','validated','archived')
  AND (sha256 IS NULL OR canonical_object_key IS NULL OR pdf_profile IS DISTINCT FROM 'PDF/A-2b');

SELECT 'strict_signer_missing_encrypted_identifier' AS violation, id::text AS resource_id
FROM app.signers
WHERE identifier_binding_mode='STRICT_PREBOUND'
  AND (expected_identifier_ciphertext IS NULL OR expected_identifier_blind_index IS NULL OR expected_identifier_type IS DISTINCT FROM 'SSN');

SELECT 'identifier_exception_missing_audit_actor_or_reason' AS violation, id::text AS resource_id
FROM app.signers
WHERE identifier_binding_mode='BANKID_DISCOVERED'
  AND (identifier_binding_exception_code IS NULL OR identifier_binding_exception_approved_by IS NULL OR identifier_binding_exception_at IS NULL
       OR (identifier_binding_exception_code='OTHER' AND identifier_binding_exception_reason_ciphertext IS NULL));

SELECT 'signed_signer_without_verified_tic_artifact' AS violation, s.id::text AS resource_id
FROM app.signers s
WHERE s.status='signed' AND NOT EXISTS (
  SELECT 1 FROM app.signing_intents si
  JOIN app.tic_identity_artifacts tia ON tia.tenant_id=si.tenant_id AND tia.signing_intent_id=si.id
  WHERE si.tenant_id=s.tenant_id AND si.signer_id=s.id AND tia.verification_result='PASS'
);

SELECT 'completed_case_without_ready_package' AS violation, c.id::text AS resource_id
FROM app.signature_cases c
WHERE c.status='completed' AND NOT EXISTS (
  SELECT 1 FROM app.evidence_packages ep
  WHERE ep.tenant_id=c.tenant_id AND ep.signature_case_id=c.id AND ep.signer_id IS NULL
    AND ep.status='ready' AND ep.package_sha256 IS NOT NULL
);
