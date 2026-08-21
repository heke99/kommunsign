-- Purpose: index every foreign key in the data plane that has no covering index, and drop one exact duplicate index.
-- Impact: every table is PRIMARY KEY (tenant_id,id) with composite foreign keys on (tenant_id,<parent>_id). PostgreSQL does
--   not index foreign key child columns automatically, and a (tenant_id,id) primary key does not cover (tenant_id,parent_id),
--   so each of these 66 foreign keys forced a sequential scan on every join through the parent and on every parent delete.
--   Indexes are built concurrently, so reads and writes stay available while they build.
-- Backfill: PostgreSQL builds each index from existing table contents online; no row mutation or application data backfill.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS each index created here; recreate app.durable_jobs_enqueue_idempotency_idx to
--   undo the duplicate removal.
-- Verification: select indexrelid::regclass from pg_index where not indisvalid must return no rows, and the Supabase
--   performance advisor must report zero unindexed_foreign_keys for schema app.
-- Transaction: none

-- Note for future readers: the Supabase advisor also reports ~13 "unused index" findings on this database. They are not
-- acted on here. These tables are still near-empty, so an index that has never been scanned has simply never been needed
-- yet; most of them cover worker claim and retry paths. Do not drop them on the strength of that advisory.

-- app.durable_jobs_enqueue_idempotency_idx duplicates the constraint-backed index
-- durable_jobs_tenant_id_job_type_idempotency_key_key exactly. The constraint keeps its index; only the redundant plain
-- index is dropped, so the uniqueness guarantee is unchanged.
DROP INDEX CONCURRENTLY IF EXISTS app.durable_jobs_enqueue_idempotency_idx;

DROP INDEX CONCURRENTLY IF EXISTS app.archive_exports_evidence_package_id_fk_idx;
CREATE INDEX CONCURRENTLY archive_exports_evidence_package_id_fk_idx
  ON app.archive_exports(tenant_id,evidence_package_id);

