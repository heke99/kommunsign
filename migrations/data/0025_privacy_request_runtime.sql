-- Purpose: Persist data subject rights requests so a request can be received, identity-verified, handled, fulfilled and delivered with evidence.
-- Impact: Adds app.privacy_requests, app.privacy_request_coverage and app.privacy_responses with state, identity, legal-hold and coverage-completeness guards.
-- Backfill: No business data is rewritten; all three tables are new and start empty.
-- Rollback: Drop the three tables and their functions in a maintenance window after rolling back the PRIVACY_REQUEST_EXECUTE worker and the privacy API routes.
-- Verification: Run verify:migrations and tests/sql/privacy-requests.sql.

-- ---------------------------------------------------------------------------
-- A rights request had nowhere to live
--
-- packages/privacy models the whole thing -- the five rights, the five stores
-- that may hold personal data, the thirty-day deadline from PUB-avtalet 10.1,
-- and a decision layer that refuses to build an incomplete answer. Nothing
-- imported it. A registered person could not lodge a request at all, and the
-- deadline nobody was counting is one the supervisory authority does count.
--
-- The rules restated here are the ones that must survive a bug in the code
-- above them: an answer is never issued without an account for every store, a
-- store is never both unsearched and unexempted, identity is proven before
-- anything is disclosed, and erasure stops at a legal hold.
-- ---------------------------------------------------------------------------
CREATE TABLE app.privacy_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK (state IN ('RECEIVED','IDENTITY_VERIFIED','IN_PROGRESS','FULFILLED','DELIVERED','REFUSED')),
  right_requested text NOT NULL CHECK (right_requested IN ('ACCESS','RECTIFICATION','RESTRICTION','ERASURE','PORTABILITY')),

  -- Who the request is about. Encrypted and blind-indexed like every other
  -- identifier in this schema: the subject of a rights request is a person who
  -- has just told us they care about their personal data.
  subject_identifier_ciphertext bytea NOT NULL,
  subject_identifier_blind_index bytea NOT NULL,
  -- The internal user the request resolved to, when the subject is a known
  -- user. Null for a subject who only ever appeared as a signer.
  subject_user_id uuid,

  -- The deadline runs from receipt, not from when someone got round to it.
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,

  -- How identity was proven. An email confirmation is not BankID, and a
  -- register extract released to an address someone happens to control is a
  -- personal data breach in itself -- so the assurance level is recorded, not
  -- just the fact of verification.
  identity_verified_at timestamptz,
  identity_method text,
  identity_assurance text CHECK (identity_assurance IS NULL OR identity_assurance IN ('LOW','SUBSTANTIAL','HIGH')),

  handled_by uuid,
  refusal_ground text,
  delivered_at timestamptz,

  status_version bigint NOT NULL DEFAULT 1 CHECK (status_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES app.users(tenant_id, id),
  FOREIGN KEY (tenant_id, handled_by) REFERENCES app.users(tenant_id, id),

  -- A refusal without a stated legal ground is not a refusal, it is an
  -- unhandled request, and the person has a right to know why so they can
  -- complain about it.
  CONSTRAINT privacy_requests_refusal_needs_ground
    CHECK (state <> 'REFUSED' OR (refusal_ground IS NOT NULL AND length(btrim(refusal_ground)) > 0)),
  CONSTRAINT privacy_requests_delivered_has_timestamp
    CHECK (state <> 'DELIVERED' OR delivered_at IS NOT NULL)
);
ALTER TABLE app.privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.privacy_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.privacy_requests
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.privacy_requests FROM PUBLIC;

CREATE INDEX privacy_requests_subject_idx
  ON app.privacy_requests(tenant_id, subject_identifier_blind_index);
-- Overdue requests are found by deadline among the states that are still open.
CREATE INDEX privacy_requests_open_due_idx
  ON app.privacy_requests(tenant_id, due_at)
  WHERE state NOT IN ('DELIVERED','REFUSED');

-- One open request per subject per right.
--
-- This is the idempotency guarantee, and it is deliberately a natural key
-- rather than a header the caller might forget to send. A retried submission
-- would otherwise start a second thirty-day clock for the same person and
-- produce a second extract, and the duplicate would be indistinguishable from
-- a genuine second request.
CREATE UNIQUE INDEX privacy_requests_one_open_per_subject_right
  ON app.privacy_requests(tenant_id, subject_identifier_blind_index, right_requested)
  WHERE state NOT IN ('DELIVERED','REFUSED');

