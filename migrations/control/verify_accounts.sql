-- Managed authentication and account provisioning invariants. Every query returns zero rows on success.
SELECT 'active_browser_session_without_csrf' AS violation, id::text AS resource_id
FROM control.host_bound_sessions
WHERE revoked_at IS NULL
  AND authentication_method='session'
  AND csrf_token_hash IS NULL;

SELECT 'duplicate_active_organization_email' AS violation,
       tenant_id::text || ':' || encode(email_blind_index,'hex') AS resource_id
FROM control.organization_account_invitations
WHERE status IN ('invited','active')
GROUP BY tenant_id,email_blind_index
HAVING count(*) > 1;

SELECT 'active_account_for_inactive_organization' AS violation, invitation.id::text AS resource_id
FROM control.organization_account_invitations invitation
JOIN control.platform_tenants organization ON organization.id=invitation.tenant_id
WHERE invitation.status IN ('invited','active')
  AND organization.status NOT IN ('provisioning','active');

SELECT 'account_without_platform_inviter' AS violation, invitation.id::text AS resource_id
FROM control.organization_account_invitations invitation
LEFT JOIN control.platform_subjects subject ON subject.id=invitation.invited_by
WHERE subject.id IS NULL OR subject.status <> 'active';