DROP INDEX CONCURRENTLY IF EXISTS app.archive_exports_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY archive_exports_signature_case_id_fk_idx
  ON app.archive_exports(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.certificate_chains_signature_artifact_id_fk_idx;
CREATE INDEX CONCURRENTLY certificate_chains_signature_artifact_id_fk_idx
  ON app.certificate_chains(tenant_id,signature_artifact_id);

DROP INDEX CONCURRENTLY IF EXISTS app.crl_evidence_signature_artifact_id_fk_idx;
CREATE INDEX CONCURRENTLY crl_evidence_signature_artifact_id_fk_idx
  ON app.crl_evidence(tenant_id,signature_artifact_id);

DROP INDEX CONCURRENTLY IF EXISTS app.departments_organization_id_fk_idx;
CREATE INDEX CONCURRENTLY departments_organization_id_fk_idx
  ON app.departments(tenant_id,organization_id);

DROP INDEX CONCURRENTLY IF EXISTS app.digital_approval_evidence_authenticated_user_id_fk_idx;
CREATE INDEX CONCURRENTLY digital_approval_evidence_authenticated_user_id_fk_idx
  ON app.digital_approval_evidence(tenant_id,authenticated_user_id);

DROP INDEX CONCURRENTLY IF EXISTS app.digital_approval_evidence_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY digital_approval_evidence_document_version_id_fk_idx
  ON app.digital_approval_evidence(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.digital_approval_evidence_identity_transaction_id_fk_idx;
CREATE INDEX CONCURRENTLY digital_approval_evidence_identity_transaction_id_fk_idx
  ON app.digital_approval_evidence(tenant_id,identity_transaction_id);

DROP INDEX CONCURRENTLY IF EXISTS app.digital_approval_evidence_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY digital_approval_evidence_signature_case_id_fk_idx
  ON app.digital_approval_evidence(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.document_fields_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY document_fields_document_version_id_fk_idx
  ON app.document_fields(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.document_fields_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY document_fields_signer_id_fk_idx
  ON app.document_fields(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.document_render_snapshots_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY document_render_snapshots_document_version_id_fk_idx
  ON app.document_render_snapshots(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.document_scan_results_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY document_scan_results_document_version_id_fk_idx
  ON app.document_scan_results(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.email_messages_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY email_messages_signature_case_id_fk_idx
  ON app.email_messages(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.email_messages_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY email_messages_signer_id_fk_idx
  ON app.email_messages(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.email_provider_events_email_message_id_fk_idx;
CREATE INDEX CONCURRENTLY email_provider_events_email_message_id_fk_idx
  ON app.email_provider_events(tenant_id,email_message_id);

DROP INDEX CONCURRENTLY IF EXISTS app.evidence_packages_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY evidence_packages_signer_id_fk_idx
  ON app.evidence_packages(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.external_signature_transactions_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY external_signature_transactions_document_version_id_fk_idx
  ON app.external_signature_transactions(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.external_signature_transactions_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY external_signature_transactions_signature_case_id_fk_idx
  ON app.external_signature_transactions(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.external_signature_transactions_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY external_signature_transactions_signer_id_fk_idx
  ON app.external_signature_transactions(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.freja_identity_artifacts_signing_intent_id_fk_idx;
CREATE INDEX CONCURRENTLY freja_identity_artifacts_signing_intent_id_fk_idx
  ON app.freja_identity_artifacts(tenant_id,signing_intent_id);

DROP INDEX CONCURRENTLY IF EXISTS app.identity_provider_events_identity_transaction_id_fk_idx;
CREATE INDEX CONCURRENTLY identity_provider_events_identity_transaction_id_fk_idx
  ON app.identity_provider_events(tenant_id,identity_transaction_id);

DROP INDEX CONCURRENTLY IF EXISTS app.identity_transactions_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY identity_transactions_document_version_id_fk_idx
  ON app.identity_transactions(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.identity_transactions_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY identity_transactions_signer_id_fk_idx
  ON app.identity_transactions(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.legal_holds_placed_by_fk_idx;
CREATE INDEX CONCURRENTLY legal_holds_placed_by_fk_idx
  ON app.legal_holds(tenant_id,placed_by);

DROP INDEX CONCURRENTLY IF EXISTS app.legal_holds_released_by_fk_idx;
CREATE INDEX CONCURRENTLY legal_holds_released_by_fk_idx
  ON app.legal_holds(tenant_id,released_by);

DROP INDEX CONCURRENTLY IF EXISTS app.legal_holds_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY legal_holds_signature_case_id_fk_idx
  ON app.legal_holds(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.memberships_department_id_fk_idx;
CREATE INDEX CONCURRENTLY memberships_department_id_fk_idx
  ON app.memberships(tenant_id,department_id);

DROP INDEX CONCURRENTLY IF EXISTS app.memberships_user_id_fk_idx;
CREATE INDEX CONCURRENTLY memberships_user_id_fk_idx
  ON app.memberships(tenant_id,user_id);

DROP INDEX CONCURRENTLY IF EXISTS app.notification_deliveries_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY notification_deliveries_signer_id_fk_idx
  ON app.notification_deliveries(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.notification_deliveries_template_id_fk_idx;
CREATE INDEX CONCURRENTLY notification_deliveries_template_id_fk_idx
  ON app.notification_deliveries(tenant_id,template_id);

DROP INDEX CONCURRENTLY IF EXISTS app.ocsp_evidence_signature_artifact_id_fk_idx;
CREATE INDEX CONCURRENTLY ocsp_evidence_signature_artifact_id_fk_idx
  ON app.ocsp_evidence(tenant_id,signature_artifact_id);

DROP INDEX CONCURRENTLY IF EXISTS app.reminder_schedules_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY reminder_schedules_signature_case_id_fk_idx
  ON app.reminder_schedules(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.reminder_schedules_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY reminder_schedules_signer_id_fk_idx
  ON app.reminder_schedules(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.retention_jobs_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY retention_jobs_signature_case_id_fk_idx
  ON app.retention_jobs(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.role_assignments_department_id_fk_idx;
CREATE INDEX CONCURRENTLY role_assignments_department_id_fk_idx
  ON app.role_assignments(tenant_id,department_id);

DROP INDEX CONCURRENTLY IF EXISTS app.role_assignments_membership_id_fk_idx;
CREATE INDEX CONCURRENTLY role_assignments_membership_id_fk_idx
  ON app.role_assignments(tenant_id,membership_id);

DROP INDEX CONCURRENTLY IF EXISTS app.role_assignments_role_id_fk_idx;
CREATE INDEX CONCURRENTLY role_assignments_role_id_fk_idx
  ON app.role_assignments(tenant_id,role_id);

DROP INDEX CONCURRENTLY IF EXISTS app.scim_group_role_mappings_role_id_fk_idx;
CREATE INDEX CONCURRENTLY scim_group_role_mappings_role_id_fk_idx
  ON app.scim_group_role_mappings(tenant_id,role_id);

DROP INDEX CONCURRENTLY IF EXISTS app.scim_provisioning_events_client_id_fk_idx;
CREATE INDEX CONCURRENTLY scim_provisioning_events_client_id_fk_idx
  ON app.scim_provisioning_events(tenant_id,client_id);

-- Not created: 0021 already indexes app.signature_artifacts(tenant_id,signature_attempt_id) as signature_artifacts_attempt_idx.
-- This foreign key looked uncovered only because that migration is not yet applied to the
-- environment this file was generated against. The DROP stays so an environment where this
-- index was created ahead of 0021 ends up with one index rather than two identical ones.
DROP INDEX CONCURRENTLY IF EXISTS app.signature_artifacts_signature_attempt_id_fk_idx;

DROP INDEX CONCURRENTLY IF EXISTS app.signature_attempts_document_version_id_fk_idx;
CREATE INDEX CONCURRENTLY signature_attempts_document_version_id_fk_idx
  ON app.signature_attempts(tenant_id,document_version_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_attempts_identity_transaction_id_fk_idx;
CREATE INDEX CONCURRENTLY signature_attempts_identity_transaction_id_fk_idx
  ON app.signature_attempts(tenant_id,identity_transaction_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_case_participants_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY signature_case_participants_signature_case_id_fk_idx
  ON app.signature_case_participants(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_case_references_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY signature_case_references_signature_case_id_fk_idx
  ON app.signature_case_references(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_cases_created_by_fk_idx;
CREATE INDEX CONCURRENTLY signature_cases_created_by_fk_idx
  ON app.signature_cases(tenant_id,created_by);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_cases_department_id_fk_idx;
CREATE INDEX CONCURRENTLY signature_cases_department_id_fk_idx
  ON app.signature_cases(tenant_id,department_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_cases_policy_id_policy_version_fk_idx;
CREATE INDEX CONCURRENTLY signature_cases_policy_id_policy_version_fk_idx
  ON app.signature_cases(tenant_id,policy_id,policy_version);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_certificates_signature_artifact_id_fk_idx;
CREATE INDEX CONCURRENTLY signature_certificates_signature_artifact_id_fk_idx
  ON app.signature_certificates(tenant_id,signature_artifact_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signature_policies_created_by_fk_idx;
CREATE INDEX CONCURRENTLY signature_policies_created_by_fk_idx
  ON app.signature_policies(tenant_id,created_by);

DROP INDEX CONCURRENTLY IF EXISTS app.signer_invitations_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY signer_invitations_signer_id_fk_idx
  ON app.signer_invitations(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signer_requirements_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY signer_requirements_signer_id_fk_idx
  ON app.signer_requirements(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signer_sessions_invitation_id_fk_idx;
CREATE INDEX CONCURRENTLY signer_sessions_invitation_id_fk_idx
  ON app.signer_sessions(tenant_id,invitation_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signer_sessions_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY signer_sessions_signer_id_fk_idx
  ON app.signer_sessions(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signers_identifier_binding_exception_approved_by_fk_idx;
CREATE INDEX CONCURRENTLY signers_identifier_binding_exception_approved_by_fk_idx
  ON app.signers(tenant_id,identifier_binding_exception_approved_by);

-- Not created: 0021 already indexes app.signing_intent_documents(tenant_id,document_version_id) as signing_intent_documents_version_idx.
-- This foreign key looked uncovered only because that migration is not yet applied to the
-- environment this file was generated against. The DROP stays so an environment where this
-- index was created ahead of 0021 ends up with one index rather than two identical ones.
DROP INDEX CONCURRENTLY IF EXISTS app.signing_intent_documents_document_version_id_fk_idx;

DROP INDEX CONCURRENTLY IF EXISTS app.signing_intents_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY signing_intents_signer_id_fk_idx
  ON app.signing_intents(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.signing_provider_configs_updated_by_fk_idx;
CREATE INDEX CONCURRENTLY signing_provider_configs_updated_by_fk_idx
  ON app.signing_provider_configs(tenant_id,updated_by);

DROP INDEX CONCURRENTLY IF EXISTS app.signing_steps_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY signing_steps_signer_id_fk_idx
  ON app.signing_steps(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.tenant_signing_settings_updated_by_fk_idx;
CREATE INDEX CONCURRENTLY tenant_signing_settings_updated_by_fk_idx
  ON app.tenant_signing_settings(tenant_id,updated_by);

DROP INDEX CONCURRENTLY IF EXISTS app.tic_identity_artifacts_signing_intent_id_fk_idx;
CREATE INDEX CONCURRENTLY tic_identity_artifacts_signing_intent_id_fk_idx
  ON app.tic_identity_artifacts(tenant_id,signing_intent_id);

DROP INDEX CONCURRENTLY IF EXISTS app.timestamp_tokens_signature_artifact_id_fk_idx;
CREATE INDEX CONCURRENTLY timestamp_tokens_signature_artifact_id_fk_idx
  ON app.timestamp_tokens(tenant_id,signature_artifact_id);

DROP INDEX CONCURRENTLY IF EXISTS app.upload_grants_created_by_fk_idx;
CREATE INDEX CONCURRENTLY upload_grants_created_by_fk_idx
  ON app.upload_grants(tenant_id,created_by);

DROP INDEX CONCURRENTLY IF EXISTS app.validation_results_validation_run_id_fk_idx;
CREATE INDEX CONCURRENTLY validation_results_validation_run_id_fk_idx
  ON app.validation_results(tenant_id,validation_run_id);

DROP INDEX CONCURRENTLY IF EXISTS app.validation_runs_signature_artifact_id_fk_idx;
CREATE INDEX CONCURRENTLY validation_runs_signature_artifact_id_fk_idx
  ON app.validation_runs(tenant_id,signature_artifact_id);

DROP INDEX CONCURRENTLY IF EXISTS app.webhook_deliveries_outbox_event_id_fk_idx;
CREATE INDEX CONCURRENTLY webhook_deliveries_outbox_event_id_fk_idx
  ON app.webhook_deliveries(tenant_id,outbox_event_id);

-- The indexes above were derived from the schema as deployed, which is currently migrated through
-- 0020. Migrations 0021 to 0029 are still pending and add further tables whose composite foreign
-- keys are equally uncovered; none of those migrations declares an index for them. Because this file
-- runs after them, those tables exist by the time these statements execute, so they are indexed here
-- rather than leaving the gap to reappear the moment the deployment catches up.

DROP INDEX CONCURRENTLY IF EXISTS app.document_download_events_grant_id_fk_idx;
CREATE INDEX CONCURRENTLY document_download_events_grant_id_fk_idx
  ON app.document_download_events(tenant_id,grant_id);

DROP INDEX CONCURRENTLY IF EXISTS app.document_download_grants_signature_case_id_fk_idx;
CREATE INDEX CONCURRENTLY document_download_grants_signature_case_id_fk_idx
  ON app.document_download_grants(tenant_id,signature_case_id);

DROP INDEX CONCURRENTLY IF EXISTS app.document_download_grants_signer_id_fk_idx;
CREATE INDEX CONCURRENTLY document_download_grants_signer_id_fk_idx
  ON app.document_download_grants(tenant_id,signer_id);

DROP INDEX CONCURRENTLY IF EXISTS app.gallring_jobs_approved_by_fk_idx;
CREATE INDEX CONCURRENTLY gallring_jobs_approved_by_fk_idx
  ON app.gallring_jobs(tenant_id,approved_by);

DROP INDEX CONCURRENTLY IF EXISTS app.gallring_jobs_requested_by_fk_idx;
CREATE INDEX CONCURRENTLY gallring_jobs_requested_by_fk_idx
  ON app.gallring_jobs(tenant_id,requested_by);

DROP INDEX CONCURRENTLY IF EXISTS app.gallring_reports_gallring_job_id_fk_idx;
CREATE INDEX CONCURRENTLY gallring_reports_gallring_job_id_fk_idx
  ON app.gallring_reports(tenant_id,gallring_job_id);

DROP INDEX CONCURRENTLY IF EXISTS app.key_rotation_columns_key_rotation_id_fk_idx;
CREATE INDEX CONCURRENTLY key_rotation_columns_key_rotation_id_fk_idx
  ON app.key_rotation_columns(tenant_id,key_rotation_id);

DROP INDEX CONCURRENTLY IF EXISTS app.key_rotations_requested_by_fk_idx;
CREATE INDEX CONCURRENTLY key_rotations_requested_by_fk_idx
  ON app.key_rotations(tenant_id,requested_by);

DROP INDEX CONCURRENTLY IF EXISTS app.privacy_request_coverage_privacy_request_id_fk_idx;
CREATE INDEX CONCURRENTLY privacy_request_coverage_privacy_request_id_fk_idx
  ON app.privacy_request_coverage(tenant_id,privacy_request_id);

DROP INDEX CONCURRENTLY IF EXISTS app.privacy_requests_handled_by_fk_idx;
CREATE INDEX CONCURRENTLY privacy_requests_handled_by_fk_idx
  ON app.privacy_requests(tenant_id,handled_by);

DROP INDEX CONCURRENTLY IF EXISTS app.privacy_requests_subject_user_id_fk_idx;
CREATE INDEX CONCURRENTLY privacy_requests_subject_user_id_fk_idx
  ON app.privacy_requests(tenant_id,subject_user_id);

DROP INDEX CONCURRENTLY IF EXISTS app.privacy_responses_privacy_request_id_fk_idx;
CREATE INDEX CONCURRENTLY privacy_responses_privacy_request_id_fk_idx
  ON app.privacy_responses(tenant_id,privacy_request_id);

DROP INDEX CONCURRENTLY IF EXISTS app.retention_policies_created_by_fk_idx;
CREATE INDEX CONCURRENTLY retention_policies_created_by_fk_idx
  ON app.retention_policies(tenant_id,created_by);

DROP INDEX CONCURRENTLY IF EXISTS app.signing_intent_manifests_signing_intent_id_fk_idx;
CREATE INDEX CONCURRENTLY signing_intent_manifests_signing_intent_id_fk_idx
  ON app.signing_intent_manifests(tenant_id,signing_intent_id);