-- ---------------------------------------------------------------------------
-- One row per store, and every store must be accounted for
--
-- This is the table that makes the answer honest. A handler returning
-- "searched, zero records" without querying anything satisfies every type in
-- the system and is a lie; the shape here forces the distinction between a
-- store that was searched and found empty and a store that could not be
-- searched at all. BACKUP is the standing example: it cannot be point-searched
-- online, so it is reported as an exemption with its ground, never as an empty
-- hit.
-- ---------------------------------------------------------------------------
CREATE TABLE app.privacy_request_coverage (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL,
  store text NOT NULL CHECK (store IN ('CONTROL','DATA','OBJECT_STORAGE','AUDIT_LOG','BACKUP')),
  record_count integer NOT NULL CHECK (record_count >= 0),
  searched boolean NOT NULL,
  exemption_reason text,
  -- What was actually done, in the store's own terms, so a later reader can
  -- tell a deletion from a crypto-erasure from a read-only extract.
  action_taken text NOT NULL CHECK (action_taken IN ('SEARCHED','EXPORTED','RECTIFIED','RESTRICTED','DELETED','CRYPTO_ERASED','EXEMPTED')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, privacy_request_id, store),
  FOREIGN KEY (tenant_id, privacy_request_id) REFERENCES app.privacy_requests(tenant_id, id),

  -- A store is either searched or exempted with a stated ground. Never
  -- neither: that is precisely how CONTROL gets forgotten.
  CONSTRAINT privacy_coverage_searched_or_exempted
    CHECK (searched OR (exemption_reason IS NOT NULL AND length(btrim(exemption_reason)) > 0)),
  -- And an unsearched store cannot claim to have found records.
  CONSTRAINT privacy_coverage_unsearched_has_no_records
    CHECK (searched OR record_count = 0)
);
ALTER TABLE app.privacy_request_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.privacy_request_coverage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.privacy_request_coverage
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.privacy_request_coverage FROM PUBLIC;

-- Coverage is evidence of what was done to someone's personal data. Rewriting
-- it after the fact would change what the answer claims to have covered.
CREATE TRIGGER privacy_request_coverage_append_only
BEFORE UPDATE OR DELETE ON app.privacy_request_coverage
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

-- ---------------------------------------------------------------------------
-- The answer itself
-- ---------------------------------------------------------------------------
CREATE TABLE app.privacy_responses (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  privacy_request_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  -- The canonical-JSON response document, hashed so the copy handed to the
  -- person can be shown to be the copy that was produced.
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  -- Where the exported bundle lives, for ACCESS and PORTABILITY.
  export_object_key text,
  total_records integer NOT NULL CHECK (total_records >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, privacy_request_id),
  FOREIGN KEY (tenant_id, privacy_request_id) REFERENCES app.privacy_requests(tenant_id, id)
);
ALTER TABLE app.privacy_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.privacy_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.privacy_responses
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE ALL ON app.privacy_responses FROM PUBLIC;

CREATE TRIGGER privacy_responses_append_only
BEFORE UPDATE OR DELETE ON app.privacy_responses
FOR EACH ROW EXECUTE FUNCTION app.reject_evidence_mutation();

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- The state machine from packages/privacy, restated where it cannot be skipped
-- by a code path that forgot to call the library.
CREATE OR REPLACE FUNCTION app.assert_privacy_request_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.state = OLD.state THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  allowed := CASE OLD.state
    -- A refusal is reachable from anywhere still open: the ground for refusing
    -- can become apparent at any point before delivery.
    WHEN 'RECEIVED'          THEN ARRAY['IDENTITY_VERIFIED','REFUSED']
    WHEN 'IDENTITY_VERIFIED' THEN ARRAY['IN_PROGRESS','REFUSED']
    WHEN 'IN_PROGRESS'       THEN ARRAY['FULFILLED','REFUSED']
    WHEN 'FULFILLED'         THEN ARRAY['DELIVERED','REFUSED']
    -- Delivered is terminal. Refusing a request after the register extract has
    -- already been handed over does not un-hand it over.
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.state = ANY (allowed)) THEN
    RAISE EXCEPTION 'PRIVACY_STATE_TRANSITION_INVALID: % -> %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;

  NEW.status_version := OLD.status_version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER privacy_requests_transition_guard
BEFORE UPDATE ON app.privacy_requests
FOR EACH ROW EXECUTE FUNCTION app.assert_privacy_request_transition();

-- Identity before anything else. A rights request is otherwise the easiest
-- route to someone else's register extract: you only have to claim to be them.
-- The strong-identity rights match HIGH_ASSURANCE_RIGHTS in
-- packages/privacy/src/executor.ts.
CREATE OR REPLACE FUNCTION app.assert_privacy_identity_verified() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('IDENTITY_VERIFIED','IN_PROGRESS','FULFILLED','DELIVERED') THEN
    IF NEW.identity_verified_at IS NULL OR NEW.identity_method IS NULL OR NEW.identity_assurance IS NULL THEN
      RAISE EXCEPTION 'PRIVACY_IDENTITY_NOT_VERIFIED' USING ERRCODE = '23514';
    END IF;
    IF NEW.right_requested IN ('ACCESS','ERASURE','PORTABILITY','RECTIFICATION')
       AND NEW.identity_assurance <> 'HIGH' THEN
      RAISE EXCEPTION 'PRIVACY_IDENTITY_ASSURANCE_TOO_LOW: % requires HIGH, got %',
        NEW.right_requested, NEW.identity_assurance USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER privacy_requests_identity_guard
