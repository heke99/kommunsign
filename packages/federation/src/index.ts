/**
 * Workforce federation (SAML 2.0 and OpenID Connect).
 *
 * Kungälv requirement 2079 requires login over SAML 2.0 *or* OIDC, and F004
 * requires login through the municipality's own IdP — currently MobilityGuard,
 * but the requirement is the capability, not the product. So this module is
 * protocol-shaped, not vendor-shaped: nothing here names MobilityGuard, Entra
 * or any other IdP, and onboarding a different one is a configuration row.
 *
 * The XML signature check (SAML) and the JWT signature check (OIDC) happen at
 * the edge where the keys live. This module handles what comes after: deciding
 * whether a *validly signed* assertion may log someone in, and as whom.
 *
 * That distinction is the whole point. A correctly signed assertion from a
 * trusted IdP is still not sufficient. It may have been minted for a different
 * service, replayed from an earlier login, issued for a different tenant, or
 * carry groups that map to no role at all. Each check below closes one of
 * those, and each one is a real way federated login goes wrong.
 */

import type { UUID } from '../../contracts/src/index.js';

export const FEDERATION_PROTOCOLS = ['SAML2', 'OIDC'] as const;
export type FederationProtocol = (typeof FEDERATION_PROTOCOLS)[number];

export type FederationRejectionCode =
  | 'FEDERATION_SIGNATURE_NOT_VERIFIED'
  | 'FEDERATION_ISSUER_MISMATCH'
  | 'FEDERATION_AUDIENCE_MISMATCH'
  | 'FEDERATION_DESTINATION_MISMATCH'
  | 'FEDERATION_REQUEST_MISMATCH'
  | 'FEDERATION_ASSERTION_REPLAYED'
  | 'FEDERATION_ASSERTION_EXPIRED'
  | 'FEDERATION_ASSERTION_NOT_YET_VALID'
  | 'FEDERATION_SUBJECT_MISSING'
  | 'FEDERATION_TENANT_MISMATCH'
  | 'FEDERATION_PROVIDER_DISABLED'
  | 'FEDERATION_AUTHN_CONTEXT_TOO_LOW'
  | 'FEDERATION_SESSION_TOO_OLD'
  | 'FEDERATION_NO_ROLE_MAPPED'
  | 'FEDERATION_ROLE_NOT_ASSIGNABLE';

export class FederationError extends Error {
  constructor(readonly code: FederationRejectionCode, message: string) {
    super(message);
    this.name = 'FederationError';
  }
}

/* ------------------------------------------------------------------ *
 * Tenant configuration
 * ------------------------------------------------------------------ */

/**
 * One row per tenant per environment, mirroring
 * control.tenant_identity_providers. Signing certificates and client secrets
 * are held as secret references, never inline (AGENTS.md rule 7).
 */
export interface FederationConfig {
  readonly tenantId: UUID;
  readonly protocol: FederationProtocol;
  readonly enabled: boolean;
  /** SAML EntityID or OIDC issuer. Compared exactly, never by suffix. */
  readonly issuer: string;
  /** Our own EntityID / client_id, as the IdP knows us. */
  readonly audience: string;
  /** ACS URL (SAML) or redirect URI (OIDC). */
  readonly destination: string;
  readonly signingCertificateSecretReference: string;
  /** Minimum LoA the tenant demands, as the IdP names it. */
  readonly requiredAuthnContexts: readonly string[];
  /** Reject a session the IdP established longer ago than this. */
  readonly maximumAuthenticationAgeSeconds: number;
  /** Claim or attribute holding the stable subject identifier. */
  readonly subjectAttribute: string;
  /** Claim or attribute holding group membership. */
  readonly groupsAttribute: string;
  /** IdP group value -> Kommunsign role. Unlisted groups grant nothing. */
  readonly groupToRole: Readonly<Record<string, string>>;
  /** Roles this tenant permits federation to assign at all. */
  readonly assignableRoles: readonly string[];
}

/**
 * The normalised assertion, after the protocol-specific parser has run. Both
 * SAML and OIDC reduce to this, so the decision below is written once instead
 * of twice with subtly different rules.
 */
