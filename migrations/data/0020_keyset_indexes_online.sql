-- Purpose: add online indexes for production keyset pagination on existing high-traffic tables.
-- Impact: creates read-path indexes concurrently so inserts, updates, and deletes remain available while indexes build.
-- Backfill: PostgreSQL builds each index from existing table contents online; no row mutation or application data backfill.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS app.signature_cases_keyset_idx, app.outbox_events_keyset_idx, app.notification_templates_keyset_idx in separate statements.
-- Verification: confirm all three indexes are valid in pg_index and run case/event/template keyset pagination integration tests.
-- Transaction: none

CREATE INDEX CONCURRENTLY IF NOT EXISTS signature_cases_keyset_idx
  ON app.signature_cases(tenant_id,created_at DESC,id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_keyset_idx
  ON app.outbox_events(tenant_id,occurred_at DESC,id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS notification_templates_keyset_idx
  ON app.notification_templates(tenant_id,template_key,locale,version DESC,id DESC);
