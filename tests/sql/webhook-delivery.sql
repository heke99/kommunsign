\set ON_ERROR_STOP on
-- Proves the outbox dispatch and delivery state rules against a real database.
-- Each block corresponds to a way a subscriber could be told something untrue:
-- an event silently never dispatched, a delivery recorded as delivered without
-- a response, or a successful delivery re-sent as a duplicate.

BEGIN;

SELECT set_config('app.actor_kind', 'worker', true);
SELECT set_config('app.tenant_id', '77777777-7777-4777-8777-777777777777', true);

\set tenant '''77777777-7777-4777-8777-777777777777'''
\set endpoint '''88888888-1111-4888-8888-888888888888'''
\set quiet '''88888888-2222-4888-8888-888888888888'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '77777777-0000-4777-8777-777777777777', 'Kungalvs kommun');

-- ===========================================================================
-- 1. An event with no subscriber creates no work.
-- ===========================================================================
INSERT INTO app.outbox_events (tenant_id, id, aggregate_type, aggregate_id, event_type, payload, payload_sha256)
VALUES (:tenant, '99999999-1111-4999-8999-999999999999', 'signer', '99999999-0000-4999-8999-999999999999', 'signer.signed', '{}'::jsonb, repeat('a',64));
DO $$ BEGIN
  IF (SELECT count(*) FROM app.durable_jobs WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND job_type='WEBHOOK_DELIVER') <> 0 THEN
    RAISE EXCEPTION 'GUARD FAILED: a delivery job was created with no subscriber to deliver to';
  END IF;
END $$;

-- ===========================================================================
-- 2. An endpoint with no usable secret is not dispatched to.
--    Before this release endpoints stored a vault reference nothing resolves,
--    so signing was impossible and an unsigned POST would have gone out.
-- ===========================================================================
INSERT INTO app.webhook_endpoints (tenant_id, id, url, subscribed_events, active, secret_current_ref)
VALUES (:tenant, :quiet, 'https://subscriber.example.se/hook', ARRAY['signer.signed'], true, 'db://webhooks/none');
INSERT INTO app.outbox_events (tenant_id, id, aggregate_type, aggregate_id, event_type, payload, payload_sha256)
VALUES (:tenant, '99999999-2222-4999-8999-999999999999', 'signer', '99999999-0000-4999-8999-999999999999', 'signer.signed', '{}'::jsonb, repeat('b',64));
DO $$ BEGIN
  IF (SELECT count(*) FROM app.durable_jobs WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND job_type='WEBHOOK_DELIVER') <> 0 THEN
    RAISE EXCEPTION 'GUARD FAILED: an endpoint without a signing secret was dispatched to';
  END IF;
END $$;

-- ===========================================================================
-- 3. A subscribed, usable endpoint is dispatched to in the same transaction
--    as the business event. This is the property the outbox pattern exists for.
-- ===========================================================================
INSERT INTO app.webhook_endpoints (tenant_id, id, url, subscribed_events, active, secret_current_ref, secret_current_ciphertext)
VALUES (:tenant, :endpoint, 'https://subscriber.example.se/hook', ARRAY['signer.signed','case.completed'], true, 'db://webhooks/x', '\x0102030405'::bytea);

INSERT INTO app.outbox_events (tenant_id, id, aggregate_type, aggregate_id, event_type, payload, payload_sha256)
VALUES (:tenant, '99999999-3333-4999-8999-999999999999', 'signer', '99999999-0000-4999-8999-999999999999', 'signer.signed', '{"a":1}'::jsonb, repeat('c',64));
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.durable_jobs
    WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND job_type='WEBHOOK_DELIVER'
      AND idempotency_key='outbox:99999999-3333-4999-8999-999999999999'
  ) THEN
    RAISE EXCEPTION 'GUARD FAILED: a subscribed event created no delivery job';
  END IF;
END $$;

-- An event type nobody subscribed to is still not dispatched.
INSERT INTO app.outbox_events (tenant_id, id, aggregate_type, aggregate_id, event_type, payload, payload_sha256)
VALUES (:tenant, '99999999-4444-4999-8999-999999999999', 'document', '99999999-0000-4999-8999-999999999999', 'document.pdfa_validated', '{}'::jsonb, repeat('d',64));
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM app.durable_jobs
    WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND job_type='WEBHOOK_DELIVER'
      AND idempotency_key='outbox:99999999-4444-4999-8999-999999999999'
  ) THEN
    RAISE EXCEPTION 'GUARD FAILED: an unsubscribed event type was dispatched';
  END IF;
END $$;

-- ===========================================================================
-- 4. "Delivered" must record what the subscriber actually answered.
-- ===========================================================================
INSERT INTO app.webhook_deliveries (tenant_id, id, webhook_endpoint_id, outbox_event_id, attempt, status)
VALUES (:tenant, 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', :endpoint, '99999999-3333-4999-8999-999999999999', 0, 'pending');

DO $$ BEGIN
  BEGIN
    UPDATE app.webhook_deliveries SET status='delivering'
     WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    UPDATE app.webhook_deliveries SET status='delivered'
     WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'GUARD FAILED: a delivery was marked delivered with no response recorded';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('must record the response status' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- The DO block above rolled back its subtransaction, so the row is 'pending'
-- again and has to be walked forward through the legal path.
UPDATE app.webhook_deliveries SET status='delivering'
 WHERE tenant_id=:tenant AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE app.webhook_deliveries SET status='delivered', response_status=200, delivered_at=now()
 WHERE tenant_id=:tenant AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';

-- ===========================================================================
-- 5. A delivered event cannot be undelivered, and replay cannot duplicate it.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.webhook_deliveries SET status='pending', delivered_at=null
     WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND id='aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    RAISE EXCEPTION 'GUARD FAILED: a delivered webhook was reset to pending';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF position('GUARD FAILED' in SQLERRM) > 0 THEN RAISE; END IF;
    IF position('cannot be undelivered' in SQLERRM) = 0 AND position('invalid webhook delivery transition' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'GUARD FAILED: expected guard did not fire, got: %', SQLERRM;
    END IF;
  END;
END $$;

-- ===========================================================================
-- 6. A dead-lettered delivery may be replayed, because that is what replay is for.
-- ===========================================================================
INSERT INTO app.webhook_deliveries (tenant_id, id, webhook_endpoint_id, outbox_event_id, attempt, status)
VALUES (:tenant, 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa', :quiet, '99999999-3333-4999-8999-999999999999', 3, 'pending');
UPDATE app.webhook_deliveries SET status='failed', response_status=500
 WHERE tenant_id=:tenant AND id='aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE app.webhook_deliveries SET status='dead_letter'
 WHERE tenant_id=:tenant AND id='aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE app.webhook_deliveries SET status='pending', response_status=null
 WHERE tenant_id=:tenant AND id='aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa';
DO $$ BEGIN
  IF (SELECT status FROM app.webhook_deliveries WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND id='aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa') <> 'pending' THEN
    RAISE EXCEPTION 'GUARD FAILED: a dead-lettered delivery could not be replayed';
  END IF;
END $$;

-- ===========================================================================
-- 7. A rotation window must name both the old secret and its expiry.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    UPDATE app.webhook_endpoints SET secret_previous_ciphertext='\x99'::bytea
     WHERE tenant_id='77777777-7777-4777-8777-777777777777' AND id='88888888-1111-4888-8888-888888888888';
    RAISE EXCEPTION 'GUARD FAILED: a previous secret was kept with no expiry, so it would never stop being accepted';
  EXCEPTION WHEN sqlstate '23514' THEN NULL;
  END;
END $$;

SELECT 'webhook delivery guards: OK' AS result;

ROLLBACK;
