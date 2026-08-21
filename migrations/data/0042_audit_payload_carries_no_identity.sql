-- Purpose: Make AUDIT_LOG a channel that is enforced, not merely respected, for requirement 2028 and AGENTS.md rule 6.
-- Impact: audit.append_event refuses a payload whose keys name an identifying field; ten call sites are covered by one guard.
-- Backfill: None. Existing rows are untouched; the guard applies to new events only.
-- Rollback: Re-apply data/0016 verbatim in a maintenance window. The hash chain and its version are unchanged either way.
-- Verification: tests/sql/protected-identity.sql asserts that an identifying key is refused and an ordinary payload is accepted.

-- ---------------------------------------------------------------------------
-- The audit log is an output channel
--
-- packages/protected-identity lists AUDIT_LOG among the thirteen ways a
-- person's details can leave the system, and the disclosure table allows only
-- name and personal number there, only for the levels where a signature still
-- has to be provable. Nothing in the code puts either in an audit payload
-- today -- but "nothing does it today" is a description, and the next handler
-- that adds a helpful field would silently break the rule in a store that is
-- append-only and hash-chained, so the mistake could not be edited away.
--
-- The guard is on keys rather than on values. A value regex over the payload
-- text would have to distinguish a personal number from a SHA-256 digest that
-- happens to contain twelve digits in a row, which is common enough to make
-- the guard fire on correct data. A key called `email` is unambiguous.
--
-- The function body below is data/0016 verbatim apart from the added PERFORM:
-- the hash chain is version 2 and schema-qualifies pgcrypto, and rewriting it
-- from the older data/0006 definition would silently revert both.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit.assert_payload_carries_no_identity(p_payload jsonb, p_path text DEFAULT '$')
RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $guard$
DECLARE
  forbidden text[] := ARRAY[
    'personalnumber','personnummer','ssn','nationalid',
    'email','emailaddress','recipient','recipientemail',
    'address','postaladdress','streetaddress',
    'phone','phonenumber','telephone',
    'fullname','displayname','signername','givenname','surname'
  ];
  entry record;
BEGIN
  IF p_payload IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_payload) = 'object' THEN
    FOR entry IN SELECT key, value FROM jsonb_each(p_payload) LOOP
      IF lower(entry.key) = ANY (forbidden) THEN
        RAISE EXCEPTION 'audit payload must not carry an identifying field: %.%', p_path, entry.key;
      END IF;
      PERFORM audit.assert_payload_carries_no_identity(entry.value, p_path || '.' || entry.key);
    END LOOP;
  ELSIF jsonb_typeof(p_payload) = 'array' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(p_payload) LOOP
      PERFORM audit.assert_payload_carries_no_identity(entry.value, p_path || '[]');
    END LOOP;
  END IF;
END $guard$;

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
      PERFORM audit.assert_payload_carries_no_identity(p_payload);

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
