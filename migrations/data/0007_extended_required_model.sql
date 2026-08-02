-- Purpose: complete the required domain model without weakening tenant isolation.
CREATE TABLE app.signature_case_participants (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signature_case_id uuid NOT NULL,
  participant_type text NOT NULL, participant_reference uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,signature_case_id) REFERENCES app.signature_cases(tenant_id,id)
);
CREATE TABLE app.signing_orders (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signature_case_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('parallel','sequential')), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,signature_case_id),
  FOREIGN KEY (tenant_id,signature_case_id) REFERENCES app.signature_cases(tenant_id,id)
);
CREATE TABLE app.signing_steps (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signing_order_id uuid NOT NULL, signer_id uuid NOT NULL,
  step_number integer NOT NULL CHECK (step_number > 0), status text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,signing_order_id,step_number),
  FOREIGN KEY (tenant_id,signing_order_id) REFERENCES app.signing_orders(tenant_id,id),
  FOREIGN KEY (tenant_id,signer_id) REFERENCES app.signers(tenant_id,id)
);
CREATE TABLE app.document_pages (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), document_version_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number > 0), width_points numeric NOT NULL, height_points numeric NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,document_version_id,page_number),
  FOREIGN KEY (tenant_id,document_version_id) REFERENCES app.document_versions(tenant_id,id)
);
CREATE TABLE app.document_render_snapshots (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), document_version_id uuid NOT NULL,
  renderer text NOT NULL, renderer_version text NOT NULL, object_key text NOT NULL, sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,document_version_id) REFERENCES app.document_versions(tenant_id,id)
);
CREATE TABLE app.signer_identifiers (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signer_id uuid NOT NULL,
  identifier_type text NOT NULL, ciphertext bytea NOT NULL, blind_index bytea NOT NULL, key_version integer NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,signer_id,identifier_type),
  FOREIGN KEY (tenant_id,signer_id) REFERENCES app.signers(tenant_id,id)
);
CREATE TABLE app.signer_requirements (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signer_id uuid NOT NULL,
  provider app.identity_provider NOT NULL, minimum_assurance_level text NOT NULL, requires_expected_subject boolean NOT NULL,
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,signer_id) REFERENCES app.signers(tenant_id,id)
);
CREATE TABLE app.signer_sessions (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signer_id uuid NOT NULL,
  invitation_id uuid NOT NULL, session_token_hash bytea NOT NULL, ip_metadata_ciphertext bytea,
  user_agent_hash bytea, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,session_token_hash),
  FOREIGN KEY (tenant_id,signer_id) REFERENCES app.signers(tenant_id,id),
  FOREIGN KEY (tenant_id,invitation_id) REFERENCES app.signer_invitations(tenant_id,id)
);
CREATE TABLE app.bankid_transactions (
  tenant_id uuid NOT NULL, identity_transaction_id uuid NOT NULL, tic_session_id text NOT NULL,
  order_reference text, visible_data_object_key text NOT NULL, non_visible_data_object_key text NOT NULL,
  signature_value_object_key text, ocsp_response_object_key text, tic_api_version text,
  PRIMARY KEY (tenant_id,identity_transaction_id),
  FOREIGN KEY (tenant_id,identity_transaction_id) REFERENCES app.identity_transactions(tenant_id,id)
);
CREATE TABLE app.freja_transactions (
  tenant_id uuid NOT NULL, identity_transaction_id uuid NOT NULL, transaction_reference text NOT NULL,
  relying_party_id text NOT NULL, subject_type text NOT NULL, min_registration_level text NOT NULL,
  jws_object_key text, jws_certificate_thumbprint text,
  PRIMARY KEY (tenant_id,identity_transaction_id),
  FOREIGN KEY (tenant_id,identity_transaction_id) REFERENCES app.identity_transactions(tenant_id,id)
);
CREATE TABLE app.certificate_chains (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signature_artifact_id uuid NOT NULL,
  chain_object_key text NOT NULL, chain_sha256 text NOT NULL, trust_anchor_summary text,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,signature_artifact_id) REFERENCES app.signature_artifacts(tenant_id,id)
);
CREATE TABLE app.trust_list_snapshots (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), source_uri text NOT NULL,
  sequence_number text, object_key text NOT NULL, sha256 text NOT NULL, fetched_at timestamptz NOT NULL,
  next_update timestamptz, PRIMARY KEY (tenant_id,id)
);
CREATE TABLE app.validation_results (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), validation_run_id uuid NOT NULL,
  signature_identifier text NOT NULL, indication app.validation_indication NOT NULL, sub_indications text[] NOT NULL DEFAULT '{}',
  diagnostic_data jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,validation_run_id) REFERENCES app.validation_runs(tenant_id,id)
);
CREATE TABLE app.validation_reports (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), validation_run_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('machine','human','diagnostic','simple')),
  object_key text NOT NULL, sha256 text NOT NULL, PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,validation_run_id,report_type),
  FOREIGN KEY (tenant_id,validation_run_id) REFERENCES app.validation_runs(tenant_id,id)
);
CREATE TABLE app.notification_templates (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), template_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0), locale text NOT NULL, subject_template text NOT NULL,
  body_template text NOT NULL, active boolean NOT NULL DEFAULT false, PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,template_key,version,locale)
);
CREATE TABLE app.notification_deliveries (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signer_id uuid,
  template_id uuid NOT NULL, channel text NOT NULL CHECK (channel IN ('email','sms','in_app')),
  provider_reference text, status text NOT NULL, payload_sha256 text NOT NULL,
  sent_at timestamptz, delivered_at timestamptz, PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,signer_id) REFERENCES app.signers(tenant_id,id),
  FOREIGN KEY (tenant_id,template_id) REFERENCES app.notification_templates(tenant_id,id)
);
CREATE TABLE app.reminder_schedules (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signature_case_id uuid NOT NULL,
  signer_id uuid, next_reminder_at timestamptz NOT NULL, interval_hours integer NOT NULL CHECK (interval_hours > 0),
  remaining_attempts integer NOT NULL CHECK (remaining_attempts >= 0), status text NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,signature_case_id) REFERENCES app.signature_cases(tenant_id,id),
  FOREIGN KEY (tenant_id,signer_id) REFERENCES app.signers(tenant_id,id)
);
CREATE TABLE app.api_client_scopes (
  tenant_id uuid NOT NULL, api_client_id uuid NOT NULL, scope text NOT NULL,
  PRIMARY KEY (tenant_id,api_client_id,scope), FOREIGN KEY (tenant_id,api_client_id) REFERENCES app.api_clients(tenant_id,id)
);
CREATE TABLE app.webhook_events (
  tenant_id uuid NOT NULL, id uuid NOT NULL, event_type text NOT NULL, occurred_at timestamptz NOT NULL,
  api_version text NOT NULL, payload jsonb NOT NULL, payload_sha256 text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE app.retention_jobs (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), signature_case_id uuid NOT NULL,
  retention_policy_key text NOT NULL, retention_policy_version integer NOT NULL, action text NOT NULL,
  scheduled_at timestamptz NOT NULL, status text NOT NULL, completed_at timestamptz,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,signature_case_id) REFERENCES app.signature_cases(tenant_id,id)
);
CREATE TABLE app.billing_periods (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), period_key text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('open','closed','invoiced')),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,period_key), CHECK (ends_at > starts_at)
);
