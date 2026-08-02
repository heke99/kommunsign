-- Purpose: make versioned tenant configuration content immutable while allowing controlled active-version switches.
-- Impact: Existing policy/profile rows can only change the active flag; content changes require a new version.
-- Backfill: No data rewrite is required.
-- Rollback: Drop these triggers and functions after rolling back dependent control-plane code in a maintenance window.
-- Verification: Attempt content mutation and deletion, then verify active-only updates and new-version inserts remain possible.

CREATE OR REPLACE FUNCTION control.protect_versioned_configuration() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'versioned tenant configuration cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'versioned tenant configuration is immutable; create a new version';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_policies_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_policies
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();
CREATE TRIGGER tenant_storage_profiles_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_storage_profiles
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();
CREATE TRIGGER tenant_encryption_profiles_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_encryption_profiles
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();
CREATE TRIGGER tenant_email_profiles_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_email_profiles
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();
CREATE TRIGGER tenant_archive_profiles_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_archive_profiles
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();
CREATE TRIGGER tenant_retention_policies_version_immutable
BEFORE UPDATE OR DELETE ON control.tenant_retention_policies
FOR EACH ROW EXECUTE FUNCTION control.protect_versioned_configuration();

CREATE OR REPLACE FUNCTION control.protect_verified_domain_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status = 'verified'
     AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.hostname IS DISTINCT FROM OLD.hostname) THEN
    RAISE EXCEPTION 'verified domain ownership binding is immutable; revoke and create a new domain record';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_domains_verified_binding_immutable
BEFORE UPDATE ON control.tenant_domains
FOR EACH ROW EXECUTE FUNCTION control.protect_verified_domain_binding();
