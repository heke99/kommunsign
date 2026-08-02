-- Read-only verification for 0007_domain_driven_tenant_gateway.sql.
SELECT normalized_hostname, count(*)
FROM control.tenant_domains
GROUP BY normalized_hostname
HAVING count(*) > 1;

SELECT tenant_id, environment_id, count(*)
FROM control.tenant_domains
WHERE is_primary AND status <> 'removed'
GROUP BY tenant_id, environment_id
HAVING count(*) > 1;

SELECT id, normalized_hostname, status
FROM control.tenant_domains
WHERE status = 'active'
  AND (dns_verified_at IS NULL OR certificate_issued_at IS NULL OR last_health_status <> 'healthy' OR activated_at IS NULL);

SELECT t.id, t.slug
FROM control.platform_tenants t
JOIN control.reserved_tenant_slugs r ON r.slug = t.slug;

SELECT te.tenant_id, te.environment
FROM control.tenant_environments te
LEFT JOIN control.data_planes dp ON dp.id = te.data_plane_id
WHERE dp.id IS NULL;
