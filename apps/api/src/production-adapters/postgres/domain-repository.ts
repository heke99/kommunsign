import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { ResolvedTenantDomain, TenantDomainRepository } from '../../../../../packages/tenant-gateway/src/index.js';

interface DomainRow {
  readonly domain_id: string;
  readonly tenant_id: string;
  readonly environment_id: string;
  readonly environment: 'test' | 'production';
  readonly data_plane_id: string;
  readonly hostname: string;
  readonly primary_hostname: string;
  readonly default_hostname: string;
  readonly branding_version: number | null;
}

export function createDomainRepository(database: SqlDatabase): TenantDomainRepository {
  return {
    async findActiveByHostname(normalizedHostname: string): Promise<ResolvedTenantDomain | null> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<DomainRow>(
          `select d.id as domain_id, d.tenant_id, d.environment_id, e.environment::text as environment,
                  e.data_plane_id, d.normalized_hostname as hostname,
                  primary_domain.normalized_hostname as primary_hostname,
                  default_domain.normalized_hostname as default_hostname,
                  branding.version as branding_version
             from control.tenant_domains d
             join control.tenant_environments e on e.id = d.environment_id and e.tenant_id = d.tenant_id
             join control.platform_tenants t on t.id = d.tenant_id
             join lateral (
               select p.normalized_hostname from control.tenant_domains p
                where p.tenant_id = d.tenant_id and p.environment_id = d.environment_id
                  and p.is_primary and p.status = 'active'
                order by p.updated_at desc limit 1
             ) primary_domain on true
             join lateral (
               select p.normalized_hostname from control.tenant_domains p
                where p.tenant_id = d.tenant_id and p.environment_id = d.environment_id
                  and p.domain_type = 'platform_default' and p.status = 'active'
                order by p.updated_at desc limit 1
             ) default_domain on true
             left join lateral (
               select b.version from control.tenant_branding_versions b
                where b.tenant_id = d.tenant_id and b.active limit 1
             ) branding on true
            where d.normalized_hostname = $1 and d.status = 'active'
              and e.status = 'active' and t.status = 'active'
            limit 1`,
          [normalizedHostname],
        );
        const row = result.rows[0];
        return row ? {
          domainId: row.domain_id,
          tenantId: row.tenant_id,
          environmentId: row.environment_id,
          environment: row.environment,
          dataPlaneId: row.data_plane_id,
          hostname: row.hostname,
          primaryHostname: row.primary_hostname,
          defaultHostname: row.default_hostname,
          ...(row.branding_version === null ? {} : { brandingVersion: row.branding_version }),
          status: 'active',
        } : null;
      });
    },
    async recordRoutingEvent(event): Promise<void> {
      await database.transaction(async (transaction) => {
        await transaction.query(
          `insert into control.domain_routing_events
             (tenant_id, environment_id, tenant_domain_id, normalized_hostname, event_type, request_id)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)`,
          [event.tenantId ?? null, event.environmentId ?? null, event.domainId ?? null, event.normalizedHostname, event.eventType, event.requestId ?? null],
        );
      });
    },
  };
}
