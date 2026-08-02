import { canonicalHostname } from '../../custom-domains/src/index.js';

export interface DomainRequestInput { readonly hostname: string; readonly tenantId: string; readonly environmentId: string; readonly idempotencyKey: string; }
export interface DomainRequestResult { readonly provider: string; readonly providerDomainId: string; readonly status: 'pending' | 'attached'; }
export interface DomainChallenge { readonly recordName: string; readonly recordType: 'TXT'; readonly recordValue: string; readonly expiresAt: string; }
export interface DomainVerificationResult { readonly verified: boolean; readonly checkedAt: string; readonly observedValues?: readonly string[]; }
export interface DomainAttachmentResult { readonly providerDomainId: string; readonly routingTarget: string; readonly attachedAt: string; }
export interface CertificateStatus { readonly status: 'pending' | 'issued' | 'renewal_required' | 'failed' | 'revoked'; readonly issuedAt?: string; readonly expiresAt?: string; readonly fingerprintSha256?: string; }
export interface DomainHealthResult { readonly status: 'healthy' | 'degraded' | 'failed'; readonly checkedAt: string; readonly checks: Readonly<Record<string, boolean>>; readonly safeErrorCode?: string; }

export interface DomainProvider {
  requestDomain(input: DomainRequestInput): Promise<DomainRequestResult>;
  createVerificationChallenge(input: DomainRequestInput): Promise<DomainChallenge>;
  verifyDns(input: DomainRequestInput & { readonly challenge: DomainChallenge }): Promise<DomainVerificationResult>;
  attachDomain(input: DomainRequestInput): Promise<DomainAttachmentResult>;
  getCertificateStatus(input: DomainRequestInput): Promise<CertificateStatus>;
  removeDomain(input: DomainRequestInput): Promise<void>;
  healthCheck(input: DomainRequestInput & { readonly expectedTenantId: string }): Promise<DomainHealthResult>;
}

export interface VercelDomainProviderConfiguration {
  readonly apiToken: string;
  readonly projectId: string;
  readonly teamId?: string;
  readonly routingTarget: string;
  readonly verificationPrefix?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

interface VercelDomainResponse {
  readonly name?: string;
  readonly verified?: boolean;
  readonly verification?: readonly { readonly type?: string; readonly domain?: string; readonly value?: string; readonly reason?: string }[];
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class VercelDomainProvider implements DomainProvider {
  private readonly http: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly configuration: VercelDomainProviderConfiguration) {
    if (!configuration.apiToken.trim()) throw new Error('VERCEL_API_TOKEN_MISSING');
    if (!configuration.projectId.trim()) throw new Error('VERCEL_PROJECT_ID_MISSING');
    this.http = configuration.fetch ?? fetch;
    this.now = configuration.now ?? (() => new Date());
  }

  async requestDomain(input: DomainRequestInput): Promise<DomainRequestResult> {
    const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
    const response = await this.request<VercelDomainResponse>(`/v10/projects/${encodeURIComponent(this.configuration.projectId)}/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ name: hostname }),
    }, [200, 201, 409]);
    if (response.error && response.error.code !== 'domain_already_in_use') throw new Error(`VERCEL_DOMAIN_REQUEST_FAILED:${safeCode(response.error.code)}`);
    return { provider: 'vercel', providerDomainId: response.name ?? hostname, status: response.verified ? 'attached' : 'pending' };
  }

  async createVerificationChallenge(input: DomainRequestInput): Promise<DomainChallenge> {
    const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
    const result = await this.requestDomain(input);
    const response = await this.request<VercelDomainResponse>(`/v9/projects/${encodeURIComponent(this.configuration.projectId)}/domains/${encodeURIComponent(result.providerDomainId)}`, { method: 'GET' }, [200]);
    const challenge = response.verification?.find((item) => item.type?.toUpperCase() === 'TXT');
    if (!challenge?.value) throw new Error('VERCEL_VERIFICATION_CHALLENGE_NOT_AVAILABLE');
    return {
      recordName: challenge.domain ?? `${this.configuration.verificationPrefix ?? '_kommunsign-verification'}.${hostname}`,
      recordType: 'TXT',
      recordValue: challenge.value,
      expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async verifyDns(input: DomainRequestInput & { readonly challenge: DomainChallenge }): Promise<DomainVerificationResult> {
    const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
    const response = await this.request<VercelDomainResponse>(`/v9/projects/${encodeURIComponent(this.configuration.projectId)}/domains/${encodeURIComponent(hostname)}/verify`, { method: 'POST' }, [200, 202, 400]);
    return { verified: response.verified === true, checkedAt: this.now().toISOString() };
  }

  async attachDomain(input: DomainRequestInput): Promise<DomainAttachmentResult> {
    const requested = await this.requestDomain(input);
    return { providerDomainId: requested.providerDomainId, routingTarget: canonicalHostname(this.configuration.routingTarget, { allowPlatformNamespace: true }), attachedAt: this.now().toISOString() };
  }

  async getCertificateStatus(input: DomainRequestInput): Promise<CertificateStatus> {
    const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
    const response = await this.request<VercelDomainResponse>(`/v9/projects/${encodeURIComponent(this.configuration.projectId)}/domains/${encodeURIComponent(hostname)}`, { method: 'GET' }, [200]);
    return { status: response.verified ? 'issued' : 'pending', ...(response.verified ? { issuedAt: this.now().toISOString() } : {}) };
  }

  async removeDomain(input: DomainRequestInput): Promise<void> {
    const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
    await this.request<Record<string, unknown>>(`/v9/projects/${encodeURIComponent(this.configuration.projectId)}/domains/${encodeURIComponent(hostname)}`, { method: 'DELETE', headers: { 'x-idempotency-key': input.idempotencyKey } }, [200, 204, 404]);
  }

  async healthCheck(input: DomainRequestInput & { readonly expectedTenantId: string }): Promise<DomainHealthResult> {
    const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
    try {
      const response = await this.http(`https://${hostname}/api/health/domain`, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' } });
      const body = response.ok ? await response.json() as { readonly tenantId?: string; readonly domainStatus?: string } : {};
      const routing = response.ok && body.tenantId === input.expectedTenantId && body.domainStatus === 'active';
      return { status: routing ? 'healthy' : 'failed', checkedAt: this.now().toISOString(), checks: { tls: response.url.startsWith('https://'), routing, tenantResolution: body.tenantId === input.expectedTenantId }, ...(routing ? {} : { safeErrorCode: 'DOMAIN_HEALTH_BINDING_MISMATCH' }) };
    } catch {
      return { status: 'failed', checkedAt: this.now().toISOString(), checks: { tls: false, routing: false, tenantResolution: false }, safeErrorCode: 'DOMAIN_HEALTH_REQUEST_FAILED' };
    }
  }

  private async request<T>(path: string, init: RequestInit, allowedStatuses: readonly number[]): Promise<T> {
    const query = this.configuration.teamId ? `?teamId=${encodeURIComponent(this.configuration.teamId)}` : '';
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.configuration.apiToken}`);
    const response = await this.http(`https://api.vercel.com${path}${query}`, {
      ...init,
      headers,
    });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!allowedStatuses.includes(response.status)) throw new Error(`VERCEL_DOMAIN_PROVIDER_HTTP_${response.status}`);
    return payload as T;
  }
}

function safeCode(value: string | undefined): string {
  return (value ?? 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}
