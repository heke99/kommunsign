-- Purpose: add encrypted domain challenge recovery and an auditable, two-person primary-domain switch.
-- Impact: extends domain challenges and replaces the primary-domain guard with a controlled security-definer operation.
-- Backfill: none; existing challenge values remain unavailable and must be regenerated if needed.
-- Rollback: disable domain changes and restore the prior guard before removing the additive column/function in a maintenance window.
-- Verification: reject self-approval, reject inactive targets and record primary-domain history for an approved switch.

BEGIN;
ALTER TABLE control.domain_verification_challenges
  ADD COLUMN IF NOT EXISTS record_value_ciphertext bytea;

CREATE OR REPLACE FUNCTION control.guard_primary_domain_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.primary_domain_change', true) = 'authorized' THEN RETURN NEW; END IF;
  IF NEW.is_primary AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'primary domain must be active' USING ERRCODE = '23514';
  END IF;
  IF OLD.is_primary AND NOT NEW.is_primary THEN
    RAISE EXCEPTION 'primary domain changes require control.set_primary_tenant_domain' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION control.set_primary_tenant_domain(
  p_tenant_id uuid,
  p_environment_id uuid,
  p_tenant_domain_id uuid,
  p_requested_by uuid,
  p_approved_by uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=control,pg_temp AS $$
DECLARE previous_id uuid;
BEGIN
  IF p_requested_by = p_approved_by THEN RAISE EXCEPTION 'two-person approval required' USING ERRCODE='42501'; END IF;
  IF nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'change reason required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_environment_id::text,0));
  IF NOT EXISTS (
    SELECT 1 FROM control.tenant_domains
     WHERE id=p_tenant_domain_id AND tenant_id=p_tenant_id AND environment_id=p_environment_id AND status='active'
  ) THEN RAISE EXCEPTION 'target domain is not active'; END IF;
  SELECT id INTO previous_id FROM control.tenant_domains
   WHERE tenant_id=p_tenant_id AND environment_id=p_environment_id AND is_primary AND status<>'removed' FOR UPDATE;
  PERFORM set_config('app.primary_domain_change','authorized',true);
  UPDATE control.tenant_domains SET is_primary=false WHERE id=previous_id AND id<>p_tenant_domain_id;
  UPDATE control.tenant_domains SET is_primary=true WHERE id=p_tenant_domain_id;
  INSERT INTO control.tenant_primary_domain_history
    (tenant_id,environment_id,tenant_domain_id,previous_domain_id,changed_by,change_reason)
  VALUES(p_tenant_id,p_environment_id,p_tenant_domain_id,previous_id,p_approved_by,p_reason);
  INSERT INTO control.domain_routing_events
    (tenant_id,environment_id,tenant_domain_id,normalized_hostname,event_type,safe_metadata)
  SELECT p_tenant_id,p_environment_id,p_tenant_domain_id,normalized_hostname,'primary_changed',
         jsonb_build_object('requestedBy',p_requested_by,'approvedBy',p_approved_by,'previousDomainId',previous_id)
    FROM control.tenant_domains WHERE id=p_tenant_domain_id;
END $$;
REVOKE ALL ON FUNCTION control.set_primary_tenant_domain(uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC;
COMMIT;
