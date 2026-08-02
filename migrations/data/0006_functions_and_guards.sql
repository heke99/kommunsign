-- Purpose: server-only state guards, hash-chained audit append and durable job claims.
CREATE OR REPLACE FUNCTION app.prevent_client_terminal_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.actor_kind', true) = 'external_client'
     AND NEW.status::text IN ('signed','completed','validated','archived') THEN
    RAISE EXCEPTION 'terminal status requires verified server evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signature_case_terminal_guard
BEFORE UPDATE OF status ON app.signature_cases
FOR EACH ROW EXECUTE FUNCTION app.prevent_client_terminal_status();
CREATE TRIGGER signer_terminal_guard
BEFORE UPDATE OF status ON app.signers
FOR EACH ROW EXECUTE FUNCTION app.prevent_client_terminal_status();
CREATE TRIGGER document_terminal_guard
BEFORE UPDATE OF status ON app.document_versions
FOR EACH ROW EXECUTE FUNCTION app.prevent_client_terminal_status();

CREATE OR REPLACE FUNCTION audit.append_event(
  p_tenant_id uuid,
  p_category text,
  p_event_type text,
  p_actor_type text,
  p_actor_id uuid,
  p_resource_type text,
  p_resource_id uuid,
  p_payload jsonb,
  p_occurred_at timestamptz DEFAULT now()
) RETURNS audit.audit_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, app, pg_temp AS $$
DECLARE
  head audit.audit_chain_heads;
  next_hash text;
  inserted audit.audit_events;
BEGIN
  IF p_tenant_id <> app.current_tenant_id() THEN RAISE EXCEPTION 'tenant mismatch'; END IF;
  INSERT INTO audit.audit_chain_heads(tenant_id) VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO head FROM audit.audit_chain_heads WHERE tenant_id = p_tenant_id FOR UPDATE;
  next_hash := encode(digest(head.last_event_hash || p_payload::text || p_occurred_at::text || p_event_type, 'sha256'), 'hex');
  INSERT INTO audit.audit_events(tenant_id, sequence, category, event_type, actor_type, actor_id, resource_type, resource_id, payload, occurred_at, previous_event_hash, event_hash)
  VALUES (p_tenant_id, head.last_sequence + 1, p_category, p_event_type, p_actor_type, p_actor_id, p_resource_type, p_resource_id, p_payload, p_occurred_at, head.last_event_hash, next_hash)
  RETURNING * INTO inserted;
  UPDATE audit.audit_chain_heads SET last_sequence = inserted.sequence, last_event_hash = inserted.event_hash, updated_at = now() WHERE tenant_id = p_tenant_id;
  RETURN inserted;
END $$;

CREATE OR REPLACE FUNCTION app.claim_durable_jobs(p_worker text, p_limit integer, p_lease_seconds integer)
RETURNS SETOF app.durable_jobs
LANGUAGE sql AS $$
  UPDATE app.durable_jobs j
  SET status = 'leased', lease_owner = p_worker, lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE (j.tenant_id, j.id) IN (
    SELECT tenant_id, id FROM app.durable_jobs
    WHERE tenant_id = app.current_tenant_id()
      AND status = 'pending'
      AND available_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at < now())
    ORDER BY available_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING j.*
$$;

CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit.audit_events
FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
