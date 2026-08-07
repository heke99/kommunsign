/**
 * Provider-neutral resolution of electronic identity methods.
 *
 * Kommunsign must support BankID and Freja+ for people outside the
 * organisation, Freja OrgID for staff, and must be able to add Sverige-id,
 * foreign eID via eIDAS and qualified signatures later without rebuilding the
 * product. That only holds if no business logic names a provider directly:
 * callers ask for an *identity method* and the registry resolves which
 * provider serves it for that tenant.
 *
 * The registry is the security boundary's first gate, not its only one. A
 * method is usable only when the provider is registered, the tenant has the
 * feature enabled, and the signature policy allows it. Feature flags alone are
 * never the security boundary.
 */

import type { IdentityProviderName, SignatureLevel } from '../../contracts/src/index.js';

/** What the caller asks for. Stable across providers. */
export const IDENTITY_METHODS = [
  'BANKID',
  'FREJA_PLUS',
  'FREJA_ORGID',
  'SVERIGE_ID',
  'EIDAS',
  'TEST_ONLY',
] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];

/** Who serves it. Adding a provider must not change any caller. */
export const IDENTITY_PROVIDERS = ['TIC_BANKID', 'FREJA', 'SWEDEN_CONNECT', 'TEST_ONLY'] as const;
export type IdentityProviderKey = (typeof IDENTITY_PROVIDERS)[number];

/** Tenant feature keys, stored in control.tenant_features.feature_key. */
export const IDENTITY_FEATURE_FLAGS = [
  'BANKID',
  'FREJA_PLUS',
  'FREJA_ORGID',
  'SWEDEN_CONNECT',
  'SVERIGE_ID',
  'EIDAS',
  'QES',
] as const;
export type IdentityFeatureFlag = (typeof IDENTITY_FEATURE_FLAGS)[number];

/**
 * Assurance levels as used by Sweden Connect / eIDAS. Ordered, so a policy can
 * demand a minimum without knowing which provider satisfies it.
 */
export const ASSURANCE_LEVELS = ['LOW', 'SUBSTANTIAL', 'HIGH'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export function assuranceAtLeast(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ASSURANCE_LEVELS.indexOf(actual) >= ASSURANCE_LEVELS.indexOf(required);
}

export interface IdentityCapabilities {
  readonly provider: IdentityProviderKey;
  readonly method: IdentityMethod;
  readonly featureFlag: IdentityFeatureFlag;
  readonly maximumAssurance: AssuranceLevel;
  /** True for methods that carry a verified organisational identity. */
  readonly carriesOrganisationIdentity: boolean;
  readonly supportsQr: boolean;
  /** Highest signature level this method can support once fully integrated. */
  readonly maximumSignatureLevel: SignatureLevel;
  /**
   * False while the adapter exists but has no live provider integration. Such a
   * method resolves only in non-production environments, and never silently.
   */
  readonly productionReady: boolean;
  /** What is still missing before productionReady can become true. */
  readonly blocker?: string;
}

/**
 * The capability table is the single place that describes what each method can
 * do. `productionReady: false` is deliberate and load-bearing: it is what stops
 * an unfinished integration from being used for a real signature.
 */
export const IDENTITY_CAPABILITIES: readonly IdentityCapabilities[] = [
  {
    provider: 'TIC_BANKID', method: 'BANKID', featureFlag: 'BANKID',
    maximumAssurance: 'HIGH', carriesOrganisationIdentity: false, supportsQr: true,
    maximumSignatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE', productionReady: true,
  },
  {
    provider: 'FREJA', method: 'FREJA_PLUS', featureFlag: 'FREJA_PLUS',
    maximumAssurance: 'HIGH', carriesOrganisationIdentity: false, supportsQr: true,
    maximumSignatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE', productionReady: false,
    blocker: 'Freja production credentials, mTLS client certificate and relying-party agreement are missing. The adapter and its JWS binding checks are implemented (packages/provider-adapters/src/freja.ts).',
  },
  {
    provider: 'FREJA', method: 'FREJA_ORGID', featureFlag: 'FREJA_ORGID',
    maximumAssurance: 'HIGH', carriesOrganisationIdentity: true, supportsQr: true,
    maximumSignatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE', productionReady: false,
    blocker: 'Freja production credentials, mTLS client certificate and relying-party agreement are missing. The adapter and its JWS binding checks are implemented (packages/provider-adapters/src/freja.ts).',
  },
  {
    provider: 'SWEDEN_CONNECT', method: 'SVERIGE_ID', featureFlag: 'SVERIGE_ID',
    maximumAssurance: 'HIGH', carriesOrganisationIdentity: false, supportsQr: false,
    maximumSignatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE', productionReady: false,
    blocker: 'Sweden Connect federation metadata, certificates and onboarding are not in place',
  },
  {
    provider: 'SWEDEN_CONNECT', method: 'EIDAS', featureFlag: 'EIDAS',
    maximumAssurance: 'SUBSTANTIAL', carriesOrganisationIdentity: false, supportsQr: false,
    maximumSignatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE', productionReady: false,
    blocker: 'eIDAS node connection through Sweden Connect is not established',
  },
  {
    provider: 'TEST_ONLY', method: 'TEST_ONLY', featureFlag: 'BANKID',
    maximumAssurance: 'LOW', carriesOrganisationIdentity: false, supportsQr: false,
    maximumSignatureLevel: 'DIGITAL_APPROVAL', productionReady: false,
    blocker: 'Test provider is never valid outside development',
  },
];

export function capabilitiesFor(method: IdentityMethod): IdentityCapabilities {
  const found = IDENTITY_CAPABILITIES.find((capability) => capability.method === method);
  if (!found) throw new IdentityRegistryError('IDENTITY_METHOD_UNKNOWN', `Unknown identity method ${method}`);
  return found;
}

export class IdentityRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'IdentityRegistryError';
  }
}

