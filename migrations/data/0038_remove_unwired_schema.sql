-- Purpose: Remove three pieces of schema that look configurable and are not: app.reminder_schedules, and two rollout flags nothing reads.
-- Impact: Drops app.reminder_schedules and the two columns app.tenant_signing_settings.freja_direct_rollout_enabled and external_document_signing_rollout_enabled.
-- Backfill: None. All three are empty of meaning: no code writes them and no code reads them, so no row carries information that is being discarded.
-- Rollback: Re-create from migrations/data/0007 and 0019 in a maintenance window. Nothing depends on them, so a rollback restores structure and loses nothing.
-- Verification: Run verify:migrations and migrations/data/verify.sql. tests/sql/signing-turn.sql covers the reminder path that remains.

-- ---------------------------------------------------------------------------
-- Schema that answers a question nobody asks
--
-- A column named freja_direct_rollout_enabled tells a reader — and a tenant
-- administrator looking at their settings — that flipping it turns Freja on.
-- Nothing reads it. The same is true of external_document_signing_rollout_enabled,
-- whose adapter was removed on 2026-08-21 because no application imported it and
-- no requirement cited it.
--
-- app.reminder_schedules is the same shape one level up: a table with
-- next_reminder_at, interval_hours and remaining_attempts, describing a
-- recurring reminder schedule that does not exist. Reminders are sent when a
-- case owner asks for one, and the job that sends them reads app.signers.
--
-- Dropping is expand-and-contract's contract half, run immediately rather than
-- after a wait, because there is no expand phase to wait for: no deployed code
-- reads or writes any of the three, so no version of the application can
-- notice. When Freja credentials arrive, the flag comes back in the same change
-- that gives it a reader.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS app.reminder_schedules;

ALTER TABLE app.tenant_signing_settings
  DROP COLUMN IF EXISTS freja_direct_rollout_enabled,
  DROP COLUMN IF EXISTS external_document_signing_rollout_enabled;
