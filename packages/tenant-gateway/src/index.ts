import { canonicalHostname } from '../../custom-domains/src/index.js';
import type { TenantContext } from '../../contracts/src/index.js';

export type TenantEnvironment = 'test' | 'production';
export type PublicUrlPurpose = 'tenant_login' | 'signer_invitation' | 'verification' | 'onboarding' | 'support';

export interface ResolvedTenantDomain {
  readonly domainId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly environment: TenantEnvironment;
  readonly dataPlaneId: string;
  readonly hostname: string;
  readonly primaryHostname: string;
  readonly defaultHostname: string;
  readonly brandingVersion?: number;
  readonly status: 'active';
}

export interface TenantDomainRepository {
  findActiveByHostname(normalizedHostname: string): Promise<ResolvedTenantDomain | null>;
  recordRoutingEvent(event: {
    readonly normalizedHostname: string;
    readonly eventType: 'resolution_succeeded' | 'unknown_host_rejected' | 'inactive_host_rejected' | 'misdirected_request' | 'cache_invalidated';
    readonly requestId?: string;
    readonly tenantId?: string;
    readonly environmentId?: string;
    readonly domainId?: string;
  }): Promise<void>;
}

export interface HostResolverOptions {
  readonly trustProxy: boolean;
  readonly trustedProxyProvider: 'vercel' | 'cloudflare' | 'none';
  readonly requireVerifiedForwardedHost: boolean;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface CacheEntry { readonly expiresAt: number; readonly value: ResolvedTenantDomain; }

export class TenantHostnameResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly cacheTtlMs: number;

  constructor(private readonly repository: TenantDomainRepository, private readonly options: HostResolverOptions) {
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = Math.min(Math.max(options.cacheTtlMs ?? 30_000, 1_000), 300_000);
  }

  async resolve(request: Request, requestId?: string): Promise<ResolvedTenantDomain> {
    const hostname = resolveRequestHostname(request, this.options);
    const cached = this.cache.get(hostname);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (cached) this.cache.delete(hostname);

    const resolved = await this.repository.findActiveByHostname(hostname);
    if (!resolved) {
      await this.repository.recordRoutingEvent({ normalizedHostname: hostname, eventType: 'unknown_host_rejected', ...(requestId ? { requestId } : {}) });
      throw new TenantDomainResolutionError('TENANT_DOMAIN_NOT_FOUND', 404);
    }
    if (resolved.hostname !== hostname || resolved.status !== 'active') {
      await this.repository.recordRoutingEvent({ normalizedHostname: hostname, eventType: 'misdirected_request', tenantId: resolved.tenantId, environmentId: resolved.environmentId, domainId: resolved.domainId, ...(requestId ? { requestId } : {}) });
      throw new TenantDomainResolutionError('MISDIRECTED_REQUEST', 421);
    }
    this.cache.set(hostname, { expiresAt: this.now() + this.cacheTtlMs, value: resolved });
    await this.repository.recordRoutingEvent({ normalizedHostname: hostname, eventType: 'resolution_succeeded', tenantId: resolved.tenantId, environmentId: resolved.environmentId, domainId: resolved.domainId, ...(requestId ? { requestId } : {}) });
    return resolved;
  }

  async invalidate(hostname: string): Promise<void> {
    const normalized = canonicalHostname(hostname, { allowPlatformNamespace: true });
    this.cache.delete(normalized);
    await this.repository.recordRoutingEvent({ normalizedHostname: normalized, eventType: 'cache_invalidated' });
  }

  clear(): void { this.cache.clear(); }
}

export class TenantDomainResolutionError extends Error {
  constructor(readonly code: 'TENANT_DOMAIN_NOT_FOUND' | 'MISDIRECTED_REQUEST' | 'UNVERIFIED_FORWARDED_HOST' | 'HOST_HEADER_INVALID', readonly status: 404 | 421 | 400) {
    super(code);
    this.name = 'TenantDomainResolutionError';
  }
}

export function resolveRequestHostname(request: Request, options: HostResolverOptions): string {
  const directHost = request.headers.get('host');
  const forwardedHost = request.headers.get('x-forwarded-host');
  let selected = directHost;
  if (options.trustProxy && forwardedHost) {
    if (options.requireVerifiedForwardedHost && !isTrustedProxyRequest(request, options.trustedProxyProvider)) {
      throw new TenantDomainResolutionError('UNVERIFIED_FORWARDED_HOST', 400);
    }
    selected = forwardedHost.split(',')[0]?.trim() ?? null;
  }
  if (!selected) {
    try { selected = new URL(request.url).host; } catch { throw new TenantDomainResolutionError('HOST_HEADER_INVALID', 400); }
  }
  const hostWithoutPort = stripPort(selected);
  try { return canonicalHostname(hostWithoutPort, { allowPlatformNamespace: true }); }
  catch { throw new TenantDomainResolutionError('HOST_HEADER_INVALID', 400); }
}

export function createTenantContextFromDomain(input: {
  readonly domain: ResolvedTenantDomain;
  readonly subjectId: string;
  readonly requestId: string;
  readonly authMethod: TenantContext['authMethod'];
}): TenantContext {
  return { tenantId: input.domain.tenantId, subjectId: input.subjectId, requestId: input.requestId, authMethod: input.authMethod, source: 'verified-domain' };
}

export function resolveTenantPublicUrl(domain: Pick<ResolvedTenantDomain, 'primaryHostname' | 'defaultHostname'>, purpose: PublicUrlPurpose, token?: string): URL {
  const base = new URL(`https://${domain.primaryHostname || domain.defaultHostname}`);
  switch (purpose) {
    case 'tenant_login': base.pathname = '/'; break;
    case 'signer_invitation':
      if (!token || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error('SIGNER_INVITATION_TOKEN_INVALID');
      base.pathname = `/sign/${encodeURIComponent(token)}`;
      break;
    case 'verification': base.pathname = '/verify'; break;
    case 'onboarding': base.pathname = '/app/onboarding'; break;
    case 'support': base.pathname = '/support'; break;
  }
  return base;
}

export function isAllowedCredentialOrigin(origin: string, allowedHostnames: ReadonlySet<string>): boolean {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  let hostname: string;
  try { hostname = canonicalHostname(parsed.hostname, { allowPlatformNamespace: true }); } catch { return false; }
  return allowedHostnames.has(hostname);
}

function isTrustedProxyRequest(request: Request, provider: HostResolverOptions['trustedProxyProvider']): boolean {
  if (provider === 'none') return false;
  if (provider === 'vercel') return Boolean(request.headers.get('x-vercel-id'));
  if (provider === 'cloudflare') return Boolean(request.headers.get('cf-ray'));
  return false;
}

function stripPort(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) throw new TenantDomainResolutionError('HOST_HEADER_INVALID', 400);
  return trimmed.replace(/:\d+$/, '');
}