BEFORE INSERT OR UPDATE ON app.privacy_requests
FOR EACH ROW EXECUTE FUNCTION app.assert_privacy_identity_verified();

-- Erasure stops at a legal hold, re-checked at the moment of fulfilment rather
-- than trusted from when the request arrived. A hold placed in between is
-- exactly the case this exists for -- the same reason gallring re-checks.
CREATE OR REPLACE FUNCTION app.assert_privacy_erasure_not_held() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE held integer;
BEGIN
  IF NEW.state = 'FULFILLED' AND NEW.right_requested = 'ERASURE' THEN
    SELECT count(*) INTO held
      FROM app.legal_holds hold
      JOIN app.signature_cases signature_case
        ON signature_case.tenant_id = hold.tenant_id AND signature_case.id = hold.signature_case_id
      JOIN app.signers signer
        ON signer.tenant_id = signature_case.tenant_id AND signer.signature_case_id = signature_case.id
     WHERE hold.tenant_id = NEW.tenant_id
       AND hold.released_at IS NULL
       AND signer.verified_identifier_blind_index = NEW.subject_identifier_blind_index;
    IF held > 0 THEN
      RAISE EXCEPTION 'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD: % case(s) under hold', held USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER privacy_requests_legal_hold_guard
BEFORE UPDATE ON app.privacy_requests
FOR EACH ROW EXECUTE FUNCTION app.assert_privacy_erasure_not_held();

-- Every store, accounted for, before an answer can be called fulfilled.
--
-- This is the same rule buildDataSubjectResponse throws on, and it belongs in
-- both places. A register extract that quietly omits CONTROL is worse than no
-- extract, because it looks complete.
--
-- Deferred: the worker writes the request row and its five coverage rows in one
-- transaction, and an immediate trigger would fire before the coverage rows
-- exist. Deferring moves the check to commit, where the whole set is visible.
CREATE OR REPLACE FUNCTION app.assert_privacy_coverage_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  missing text[];
  current_state text;
BEGIN
  SELECT state INTO current_state FROM app.privacy_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  -- The row may have been deleted, or moved on, inside the same transaction.
  IF current_state IS NULL OR current_state NOT IN ('FULFILLED','DELIVERED') THEN
    RETURN NULL;
  END IF;

  -- The column is named explicitly rather than left to the table alias. A bare
  -- `store` inside the subquery binds to app.privacy_request_coverage.store,
  -- which makes the comparison trivially true and the whole check vacuous --
  -- the first version of this function had exactly that bug, and
  -- tests/sql/privacy-requests.sql is what found it.
  SELECT array_agg(required.store ORDER BY required.store) INTO missing
    FROM unnest(ARRAY['CONTROL','DATA','OBJECT_STORAGE','AUDIT_LOG','BACKUP']) AS required(store)
   WHERE NOT EXISTS (
     SELECT 1 FROM app.privacy_request_coverage coverage
      WHERE coverage.tenant_id = NEW.tenant_id
        AND coverage.privacy_request_id = NEW.id
        AND coverage.store = required.store
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRIVACY_COVERAGE_INCOMPLETE: no account for %', array_to_string(missing, ', ')
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER privacy_requests_coverage_complete
AFTER UPDATE ON app.privacy_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.assert_privacy_coverage_complete();

-- A response may only exist for a request that reached fulfilment, and the
-- record count it reports must be the sum of what the coverage rows say. A
-- total that disagrees with its own parts is a number nobody should act on.
CREATE OR REPLACE FUNCTION app.assert_privacy_response_consistent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_state text;
  coverage_total integer;
BEGIN
  SELECT state INTO request_state FROM app.privacy_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.privacy_request_id;
  IF request_state IS NULL THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF request_state NOT IN ('FULFILLED','DELIVERED') THEN
    RAISE EXCEPTION 'PRIVACY_RESPONSE_BEFORE_FULFILMENT: request is %', request_state USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(sum(record_count), 0) INTO coverage_total
    FROM app.privacy_request_coverage
   WHERE tenant_id = NEW.tenant_id AND privacy_request_id = NEW.privacy_request_id;

  IF coverage_total <> NEW.total_records THEN
    RAISE EXCEPTION 'PRIVACY_RESPONSE_TOTAL_MISMATCH: coverage sums to %, response claims %',
      coverage_total, NEW.total_records USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER privacy_responses_consistent
AFTER INSERT ON app.privacy_responses
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.assert_privacy_response_consistent();
