-- Purpose: index the lookups on the login, signer-portal and provider-webhook paths that could not use any existing index.
-- Impact: these predicates filter on trailing columns of tenant-leading indexes, so PostgreSQL could not use them at all and
--   fell back to sequential scans. That is invisible today because the tables are near-empty, and becomes the dominant cost
--   of every login and every public signing request as soon as they are not. Indexes are built concurrently, so reads and
--   writes stay available while they build.
-- Backfill: PostgreSQL builds each index from existing table contents online; no row mutation or application data backfill.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS each index created here.
-- Verification: select indexrelid::regclass from pg_index where not indisvalid must return no rows. With representative row
--   counts, EXPLAIN the login lookup and the three resolver functions and confirm an index scan replaces the sequential scan.
-- Transaction: none

-- Login resolves a subject to its tenants before any tenant is known, so it filters on external_subject alone. The only
-- index on app.users is UNIQUE (tenant_id,external_subject); tenant_id leads it, so that index cannot serve this lookup.
--
-- This index is deliberately NOT tenant-prefixed. It exists for the one cross-tenant control-flow lookup in the product --
-- resolving which tenants a verified subject belongs to at login -- and not for any domain query. Do not "fix" it into a
-- composite index: that would silently return it to a sequential scan on every login.
DROP INDEX CONCURRENTLY IF EXISTS app.users_external_subject_idx;
CREATE INDEX CONCURRENTLY users_external_subject_idx
  ON app.users(external_subject) WHERE disabled_at IS NULL;

-- app.resolve_public_invitation filters on token_hash alone; the only covering index is UNIQUE (tenant_id,token_hash).
-- Read on every signer-portal request. Plain rather than unique: the lookup needs the index, not a new cross-tenant
-- uniqueness constraint.
DROP INDEX CONCURRENTLY IF EXISTS app.signer_invitations_token_hash_idx;
CREATE INDEX CONCURRENTLY signer_invitations_token_hash_idx
  ON app.signer_invitations(token_hash);

-- app.resolve_tic_identity_transaction filters on (provider,provider_reference) with no tenant_id. Read on every inbound
-- BankID webhook.
DROP INDEX CONCURRENTLY IF EXISTS app.identity_transactions_provider_reference_idx;
CREATE INDEX CONCURRENTLY identity_transactions_provider_reference_idx
  ON app.identity_transactions(provider,provider_reference);

-- app.resolve_email_message filters on (provider,provider_message_id) with no tenant_id. Read on every inbound delivery
-- webhook.
DROP INDEX CONCURRENTLY IF EXISTS app.email_messages_provider_message_lookup_idx;
CREATE INDEX CONCURRENTLY email_messages_provider_message_lookup_idx
  ON app.email_messages(provider,provider_message_id);

-- The case detail view aggregates a case's audit events with jsonb_agg. audit.audit_events carries only its primary key
-- and two unique constraints, so that aggregation was a full per-tenant scan of an append-only table.
DROP INDEX CONCURRENTLY IF EXISTS audit.audit_events_resource_idx;
CREATE INDEX CONCURRENTLY audit_events_resource_idx
  ON audit.audit_events(tenant_id,resource_type,resource_id,sequence);

-- Worker job discovery orders claimable work by (available_at,created_at). The existing partial index is restricted to the
-- platform tenant, so per-tenant claims had no ordered index to walk. now() cannot appear in a partial index predicate, so
-- the immutable status filter is what the predicate can express.
DROP INDEX CONCURRENTLY IF EXISTS app.durable_jobs_available_idx;
CREATE INDEX CONCURRENTLY durable_jobs_available_idx
  ON app.durable_jobs(available_at,created_at)
  WHERE status IN ('pending','leased');
