-- Purpose: index every foreign key in the control plane that has no covering index, plus two hot-path indexes.
-- Impact: PostgreSQL does not index foreign key child columns automatically, so each of these 39 foreign keys forced a
--   sequential scan on every join through the parent and on every parent delete. Adds a session-revocation index and an
--   audit chain-head index that are read on the login and control-write paths. Indexes are built concurrently, so reads
--   and writes stay available while they build.
-- Backfill: PostgreSQL builds each index from existing table contents online; no row mutation or application data backfill.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS each index created here.
-- Verification: select indexrelid::regclass from pg_index where not indisvalid must return no rows, and the Supabase
--   performance advisor must report zero unindexed_foreign_keys for schema control.
-- Transaction: none

-- Note for future readers: the Supabase advisor also reports "unused index" findings on this database. They are not acted
-- on here. These tables are still near-empty, so an index that has never been scanned has simply never been needed yet.

-- Hot path, not a foreign key: revoking a subject's sessions filters on (tenant_id,subject_id),
-- which no existing index covered. The primary key is on token_hash and the only secondary index
-- is on (hostname,boundary,expires_at).
DROP INDEX CONCURRENTLY IF EXISTS control.host_bound_sessions_subject_idx;
CREATE INDEX CONCURRENTLY host_bound_sessions_subject_idx
  ON control.host_bound_sessions(tenant_id,subject_id) WHERE revoked_at IS NULL;

-- Hot path: every control-plane write takes a platform-wide advisory lock and then reads the
-- audit chain head with ORDER BY occurred_at DESC, id DESC LIMIT 1. Without this index that is a
-- sequential scan plus a top-N sort of a permanently growing table, executed under the lock.
DROP INDEX CONCURRENTLY IF EXISTS control.control_audit_events_chain_head_idx;
CREATE INDEX CONCURRENTLY control_audit_events_chain_head_idx
  ON control.control_audit_events(occurred_at DESC,id DESC);

