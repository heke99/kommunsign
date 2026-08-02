import type { TenantContext } from '../../contracts/src/index.js';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

export interface VerifiedRequestIdentity {
  readonly requestId: string;
  readonly verifiedDomainTenantId?: string;
  readonly membershipTenantId?: string;
  readonly apiClientTenantId?: string;
  readonly deploymentTenantId?: string;
  readonly subjectId: string;
}

export function resolveTenantContext(identity: VerifiedRequestIdentity): TenantContext {
  const candidates = [
    ['verified-domain', identity.verifiedDomainTenantId],
    ['membership', identity.membershipTenantId],
    ['api-client', identity.apiClientTenantId],
    ['deployment', identity.deploymentTenantId],
  ].filter((entry): entry is [TenantContext['source'], string] => Boolean(entry[1]));

  if (candidates.length === 0) throw new TenantContextError('No verified tenant source');
  const tenantIds = new Set(candidates.map(([, tenantId]) => tenantId));
  if (tenantIds.size !== 1) throw new TenantContextError('Conflicting tenant sources');
  const first = candidates[0];
  if (!first) throw new TenantContextError('No verified tenant source');
  return { tenantId: first[1], source: first[0], subjectId: identity.subjectId, requestId: identity.requestId };
}

export function assertTenantMatch(context: TenantContext, resourceTenantId: string): void {
  if (context.tenantId !== resourceTenantId) throw new TenantContextError('Cross-tenant access denied');
}

export function tenantCacheKey(context: TenantContext, namespace: string, identifier: string): string {
  if (!namespace || !identifier) throw new TenantContextError('Cache key parts are required');
  return `tenant:${context.tenantId}:${namespace}:${identifier}`;
}
