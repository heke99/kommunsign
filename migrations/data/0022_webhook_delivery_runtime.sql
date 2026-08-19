-- Purpose: Make webhook delivery real: give endpoints a verifiable signing secret, dispatch outbox events transactionally, and keep delivery state honest.
-- Impact: Adds encrypted secret columns and rotation timestamps to app.webhook_endpoints, a dispatch trigger on app.outbox_events, delivery guards and claim indexes.
-- Backfill: No business data is rewritten. Existing endpoints get NULL secret ciphertext and cannot deliver until a secret is issued, which is correct: they never had a usable secret and their subscribers could never have verified a signature.
-- Rollback: Drop the trigger, guards and indexes, then the added columns, in a maintenance window after rolling back the worker and API code that writes them.
-- Verification: Run verify:migrations and tests/sql/webhook-delivery.sql, plus the webhook tests in tests/run.mjs.

-- ---------------------------------------------------------------------------
-- Endpoints could never be verified by their subscribers
--
-- secret_current_ref held a `vault://...` placeholder that nothing resolves, and
-- the secret was never returned to the customer at creation. A receiver had no
-- value to check an HMAC against, so every delivery would have been an unsigned
-- POST that any party able to reach the URL could forge.
--
-- The secret is now generated at creation, handed back exactly once, and stored
-- encrypted through the same envelope adapter as every other sensitive value.
-- The *_ref columns are kept: they are how an external secret manager would be
-- addressed later, and dropping them now would make that a migration instead of
-- a configuration change.
-- ---------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  ADD COLUMN secret_current_ciphertext bytea,
  ADD COLUMN secret_previous_ciphertext bytea,
  ADD COLUMN secret_rotated_at timestamptz,
  ADD COLUMN disabled_reason text;

ALTER TABLE app.webhook_endpoints
  ADD CONSTRAINT webhook_endpoints_previous_secret_window
  CHECK (
    (secret_previous_ciphertext IS NULL AND previous_valid_until IS NULL)
    OR (secret_previous_ciphertext IS NOT NULL AND previous_valid_until IS NOT NULL)
  );

COMMENT ON COLUMN app.webhook_endpoints.secret_previous_ciphertext IS
  'The superseded secret, honoured until previous_valid_until so a rotation does not break a receiver mid-flight.';

-- ---------------------------------------------------------------------------
-- Transactional dispatch
--
-- The outbox pattern only holds if the dispatch record is created in the same
-- transaction as the business event. Enqueuing from application code would put
-- that guarantee in the hands of every future caller who writes an outbox row
-- and forgets the second line; a trigger cannot be forgotten.
--
-- Nothing is enqueued when no active endpoint subscribes to the event type. A
-- job per outbox row would otherwise be created and immediately discarded for
-- every tenant that has no webhooks at all, which is most of them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enqueue_webhook_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.webhook_endpoints e
    WHERE e.tenant_id = NEW.tenant_id
      AND e.active
      AND e.secret_current_ciphertext IS NOT NULL
      AND NEW.event_type = ANY(e.subscribed_events)
  ) THEN
    INSERT INTO app.durable_jobs(tenant_id, job_type, payload, idempotency_key, status, available_at, maximum_attempts)
    VALUES (NEW.tenant_id, 'WEBHOOK_DELIVER',
            jsonb_build_object('outboxEventId', NEW.id),
            'outbox:' || NEW.id::text, 'pending', now(), 10)
    ON CONFLICT (tenant_id, job_type, idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_events_dispatch_webhooks
AFTER INSERT ON app.outbox_events
FOR EACH ROW EXECUTE FUNCTION app.enqueue_webhook_delivery();

-- ---------------------------------------------------------------------------
-- Delivery state must describe what actually happened
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_webhook_delivery_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- "Delivered" is a claim about a remote system. Without the response status it
  -- records that we stopped trying, which is a different thing entirely.
  IF NEW.status = 'delivered' AND (NEW.response_status IS NULL OR NEW.delivered_at IS NULL) THEN
    RAISE EXCEPTION 'a delivered webhook must record the response status and time';
  END IF;
  IF NEW.status <> 'delivered' AND NEW.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a delivered webhook may carry a delivery time';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'delivered' AND NEW.status <> 'delivered' THEN
    RAISE EXCEPTION 'a delivered webhook cannot be undelivered';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER webhook_deliveries_state_insert
BEFORE INSERT ON app.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION app.assert_webhook_delivery_state();
CREATE TRIGGER webhook_deliveries_state_update
BEFORE UPDATE ON app.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION app.assert_webhook_delivery_state();

-- Replay is an operator action on a delivery that already failed. It must not be
-- a way to re-send something that succeeded, so the transition is constrained
-- rather than left to whichever endpoint happens to call it.
CREATE OR REPLACE FUNCTION app.assert_webhook_delivery_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'pending' THEN ARRAY['delivering','failed','dead_letter']
    WHEN 'delivering' THEN ARRAY['delivered','failed','dead_letter']
    WHEN 'failed' THEN ARRAY['pending','delivering','dead_letter']
    WHEN 'dead_letter' THEN ARRAY['pending']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'invalid webhook delivery transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER webhook_deliveries_status_transition
BEFORE UPDATE OF status ON app.webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION app.assert_webhook_delivery_transition();

CREATE INDEX webhook_deliveries_retry_idx
  ON app.webhook_deliveries(tenant_id, status, next_attempt_at)
  WHERE status IN ('pending','failed');
CREATE INDEX webhook_endpoints_active_idx
  ON app.webhook_endpoints(tenant_id) WHERE active;
CREATE INDEX outbox_events_unpublished_idx
  ON app.outbox_events(tenant_id, occurred_at) WHERE published_at IS NULL;