export type RuntimeEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface IdentityResolutionRequest {
  readonly method: IdentityMethod;
  readonly environment: RuntimeEnvironment;
  /** Feature keys enabled for this tenant in control.tenant_features. */
  readonly enabledFeatures: readonly IdentityFeatureFlag[];
  /** Methods the signature policy permits. The policy is authoritative. */
  readonly policyAllowedMethods: readonly IdentityMethod[];
  readonly requiredAssurance: AssuranceLevel;
  readonly requiredSignatureLevel: SignatureLevel;
  /** True when the signer must be identified as acting for an organisation. */
  readonly requiresOrganisationIdentity?: boolean;
}

export interface ResolvedIdentityMethod {
  readonly method: IdentityMethod;
  readonly provider: IdentityProviderKey;
  readonly capabilities: IdentityCapabilities;
}

const SIGNATURE_LEVEL_ORDER: readonly SignatureLevel[] = [
  'DIGITAL_APPROVAL',
  'ELECTRONIC_SIGNATURE',
  'ADVANCED_ELECTRONIC_SIGNATURE',
  'QUALIFIED_ELECTRONIC_SIGNATURE_FUTURE',
];

function signatureLevelAtLeast(actual: SignatureLevel, required: SignatureLevel): boolean {
  return SIGNATURE_LEVEL_ORDER.indexOf(actual) >= SIGNATURE_LEVEL_ORDER.indexOf(required);
}

/**
 * Resolves an identity method to a provider, or throws. Every gate fails
 * closed: an unavailable method is an error, never a silent downgrade to a
 * weaker method or to a test provider.
 */
export function resolveIdentityMethod(request: IdentityResolutionRequest): ResolvedIdentityMethod {
  const capabilities = capabilitiesFor(request.method);
  const isProduction = request.environment === 'production' || request.environment === 'staging';

  // The test provider must never be reachable from a production-like runtime,
  // regardless of flags or policy.
  if (request.method === 'TEST_ONLY' && isProduction) {
    throw new IdentityRegistryError('IDENTITY_TEST_PROVIDER_FORBIDDEN', 'Test identity provider is forbidden outside development');
  }
  if (isProduction && !capabilities.productionReady) {
    throw new IdentityRegistryError(
      'IDENTITY_METHOD_NOT_PRODUCTION_READY',
      `${request.method} is not available in production: ${capabilities.blocker ?? 'integration incomplete'}`,
    );
  }
  if (!request.policyAllowedMethods.includes(request.method)) {
    throw new IdentityRegistryError('IDENTITY_METHOD_NOT_ALLOWED_BY_POLICY', `Signature policy does not allow ${request.method}`);
  }
  if (!request.enabledFeatures.includes(capabilities.featureFlag)) {
    throw new IdentityRegistryError('IDENTITY_METHOD_NOT_ENABLED', `${capabilities.featureFlag} is not enabled for this tenant`);
  }
  if (!assuranceAtLeast(capabilities.maximumAssurance, request.requiredAssurance)) {
    throw new IdentityRegistryError(
      'IDENTITY_ASSURANCE_INSUFFICIENT',
      `${request.method} cannot reach assurance ${request.requiredAssurance}`,
    );
  }
  // Qualified signatures require a qualified trust service provider. Until one
  // is integrated the level is not offered at all, rather than approximated.
  if (request.requiredSignatureLevel === 'QUALIFIED_ELECTRONIC_SIGNATURE_FUTURE') {
    throw new IdentityRegistryError(
      'SIGNATURE_LEVEL_QUALIFIED_UNAVAILABLE',
      'Qualified electronic signature requires an integrated QTSP and is not available',
    );
  }
  if (!signatureLevelAtLeast(capabilities.maximumSignatureLevel, request.requiredSignatureLevel)) {
    throw new IdentityRegistryError(
      'SIGNATURE_LEVEL_UNSUPPORTED',
      `${request.method} cannot produce ${request.requiredSignatureLevel}`,
    );
  }
  if (request.requiresOrganisationIdentity && !capabilities.carriesOrganisationIdentity) {
    throw new IdentityRegistryError(
      'IDENTITY_ORGANISATION_REQUIRED',
      `${request.method} does not carry a verified organisational identity`,
    );
  }
  return { method: request.method, provider: capabilities.provider, capabilities };
}

/**
 * Methods a tenant can currently offer. Used to render the signer's choice and
 * to decide whether an outage leaves any usable method: if one provider is
 * down, the others remain available, but the caller must never react by
 * lowering the required assurance.
 */
export function availableMethods(
  request: Omit<IdentityResolutionRequest, 'method'>,
  unavailableProviders: readonly IdentityProviderKey[] = [],
): readonly ResolvedIdentityMethod[] {
  const resolved: ResolvedIdentityMethod[] = [];
  for (const method of IDENTITY_METHODS) {
    if (unavailableProviders.includes(capabilitiesFor(method).provider)) continue;
    try {
      resolved.push(resolveIdentityMethod({ ...request, method }));
    } catch {
      // A method that does not resolve is simply not offered.
    }
  }
  return resolved;
}

/** Maps a resolved provider to the legacy contracts-level provider name. */
export function toContractsProviderName(provider: IdentityProviderKey): IdentityProviderName {
  switch (provider) {
    case 'TIC_BANKID': return 'TIC_BANKID';
    case 'FREJA': return 'FREJA_DIRECT';
    case 'TEST_ONLY': return 'TEST_ONLY';
    case 'SWEDEN_CONNECT':
      throw new IdentityRegistryError('IDENTITY_PROVIDER_UNMAPPED', 'Sweden Connect has no contracts-level provider name yet');
  }
}
