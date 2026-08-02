-- Purpose: make custom-domain ownership canonical and ensure only one active version of each tenant profile.
-- Impact: Canonicalizes DNS names and prevents multiple active profile versions.
-- Backfill: Normalizes existing hostnames to lowercase without a trailing dot after collision detection.
-- Rollback: Drop the added indexes and constraints only after dependent releases are rolled back in a maintenance window.
-- Verification: Check for duplicate canonical hostnames, invalid retention periods and more than one active profile.
-- Rollback: drop the added indexes/constraints after confirming no code depends on canonical hostnames.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM control.tenant_domains
    GROUP BY lower(rtrim(hostname, '.'))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'tenant_domains contains hostnames that collide after DNS canonicalization';
  END IF;
END $$;

UPDATE control.tenant_domains
SET hostname = lower(rtrim(hostname, '.'))
WHERE hostname IS DISTINCT FROM lower(rtrim(hostname, '.'));

ALTER TABLE control.tenant_domains
  ADD CONSTRAINT tenant_domains_hostname_canonical
  CHECK (
    hostname = lower(hostname)
    AND hostname !~ '\.$'
    AND length(hostname) BETWEEN 1 AND 253
    AND hostname ~ '^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'
  ) NOT VALID;
ALTER TABLE control.tenant_domains VALIDATE CONSTRAINT tenant_domains_hostname_canonical;

CREATE UNIQUE INDEX tenant_domains_hostname_canonical_unique
  ON control.tenant_domains (lower(rtrim(hostname, '.')));

CREATE UNIQUE INDEX tenant_policies_one_active_version
  ON control.tenant_policies (tenant_id, policy_key) WHERE active;
CREATE UNIQUE INDEX tenant_storage_profiles_one_active_version
  ON control.tenant_storage_profiles (tenant_id) WHERE active;
CREATE UNIQUE INDEX tenant_encryption_profiles_one_active_version
  ON control.tenant_encryption_profiles (tenant_id) WHERE active;
CREATE UNIQUE INDEX tenant_email_profiles_one_active_version
  ON control.tenant_email_profiles (tenant_id) WHERE active;
CREATE UNIQUE INDEX tenant_archive_profiles_one_active_version
  ON control.tenant_archive_profiles (tenant_id) WHERE active;
CREATE UNIQUE INDEX tenant_retention_policies_one_active_version
  ON control.tenant_retention_policies (tenant_id, policy_key) WHERE active;

ALTER TABLE control.tenant_retention_policies
  ADD CONSTRAINT tenant_retention_period_matches_mode
  CHECK (
    (mode IN ('retain_for_period','archive_then_delete','delete_after_period') AND period_days IS NOT NULL AND period_days > 0)
    OR (mode IN ('retain_forever','legal_hold') AND period_days IS NULL)
  ) NOT VALID;
ALTER TABLE control.tenant_retention_policies VALIDATE CONSTRAINT tenant_retention_period_matches_mode;

ALTER TABLE control.tenant_subscriptions
  ADD CONSTRAINT tenant_subscriptions_valid_period
  CHECK (ends_at IS NULL OR ends_at > starts_at) NOT VALID;
ALTER TABLE control.tenant_subscriptions VALIDATE CONSTRAINT tenant_subscriptions_valid_period;
