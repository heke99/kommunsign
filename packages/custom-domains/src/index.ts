export const DOMAIN_STATES = [
  'requested', 'dns_challenge_created', 'dns_verified', 'certificate_pending',
  'active', 'renewal_required', 'suspended', 'removed',
] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];

const transitions: Readonly<Record<DomainState, readonly DomainState[]>> = {
  requested: ['dns_challenge_created', 'removed'],
  dns_challenge_created: ['dns_verified', 'suspended', 'removed'],
  dns_verified: ['certificate_pending', 'suspended', 'removed'],
  certificate_pending: ['active', 'suspended', 'removed'],
  active: ['renewal_required', 'suspended', 'removed'],
  renewal_required: ['certificate_pending', 'suspended', 'removed'],
  suspended: ['dns_challenge_created', 'certificate_pending', 'removed'],
  removed: [],
};

export function canonicalHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '');
  if (hostname.length < 1 || hostname.length > 253) throw new Error('DOMAIN_HOSTNAME_LENGTH_INVALID');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(hostname)) {
    throw new Error('DOMAIN_HOSTNAME_INVALID');
  }
  if (hostname === 'kommunsign.se' || hostname.endsWith('.kommunsign.se')) throw new Error('DOMAIN_PLATFORM_NAMESPACE_RESERVED');
  return hostname;
}

export function assertDomainTransition(from: DomainState, to: DomainState): void {
  if (!transitions[from].includes(to)) throw new Error(`DOMAIN_TRANSITION_INVALID:${from}:${to}`);
}