DROP INDEX CONCURRENTLY IF EXISTS control.auth_authorization_codes_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY auth_authorization_codes_tenant_id_fk_idx
  ON control.auth_authorization_codes(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.auth_broker_transactions_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY auth_broker_transactions_tenant_id_fk_idx
  ON control.auth_broker_transactions(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.break_glass_requests_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY break_glass_requests_tenant_id_fk_idx
  ON control.break_glass_requests(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.control_audit_events_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY control_audit_events_tenant_id_fk_idx
  ON control.control_audit_events(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_certificate_snapshots_environment_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_certificate_snapshots_environment_id_fk_idx
  ON control.domain_certificate_snapshots(tenant_id,environment_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_certificate_snapshots_tenant_domain_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_certificate_snapshots_tenant_domain_id_fk_idx
  ON control.domain_certificate_snapshots(tenant_id,tenant_domain_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_health_checks_environment_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_health_checks_environment_id_fk_idx
  ON control.domain_health_checks(tenant_id,environment_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_health_checks_tenant_domain_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_health_checks_tenant_domain_id_fk_idx
  ON control.domain_health_checks(tenant_id,tenant_domain_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_provider_operations_environment_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_provider_operations_environment_id_fk_idx
  ON control.domain_provider_operations(tenant_id,environment_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_provider_operations_tenant_domain_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_provider_operations_tenant_domain_id_fk_idx
  ON control.domain_provider_operations(tenant_id,tenant_domain_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_provisioning_jobs_tenant_domain_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_provisioning_jobs_tenant_domain_id_fk_idx
  ON control.domain_provisioning_jobs(tenant_id,tenant_domain_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_verification_challenges_environment_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_verification_challenges_environment_id_fk_idx
  ON control.domain_verification_challenges(tenant_id,environment_id);

DROP INDEX CONCURRENTLY IF EXISTS control.domain_verification_challenges_tenant_domain_id_fk_idx;
CREATE INDEX CONCURRENTLY domain_verification_challenges_tenant_domain_id_fk_idx
  ON control.domain_verification_challenges(tenant_id,tenant_domain_id);

DROP INDEX CONCURRENTLY IF EXISTS control.host_bound_sessions_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY host_bound_sessions_tenant_id_fk_idx
  ON control.host_bound_sessions(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_access_tokens_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_access_tokens_application_id_fk_idx
  ON control.onboarding_access_tokens(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_application_contacts_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_application_contacts_application_id_fk_idx
  ON control.onboarding_application_contacts(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_application_documents_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_application_documents_application_id_fk_idx
  ON control.onboarding_application_documents(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_applications_duplicate_of_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_applications_duplicate_of_application_id_fk_idx
  ON control.onboarding_applications(duplicate_of_application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_applications_linked_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_applications_linked_tenant_id_fk_idx
  ON control.onboarding_applications(linked_tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_checklists_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_checklists_tenant_id_fk_idx
  ON control.onboarding_checklists(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_decisions_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_decisions_application_id_fk_idx
  ON control.onboarding_decisions(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_external_messages_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_external_messages_application_id_fk_idx
  ON control.onboarding_external_messages(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_information_requests_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_information_requests_application_id_fk_idx
  ON control.onboarding_information_requests(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_information_responses_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_information_responses_application_id_fk_idx
  ON control.onboarding_information_responses(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_information_responses_information_request_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_information_responses_information_request_id_fk_idx
  ON control.onboarding_information_responses(information_request_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_internal_notes_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_internal_notes_application_id_fk_idx
  ON control.onboarding_internal_notes(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_review_assignments_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_review_assignments_application_id_fk_idx
  ON control.onboarding_review_assignments(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_risk_assessments_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_risk_assessments_application_id_fk_idx
  ON control.onboarding_risk_assessments(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_task_dependencies_depends_on_task_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_task_dependencies_depends_on_task_id_fk_idx
  ON control.onboarding_task_dependencies(depends_on_task_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_tasks_application_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_tasks_application_id_fk_idx
  ON control.onboarding_tasks(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.onboarding_tasks_tenant_id_fk_idx;
CREATE INDEX CONCURRENTLY onboarding_tasks_tenant_id_fk_idx
  ON control.onboarding_tasks(tenant_id);

DROP INDEX CONCURRENTLY IF EXISTS control.organization_account_invitations_invited_by_fk_idx;
CREATE INDEX CONCURRENTLY organization_account_invitations_invited_by_fk_idx
  ON control.organization_account_invitations(invited_by);

DROP INDEX CONCURRENTLY IF EXISTS control.platform_role_assignments_granted_by_fk_idx;
CREATE INDEX CONCURRENTLY platform_role_assignments_granted_by_fk_idx
  ON control.platform_role_assignments(granted_by);

DROP INDEX CONCURRENTLY IF EXISTS control.tenant_activation_requests_application_id_fk_idx;
CREATE INDEX CONCURRENTLY tenant_activation_requests_application_id_fk_idx
  ON control.tenant_activation_requests(application_id);

DROP INDEX CONCURRENTLY IF EXISTS control.tenant_environments_data_plane_id_fk_idx;
CREATE INDEX CONCURRENTLY tenant_environments_data_plane_id_fk_idx
  ON control.tenant_environments(data_plane_id);

DROP INDEX CONCURRENTLY IF EXISTS control.tenant_primary_domain_history_environment_id_fk_idx;
CREATE INDEX CONCURRENTLY tenant_primary_domain_history_environment_id_fk_idx
  ON control.tenant_primary_domain_history(tenant_id,environment_id);

DROP INDEX CONCURRENTLY IF EXISTS control.tenant_primary_domain_history_tenant_domain_id_fk_idx;
CREATE INDEX CONCURRENTLY tenant_primary_domain_history_tenant_domain_id_fk_idx
  ON control.tenant_primary_domain_history(tenant_id,tenant_domain_id);

DROP INDEX CONCURRENTLY IF EXISTS control.tenant_provisioning_attempts_step_id_fk_idx;
CREATE INDEX CONCURRENTLY tenant_provisioning_attempts_step_id_fk_idx
  ON control.tenant_provisioning_attempts(step_id);

DROP INDEX CONCURRENTLY IF EXISTS control.tenant_readiness_results_activation_request_id_fk_idx;
CREATE INDEX CONCURRENTLY tenant_readiness_results_activation_request_id_fk_idx
  ON control.tenant_readiness_results(activation_request_id);
