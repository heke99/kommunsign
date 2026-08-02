-- Purpose: tamper-evident audit, durable jobs, outbox, API idempotency, webhook and archive records.
CREATE TABLE audit.audit_chain_heads (
  tenant_id uuid PRIMARY KEY,
  last_sequence bigint NOT NULL DEFAULT 0,
  last_event_hash text NOT NULL DEFAULT repeat('0', 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit.audit_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sequence bigint NOT NULL,
  category text NOT NULL CHECK (category IN ('TECHNICAL','BUSINESS')),
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  resource_type text,
  resource_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_event_hash text NOT NULL,
  event_hash text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
CREATE TABLE app.outbox_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE app.durable_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status app.job_status NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  maximum_attempts integer NOT NULL DEFAULT 10,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, job_type, idempotency_key)
);
CREATE TABLE app.api_clients (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  secret_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  mtls_certificate_thumbprint text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (client_id)
);
CREATE TABLE app.api_idempotency_keys (
  tenant_id uuid NOT NULL,
  api_client_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  request_payload_sha256 text NOT NULL,
  response_status integer,
  response_body jsonb,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, api_client_id, idempotency_key),
  FOREIGN KEY (tenant_id, api_client_id) REFERENCES app.api_clients(tenant_id, id)
);
CREATE TABLE app.webhook_endpoints (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  url text NOT NULL,
  subscribed_events text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  secret_current_ref text NOT NULL,
  secret_previous_ref text,
  previous_valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE app.webhook_deliveries (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  webhook_endpoint_id uuid NOT NULL,
  outbox_event_id uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('pending','delivering','delivered','failed','dead_letter')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  response_body_sha256 text,
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, webhook_endpoint_id, outbox_event_id),
  FOREIGN KEY (tenant_id, webhook_endpoint_id) REFERENCES app.webhook_endpoints(tenant_id, id),
  FOREIGN KEY (tenant_id, outbox_event_id) REFERENCES app.outbox_events(tenant_id, id)
);
CREATE TABLE app.evidence_packages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  object_key text NOT NULL,
  manifest_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('preparing','ready','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id)
);
CREATE TABLE app.archive_exports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  evidence_package_id uuid NOT NULL,
  archive_profile_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','exporting','completed','failed')),
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_package_id) REFERENCES app.evidence_packages(tenant_id, id)
);
CREATE TABLE app.legal_holds (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  signature_case_id uuid NOT NULL,
  reason text NOT NULL,
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_case_id) REFERENCES app.signature_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, placed_by) REFERENCES app.users(tenant_id, id),
  FOREIGN KEY (tenant_id, released_by) REFERENCES app.users(tenant_id, id)
);
CREATE TABLE app.usage_records (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  usage_type text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity >= 0),
  source_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  billing_period text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, usage_type, source_id)
);