export interface WorkforceAssertion {
  readonly protocol: FederationProtocol;
  readonly signatureVerified: boolean;
  readonly issuer: string;
  readonly audience: string;
  /** SAML Destination/Recipient, or the OIDC redirect_uri that was used. */
  readonly destination: string;
  /** Unique assertion ID (SAML) or jti (OIDC). Consumed once. */
  readonly assertionId: string;
  /** SAML InResponseTo, or the OIDC state. Binds to a request we started. */
  readonly inResponseTo: string | null;
  readonly notBefore: string | null;
  readonly notOnOrAfter: string;
  /** When the IdP actually authenticated the user. */
  readonly authenticatedAt: string;
  readonly authnContext: string | null;
  readonly subject: string;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

/** What we started. The assertion must answer *this* request. */
export interface FederationRequestBinding {
  readonly requestId: string;
  readonly tenantId: UUID;
  readonly redirectUri: string;
}

/** Records consumed assertion IDs so a replay is refused. */
export interface AssertionLedger {
  consume(assertionId: string): boolean;
}

export class InMemoryAssertionLedger implements AssertionLedger {
  private readonly seen = new Set<string>();
  consume(assertionId: string): boolean {
    if (this.seen.has(assertionId)) return false;
    this.seen.add(assertionId);
    return true;
  }
}

function instant(value: string, code: FederationRejectionCode): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new FederationError(code, `Invalid timestamp ${value}`);
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Assertion admission
 * ------------------------------------------------------------------ */

export function verifyWorkforceAssertion(
  assertion: WorkforceAssertion,
  config: FederationConfig,
  binding: FederationRequestBinding,
  ledger: AssertionLedger,
  now: Date,
): void {
  // A disabled provider must not authenticate anyone, even with a perfectly
  // valid assertion left over from when it was enabled.
  if (!config.enabled) {
    throw new FederationError('FEDERATION_PROVIDER_DISABLED', 'Federation is not enabled for this tenant');
  }
  // Nothing below means anything on an unsigned assertion.
  if (!assertion.signatureVerified) {
    throw new FederationError('FEDERATION_SIGNATURE_NOT_VERIFIED', 'Assertion signature was not verified');
  }
  // AGENTS.md rule 1: the tenant comes from the configuration bound to the
  // request, never from anything the assertion itself carries.
  if (config.tenantId !== binding.tenantId) {
    throw new FederationError('FEDERATION_TENANT_MISMATCH', 'Federation configuration belongs to another tenant');
  }
  if (assertion.issuer !== config.issuer) {
    throw new FederationError('FEDERATION_ISSUER_MISMATCH', 'Assertion issuer is not the configured IdP');
  }
  // Without this, an assertion minted for a different service provider by the
  // same IdP would authenticate here.
  if (assertion.audience !== config.audience) {
    throw new FederationError('FEDERATION_AUDIENCE_MISMATCH', 'Assertion was not issued for this service provider');
  }
  // And without this, one captured at a different endpoint could be posted to
  // ours.
  if (assertion.destination !== config.destination || assertion.destination !== binding.redirectUri) {
    throw new FederationError('FEDERATION_DESTINATION_MISMATCH', 'Assertion was not issued for this endpoint');
  }
  // IdP-initiated flows are refused: an assertion must answer a request we
  // started, otherwise a stolen one can be posted at any time.
  if (assertion.inResponseTo === null || assertion.inResponseTo !== binding.requestId) {
    throw new FederationError('FEDERATION_REQUEST_MISMATCH', 'Assertion does not answer a login request we started');
  }

  const current = now.getTime();
  if (assertion.notBefore !== null && current < instant(assertion.notBefore, 'FEDERATION_ASSERTION_NOT_YET_VALID')) {
    throw new FederationError('FEDERATION_ASSERTION_NOT_YET_VALID', 'Assertion is not yet valid');
  }
  if (current >= instant(assertion.notOnOrAfter, 'FEDERATION_ASSERTION_EXPIRED')) {
    throw new FederationError('FEDERATION_ASSERTION_EXPIRED', 'Assertion has expired');
  }
  // A fresh assertion can still describe a very old session. Re-authentication
  // age is a separate limit from assertion validity.
  const authenticatedAt = instant(assertion.authenticatedAt, 'FEDERATION_SESSION_TOO_OLD');
  if (current - authenticatedAt > config.maximumAuthenticationAgeSeconds * 1000) {
    throw new FederationError('FEDERATION_SESSION_TOO_OLD', 'The IdP session is older than this tenant accepts');
  }

  // Within its validity window the same assertion is accepted every time it is
  // presented unless it is consumed exactly once.
  if (!ledger.consume(assertion.assertionId)) {
    throw new FederationError('FEDERATION_ASSERTION_REPLAYED', 'Assertion has already been used');
  }

  if (config.requiredAuthnContexts.length > 0) {
    if (assertion.authnContext === null || !config.requiredAuthnContexts.includes(assertion.authnContext)) {
      throw new FederationError(
        'FEDERATION_AUTHN_CONTEXT_TOO_LOW',
        `Authentication context ${assertion.authnContext ?? 'none'} is not accepted by this tenant`,
      );
    }
  }
  if (!assertion.subject.trim()) {
    throw new FederationError('FEDERATION_SUBJECT_MISSING', 'Assertion carries no subject identifier');
  }
}

/* ------------------------------------------------------------------ *
 * Identity mapping
 * ------------------------------------------------------------------ */

export interface MappedWorkforceIdentity {
  readonly tenantId: UUID;
  readonly subject: string;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  readonly authenticatedAt: string;
  readonly protocol: FederationProtocol;
}

/**
 * Maps IdP groups onto Kommunsign roles.
 *
 * Deliberately deny-by-default in three ways: an unmapped group grants
 * nothing, a user with no mapped group is refused rather than given a default
 * role, and a mapping that points at a role outside `assignableRoles` is an
 * error rather than a silent grant. A misconfigured mapping should fail
 * loudly at login, not quietly hand out permissions nobody chose.
 */
export function mapWorkforceIdentity(
  assertion: WorkforceAssertion,
  config: FederationConfig,
  binding: FederationRequestBinding,
): MappedWorkforceIdentity {
  const subjectValues = assertion.attributes[config.subjectAttribute];
  const subject = subjectValues?.[0] ?? assertion.subject;
  if (!subject.trim()) {
    throw new FederationError('FEDERATION_SUBJECT_MISSING', 'Assertion carries no subject identifier');
  }

  const groups = assertion.attributes[config.groupsAttribute] ?? [];
  const roles: string[] = [];
  for (const group of groups) {
    const role = config.groupToRole[group];
    if (role === undefined) continue;
    if (!config.assignableRoles.includes(role)) {
      throw new FederationError(
        'FEDERATION_ROLE_NOT_ASSIGNABLE',
        `Group ${group} maps to role ${role}, which this tenant does not permit federation to assign`,
      );
    }
    if (!roles.includes(role)) roles.push(role);
  }
  if (roles.length === 0) {
    throw new FederationError('FEDERATION_NO_ROLE_MAPPED', 'No group in the assertion maps to a role for this tenant');
  }

  return {
    tenantId: binding.tenantId,
    subject,
    roles: roles.sort(),
    groups: [...groups].sort(),
    authenticatedAt: assertion.authenticatedAt,
    protocol: assertion.protocol,
  };
}

/* ------------------------------------------------------------------ *
 * Logout
 * ------------------------------------------------------------------ */

export interface LogoutRequest {
  readonly issuer: string;
  readonly subject: string;
  readonly sessionIndex: string | null;
  readonly signatureVerified: boolean;
}

/**
 * Single logout must terminate exactly the sessions belonging to the subject
 * the IdP named, and no others. An unsigned or foreign logout request that
 * were honoured would be a denial-of-service against every user.
 */
export function resolveLogoutTargets(
  request: LogoutRequest,
  config: FederationConfig,
  sessions: readonly { readonly sessionId: string; readonly tenantId: UUID; readonly subject: string; readonly sessionIndex: string | null }[],
): readonly string[] {
  if (!request.signatureVerified) {
    throw new FederationError('FEDERATION_SIGNATURE_NOT_VERIFIED', 'Logout request signature was not verified');
  }
  if (request.issuer !== config.issuer) {
    throw new FederationError('FEDERATION_ISSUER_MISMATCH', 'Logout request issuer is not the configured IdP');
  }
  return sessions
    .filter((session) => session.tenantId === config.tenantId && session.subject === request.subject)
    .filter((session) => request.sessionIndex === null || session.sessionIndex === request.sessionIndex)
    .map((session) => session.sessionId)
    .sort();
}
