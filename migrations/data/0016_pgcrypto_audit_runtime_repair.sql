-- Purpose: repair audit.append_event when pgcrypto is installed outside the function search_path, as in Supabase.
-- Impact: Replaces audit.append_event with an equivalent implementation that schema-qualifies pgcrypto.digest.
-- Backfill: No row backfill; existing audit events and chain heads are unchanged.
-- Rollback: Recreate the previous audit.append_event definition during a maintenance window.
-- Verification: Call audit.append_event inside a tenant-scoped rollback transaction and confirm no undefined-function error occurs.
DO $migration$
DECLARE
  pgcrypto_schema text;
BEGIN
  SELECT namespace.nspname
    INTO pgcrypto_schema
    FROM pg_extension extension
    JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'pgcrypto';

  IF pgcrypto_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto extension is required';
  END IF;

  EXECUTE format($definition$
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
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, audit, app, pg_temp
    AS $function$
    DECLARE
      head audit.audit_chain_heads;
      next_hash text;
      next_sequence bigint;
      canonical_payload jsonb;
      inserted audit.audit_events;
    BEGIN
      IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant mismatch';
      END IF;
      IF p_category NOT IN ('TECHNICAL','BUSINESS') THEN
        RAISE EXCEPTION 'invalid audit category';
      END IF;

      INSERT INTO audit.audit_chain_heads(tenant_id)
      VALUES (p_tenant_id)
      ON CONFLICT (tenant_id) DO NOTHING;

      SELECT *
        INTO head
        FROM audit.audit_chain_heads
       WHERE tenant_id = p_tenant_id
       FOR UPDATE;

      next_sequence := head.last_sequence + 1;
      canonical_payload := jsonb_build_object(
        'hashVersion', 2,
        'previousEventHash', head.last_event_hash,
        'tenantId', p_tenant_id,
        'sequence', next_sequence,
        'category', p_category,
        'eventType', p_event_type,
        'actorType', p_actor_type,
        'actorId', p_actor_id,
        'resourceType', p_resource_type,
        'resourceId', p_resource_id,
        'payload', p_payload,
        'occurredAt', to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      );

      next_hash := encode(%I.digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex');

      INSERT INTO audit.audit_events(
        tenant_id, sequence, category, event_type, actor_type, actor_id, resource_type, resource_id,
        payload, occurred_at, previous_event_hash, event_hash, hash_version, hash_material
      ) VALUES (
        p_tenant_id, next_sequence, p_category, p_event_type, p_actor_type, p_actor_id, p_resource_type,
        p_resource_id, p_payload, p_occurred_at, head.last_event_hash, next_hash, 2, canonical_payload::text
      )
      RETURNING * INTO inserted;

      UPDATE audit.audit_chain_heads
         SET last_sequence = inserted.sequence,
             last_event_hash = inserted.event_hash,
             updated_at = now()
       WHERE tenant_id = p_tenant_id;

      RETURN inserted;
    END
    $function$
  $definition$, pgcrypto_schema);
END
$migration$;

REVOKE ALL ON FUNCTION audit.append_event(uuid,text,text,text,uuid,text,uuid,jsonb,timestamptz) FROM PUBLIC;
