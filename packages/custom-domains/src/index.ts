import { sha256Hex } from '../../crypto/src/hash.js';
import { randomToken } from '../../crypto/src/tokens.js';

export const DOMAIN_STATES = [
  'requested', 'dns_challenge_created', 'dns_verification_pending', 'dns_verified',
  'routing_pending', 'certificate_pending', 'active', 'renewal_required',
  'suspended', 'removed', 'failed',
] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];

export const DOMAIN_TYPES = ['platform_default', 'customer_custom', 'customer_test', 'internal'] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const RESERVED_TENANT_SLUGS = new Set([
  'www','admin','apply','app','api','auth','sign','verify','docs','status','hooks','mail','support',
  'billing','test','staging','dev','internal','system','root','security','platform','public','static','assets','cdn',
]);

const transitions: Readonly<Record<DomainState, readonly DomainState[]>> = {
  requested: ['dns_challenge_created', 'removed', 'failed'],
  dns_challenge_created: ['dns_verification_pending', 'dns_verified', 'suspended', 'removed', 'failed'],
  dns_verification_pending: ['dns_verified', 'dns_challenge_created', 'suspended', 'removed', 'failed'],
  dns_verified: ['routing_pending', 'certificate_pending', 'suspended', 'removed', 'failed'],
  routing_pending: ['certificate_pending', 'suspended', 'removed', 'failed'],
  certificate_pending: ['active', 'suspended', 'removed', 'failed'],
  active: ['renewal_required', 'suspended', 'removed', 'failed'],
  renewal_required: ['certificate_pending', 'suspended', 'removed', 'failed'],
  suspended: ['dns_challenge_created', 'dns_verification_pending', 'routing_pending', 'certificate_pending', 'removed', 'failed'],
  failed: ['dns_challenge_created', 'dns_verification_pending', 'routing_pending', 'certificate_pending', 'suspended', 'removed'],
  removed: [],
};

export interface DomainVerificationChallenge {
  readonly token: string;
  readonly tokenHash: string;
  readonly recordName: string;
  readonly recordType: 'TXT';
  readonly recordValue: string;
  readonly recordValueHash: string;
  readonly expiresAt: string;
}

export function normalizeTenantSlug(value: string): string {
  const normalized = value.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (normalized.length < 2 || normalized.length > 63) throw new Error('TENANT_SLUG_LENGTH_INVALID');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(normalized)) throw new Error('TENANT_SLUG_INVALID');
  if (RESERVED_TENANT_SLUGS.has(normalized)) throw new Error('TENANT_SLUG_RESERVED');
  return normalized;
}

export function canonicalHostname(value: string, options: { readonly allowPlatformNamespace?: boolean } = {}): string {
  const candidate = value.trim().replace(/\.$/, '');
  if (!candidate) throw new Error('DOMAIN_HOSTNAME_LENGTH_INVALID');
  let hostname: string;
  try {
    const url = new URL(`https://${candidate}`);
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    throw new Error('DOMAIN_HOSTNAME_INVALID');
  }
  if (hostname.length < 1 || hostname.length > 253) throw new Error('DOMAIN_HOSTNAME_LENGTH_INVALID');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(hostname)) {
    throw new Error('DOMAIN_HOSTNAME_INVALID');
  }
  if (!options.allowPlatformNamespace && (hostname === 'kommunsign.se' || hostname.endsWith('.kommunsign.se'))) {
    throw new Error('DOMAIN_PLATFORM_NAMESPACE_RESERVED');
  }
  return hostname;
}

export function platformDefaultHostname(slug: string, rootDomain = 'kommunsign.se'): string {
  const normalizedSlug = normalizeTenantSlug(slug);
  const normalizedRoot = canonicalHostname(rootDomain, { allowPlatformNamespace: true });
  return canonicalHostname(`${normalizedSlug}.${normalizedRoot}`, { allowPlatformNamespace: true });
}

export function assertDomainTransition(from: DomainState, to: DomainState): void {
  if (!transitions[from].includes(to)) throw new Error(`DOMAIN_TRANSITION_INVALID:${from}:${to}`);
}

export function assertDomainMayBecomePrimary(input: {
  readonly status: DomainState;
  readonly dnsVerifiedAt?: string;
  readonly certificateIssuedAt?: string;
  readonly lastHealthStatus?: string;
  readonly activatedAt?: string;
}): void {
  if (input.status !== 'active') throw new Error('PRIMARY_DOMAIN_NOT_ACTIVE');
  if (!input.dnsVerifiedAt) throw new Error('PRIMARY_DOMAIN_DNS_NOT_VERIFIED');
  if (!input.certificateIssuedAt) throw new Error('PRIMARY_DOMAIN_CERTIFICATE_NOT_READY');
  if (input.lastHealthStatus !== 'healthy') throw new Error('PRIMARY_DOMAIN_HEALTH_NOT_GREEN');
  if (!input.activatedAt) throw new Error('PRIMARY_DOMAIN_NOT_ACTIVATED');
}

export async function createDomainVerificationChallenge(input: {
  readonly hostname: string;
  readonly tenantId: string;
  readonly expiresAt: string;
  readonly prefix?: string;
  readonly now?: Date;
}): Promise<DomainVerificationChallenge> {
  const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
  const now = input.now ?? new Date();
  if (!/^[0-9a-f-]{36}$/i.test(input.tenantId)) throw new Error('DOMAIN_CHALLENGE_TENANT_ID_INVALID');
  if (Date.parse(input.expiresAt) <= now.getTime()) throw new Error('DOMAIN_CHALLENGE_EXPIRY_INVALID');
  const token = randomToken(32); // 256 bits
  const recordValue = `ks-verification=${input.tenantId}.${token}`;
  return {
    token,
    tokenHash: await sha256Hex(`${input.tenantId}:${hostname}:${token}`),
    recordName: `${input.prefix ?? '_kommunsign-verification'}.${hostname}`,
    recordType: 'TXT',
    recordValue,
    recordValueHash: await sha256Hex(`${input.tenantId}:${hostname}:${recordValue}`),
    expiresAt: input.expiresAt,
  };
}

export async function verifyDomainChallengeValue(input: {
  readonly tenantId: string;
  readonly hostname: string;
  readonly expectedRecordValueHash: string;
  readonly observedValues: readonly string[];
}): Promise<boolean> {
  const hostname = canonicalHostname(input.hostname, { allowPlatformNamespace: true });
  for (const rawValue of input.observedValues) {
    const normalized = rawValue.trim().replace(/^"|"$/g, '');
    const hash = await sha256Hex(`${input.tenantId}:${hostname}:${normalized}`);
    if (constantTimeHexEqual(hash, input.expectedRecordValueHash)) return true;
  }
  return false;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
