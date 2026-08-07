/**
 * Freja eID adapter (Freja eID, Freja eID Plus, Freja OrgID).
 *
 * Kungälv F002 requires signing with Freja OrgID for staff and F003 requires
 * Freja+ for people outside the organisation. Both run over the same provider,
 * so this is one adapter with a method parameter rather than two integrations.
 *
 * The cryptography lives in the identity service behind mTLS: JWS signature
 * verification needs Freja's rotating verification keys and a certificate
 * chain, and neither belongs in the application core. What lives here is the
 * part that is pure and that decides whether a *cryptographically valid*
 * response may be accepted — which is a different question, and the one that
 * actually goes wrong in practice.
 *
 * A correctly signed Freja response still must not be accepted when it belongs
 * to another transaction, another tenant, another document, or a previous
 * attempt. Signature validity proves the message came from Freja. It proves
 * nothing about which signing intent it answers. Every binding below exists
 * because omitting it lets a genuine Freja response complete the wrong case.
 */

import type {
  ElectronicIdentityProvider, IdentityEvidence, IdentitySession, IdentityStatus,
  StartIdentitySignature, VerifiedIdentityEvidence,
} from '../../contracts/src/index.js';

/* ------------------------------------------------------------------ *
 * Methods, subjects and assurance
 * ------------------------------------------------------------------ */

export const FREJA_METHODS = ['FREJA_EID', 'FREJA_PLUS', 'FREJA_ORGID'] as const;
export type FrejaMethod = (typeof FREJA_METHODS)[number];

/** Freja's registration levels, ordered weakest to strongest. */
export const FREJA_REGISTRATION_LEVELS = ['BASIC', 'EXTENDED', 'PLUS'] as const;
export type FrejaRegistrationLevel = (typeof FREJA_REGISTRATION_LEVELS)[number];

export type FrejaSubjectType = 'INFERRED' | 'PHONE' | 'EMAIL' | 'SSN' | 'UPI';

export class FrejaConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'FrejaConfigurationError'; }
}

export type FrejaRejectionCode =
  | 'FREJA_WRONG_PROVIDER'
  | 'FREJA_SIGNATURE_NOT_VERIFIED'
  | 'FREJA_ALGORITHM_NOT_ALLOWED'
  | 'FREJA_ISSUER_MISMATCH'
  | 'FREJA_AUDIENCE_MISMATCH'
  | 'FREJA_TRANSACTION_MISMATCH'
  | 'FREJA_INTENT_MISMATCH'
  | 'FREJA_DOCUMENT_MISMATCH'
  | 'FREJA_NONCE_MISMATCH'
  | 'FREJA_NONCE_REPLAYED'
  | 'FREJA_RESPONSE_EXPIRED'
  | 'FREJA_ISSUED_IN_FUTURE'
  | 'FREJA_REGISTRATION_LEVEL_TOO_LOW'
  | 'FREJA_SUBJECT_TYPE_NOT_ALLOWED'
  | 'FREJA_ORGANISATION_IDENTITY_MISSING'
  | 'FREJA_ORGANISATION_MISMATCH'
  | 'FREJA_STATUS_NOT_APPROVED';

export class FrejaVerificationError extends Error {
  constructor(readonly code: FrejaRejectionCode, message: string) {
    super(message);
    this.name = 'FrejaVerificationError';
  }
}

/**
 * INFERRED lets Freja pick the subject itself. That is acceptable for a
 * low-stakes login and never acceptable for a person-bound sensitive document,
 * where the whole point is that we know who signed.
 */
export function assertFrejaSubjectType(
  subjectType: FrejaSubjectType,
  classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'HIGHLY_CONFIDENTIAL',
): void {
  if (subjectType === 'INFERRED' && (classification === 'CONFIDENTIAL' || classification === 'HIGHLY_CONFIDENTIAL')) {
    throw new FrejaVerificationError(
      'FREJA_SUBJECT_TYPE_NOT_ALLOWED',
      'INFERRED Freja subject is forbidden for person-bound sensitive documents',
    );
  }
}

/**
 * Maps Freja's registration level onto the assurance vocabulary the identity
 * registry uses. BASIC is self-registered and must never be presented as a
 * formal Swedish identity, so it maps to LOW and is refused by any policy that
 * requires SUBSTANTIAL or above.
 */
export function frejaAssuranceLevel(level: FrejaRegistrationLevel): 'LOW' | 'SUBSTANTIAL' | 'HIGH' {
  switch (level) {
    case 'BASIC': return 'LOW';
    case 'EXTENDED': return 'SUBSTANTIAL';
    case 'PLUS': return 'HIGH';
  }
}

export function registrationLevelAtLeast(actual: FrejaRegistrationLevel, required: FrejaRegistrationLevel): boolean {
  return FREJA_REGISTRATION_LEVELS.indexOf(actual) >= FREJA_REGISTRATION_LEVELS.indexOf(required);
}

/* ------------------------------------------------------------------ *
 * Signature response verification
 * ------------------------------------------------------------------ */

/**
 * The claims we require from a Freja sign response, after the identity service
 * has verified the JWS signature. `signatureVerified` is passed in rather than
 * assumed, so that a caller which forgot to verify cannot accidentally pass
 * this gate.
 */
export interface FrejaSignatureClaims {
  readonly signatureVerified: boolean;
  readonly algorithm: string;
  readonly issuer: string;
  readonly audience: string;
  readonly transactionReference: string;
  /** Echoed back from the sign request; binds the response to our intent. */
  readonly signRef: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly subjectType: FrejaSubjectType;
  readonly subject: string;
  readonly personalNumber?: string;
  readonly displayName?: string;
  readonly registrationLevel: FrejaRegistrationLevel;
  /** SHA-256 of the data Freja displayed and signed over. */
  readonly signedDataSha256: string;
  /** Present only for OrgID. Carries the verified organisation identity. */
  readonly organisationId?: string;
  readonly organisationIdentifier?: string;
}

export interface FrejaExpectation {
  readonly method: FrejaMethod;
  readonly issuer: string;
  readonly audience: string;
  readonly transactionReference: string;
  readonly signRef: string;
  readonly nonce: string;
  readonly signedDataSha256: string;
  readonly minimumRegistrationLevel: FrejaRegistrationLevel;
  readonly allowedAlgorithms: readonly string[];
  /** Required for OrgID: the tenant's own organisation in Freja. */
  readonly expectedOrganisationId?: string;
  readonly documentClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'HIGHLY_CONFIDENTIAL';
  /** Maximum age we accept, independent of what the response claims. */
  readonly maximumResponseAgeSeconds: number;
}

/** Records nonces already consumed, so a replayed response is refused. */
export interface FrejaNonceLedger {
  /** True when the nonce had not been seen before and is now consumed. */
  consume(nonce: string): boolean;
}

/** In-memory ledger for a single process. Production uses the database. */
export class InMemoryFrejaNonceLedger implements FrejaNonceLedger {
  private readonly seen = new Set<string>();
  consume(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

function parseInstant(value: string, code: FrejaRejectionCode): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new FrejaVerificationError(code, `Invalid timestamp ${value}`);
  return parsed;
}

/**
 * Every check that decides whether a signed Freja response may complete *this*
 * signing intent. Throws on the first failure; there is no partial acceptance.
 */
export function verifyFrejaSignatureClaims(
  claims: FrejaSignatureClaims,
  expectation: FrejaExpectation,
  nonces: FrejaNonceLedger,
  now: Date,
): void {
  // Signature first. Nothing below means anything on an unverified message.
  if (!claims.signatureVerified) {
    throw new FrejaVerificationError('FREJA_SIGNATURE_NOT_VERIFIED', 'Freja JWS signature was not verified');
  }
  // An allow-list, not a deny-list: an unexpected algorithm is refused rather
  // than trusted because it is not on a list of known-bad ones.
  if (!expectation.allowedAlgorithms.includes(claims.algorithm)) {
    throw new FrejaVerificationError('FREJA_ALGORITHM_NOT_ALLOWED', `Algorithm ${claims.algorithm} is not allowed`);
  }
  if (claims.issuer !== expectation.issuer) {
    throw new FrejaVerificationError('FREJA_ISSUER_MISMATCH', 'Freja response issuer does not match');
  }
  // Without the audience check, a response minted for another relying party
  // that happens to share Freja's signing key would be accepted here.
  if (claims.audience !== expectation.audience) {
    throw new FrejaVerificationError('FREJA_AUDIENCE_MISMATCH', 'Freja response audience does not match this relying party');
  }
  if (claims.status.toUpperCase() !== 'APPROVED') {
    throw new FrejaVerificationError('FREJA_STATUS_NOT_APPROVED', `Freja reported status ${claims.status}`);
  }

  // The three bindings that tie a valid response to this specific intent.
  if (claims.transactionReference !== expectation.transactionReference) {
    throw new FrejaVerificationError('FREJA_TRANSACTION_MISMATCH', 'Freja response belongs to another transaction');
  }
  if (claims.signRef !== expectation.signRef) {
    throw new FrejaVerificationError('FREJA_INTENT_MISMATCH', 'Freja response belongs to another signing intent');
  }
  if (claims.signedDataSha256 !== expectation.signedDataSha256) {
    throw new FrejaVerificationError('FREJA_DOCUMENT_MISMATCH', 'Freja signed different data than the intent');
  }

  if (claims.nonce !== expectation.nonce) {
    throw new FrejaVerificationError('FREJA_NONCE_MISMATCH', 'Freja response nonce does not match the request');
  }
  // Matching the nonce is not enough: the same genuine response replayed twice
  // matches both times. It may only be consumed once.
  if (!nonces.consume(claims.nonce)) {
    throw new FrejaVerificationError('FREJA_NONCE_REPLAYED', 'Freja response nonce has already been used');
  }

  const current = now.getTime();
  const issuedAt = parseInstant(claims.issuedAt, 'FREJA_ISSUED_IN_FUTURE');
  const expiresAt = parseInstant(claims.expiresAt, 'FREJA_RESPONSE_EXPIRED');
  if (issuedAt > current) {
    throw new FrejaVerificationError('FREJA_ISSUED_IN_FUTURE', 'Freja response is issued in the future');
  }
  if (expiresAt <= current) {
    throw new FrejaVerificationError('FREJA_RESPONSE_EXPIRED', 'Freja response has expired');
  }
  // We also bound the age ourselves. A response whose own expiry is set far in
  // the future must not stay usable for that long.
  if (current - issuedAt > expectation.maximumResponseAgeSeconds * 1000) {
    throw new FrejaVerificationError('FREJA_RESPONSE_EXPIRED', 'Freja response is older than the accepted window');
  }

  if (!registrationLevelAtLeast(claims.registrationLevel, expectation.minimumRegistrationLevel)) {
    throw new FrejaVerificationError(
      'FREJA_REGISTRATION_LEVEL_TOO_LOW',
      `Registration level ${claims.registrationLevel} is below the required ${expectation.minimumRegistrationLevel}`,
    );
  }
  assertFrejaSubjectType(claims.subjectType, expectation.documentClassification);

  // OrgID is the only method that carries a verified organisation identity, so
  // it is the only one that may satisfy a requirement for one — and it must be
  // *our* organisation, not any organisation.
  if (expectation.method === 'FREJA_ORGID') {
    if (!claims.organisationId) {
      throw new FrejaVerificationError('FREJA_ORGANISATION_IDENTITY_MISSING', 'Freja OrgID response carries no organisation identity');
    }
    if (expectation.expectedOrganisationId && claims.organisationId !== expectation.expectedOrganisationId) {
      throw new FrejaVerificationError('FREJA_ORGANISATION_MISMATCH', 'Freja organisation identity belongs to another organisation');
    }
  }
}

/**
 * Normalises verified claims into the shape the rest of the system consumes,
 * so no caller has to know Freja's vocabulary.
 */
export function toVerifiedIdentityEvidence(
  claims: FrejaSignatureClaims,
  evidence: IdentityEvidence,
  verifiedAt: string,
): VerifiedIdentityEvidence {
  return {
    provider: 'FREJA_DIRECT',
    providerReference: claims.transactionReference,
    subject: claims.subject,
    ...(claims.personalNumber ? { personalNumber: claims.personalNumber } : {}),
    ...(claims.displayName ? { displayName: claims.displayName } : {}),
    assuranceLevel: frejaAssuranceLevel(claims.registrationLevel),
    signedPayloadSha256: claims.signedDataSha256,
    verificationChecks: [{
      subjectType: claims.subjectType,
      registrationLevel: claims.registrationLevel,
      ...(claims.organisationId ? { organisationId: claims.organisationId } : {}),
    }],
    verifiedAt,
    originalEvidence: evidence,
  };
}

/* ------------------------------------------------------------------ *
 * Gateway boundary
 * ------------------------------------------------------------------ */

/**
 * The Freja gateway runs in the identity service over mTLS. Private keys come
 * from an HSM or managed vault and never exist in an image or in Git.
 */
export interface FrejaGatewayClient extends ElectronicIdentityProvider {
  readonly transport: 'MTLS_JAVA_GATEWAY';
}

/** Verifies the JWS itself. Implemented by the identity service. */
export interface FrejaSignatureVerifier {
  verifyJws(compactJws: string): Promise<FrejaSignatureClaims>;
}

/**
 * The default. An unconfigured deployment refuses rather than accepting an
 * unverified response, for the same reason RejectingTicEvidenceVerifier does.
 */
export class RejectingFrejaSignatureVerifier implements FrejaSignatureVerifier {
  async verifyJws(): Promise<FrejaSignatureClaims> {
    throw new FrejaConfigurationError('Freja JWS verifier is not configured');
  }
}

export interface FrejaConfig {
  readonly method: FrejaMethod;
  readonly issuer: string;
  readonly audience: string;
  readonly minimumRegistrationLevel: FrejaRegistrationLevel;
  readonly allowedAlgorithms: readonly string[];
  readonly maximumResponseAgeSeconds: number;
  readonly expectedOrganisationId?: string;
}

/**
 * Ties the pieces together: the gateway performs the protocol, the verifier
 * checks the JWS, and this class enforces the bindings before any evidence is
 * handed on. Every path that produces verified evidence goes through
 * verifyFrejaSignatureClaims — there is no second, laxer route.
 */
export class FrejaProvider implements ElectronicIdentityProvider {
  constructor(
    private readonly config: FrejaConfig,
    private readonly gateway: FrejaGatewayClient,
    private readonly verifier: FrejaSignatureVerifier = new RejectingFrejaSignatureVerifier(),
    private readonly nonces: FrejaNonceLedger = new InMemoryFrejaNonceLedger(),
    private readonly expectationFor: (providerReference: string) => Promise<Pick<
      FrejaExpectation, 'transactionReference' | 'signRef' | 'nonce' | 'signedDataSha256' | 'documentClassification'
    >> = async () => { throw new FrejaConfigurationError('Freja expectation lookup is not configured'); },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  startSignature(input: StartIdentitySignature): Promise<IdentitySession> {
    return this.gateway.startSignature(input);
  }
  getStatus(sessionId: string): Promise<IdentityStatus> { return this.gateway.getStatus(sessionId); }
  collectEvidence(sessionId: string): Promise<IdentityEvidence> { return this.gateway.collectEvidence(sessionId); }
  cancel(sessionId: string): Promise<void> { return this.gateway.cancel(sessionId); }

  async verifyEvidence(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence> {
    if (evidence.provider !== 'FREJA_DIRECT') {
      throw new FrejaVerificationError('FREJA_WRONG_PROVIDER', 'Evidence does not come from Freja');
    }
    const payload = evidence.rawPayload;
    if (!payload || typeof payload !== 'object' || typeof (payload as { jws?: unknown }).jws !== 'string') {
      throw new FrejaVerificationError('FREJA_SIGNATURE_NOT_VERIFIED', 'Freja evidence carries no compact JWS');
    }
    const claims = await this.verifier.verifyJws((payload as { jws: string }).jws);
    const bound = await this.expectationFor(evidence.providerReference);
    verifyFrejaSignatureClaims(
      claims,
      {
        method: this.config.method,
        issuer: this.config.issuer,
        audience: this.config.audience,
        minimumRegistrationLevel: this.config.minimumRegistrationLevel,
        allowedAlgorithms: this.config.allowedAlgorithms,
        maximumResponseAgeSeconds: this.config.maximumResponseAgeSeconds,
        ...(this.config.expectedOrganisationId ? { expectedOrganisationId: this.config.expectedOrganisationId } : {}),
        ...bound,
      },
      this.nonces,
      this.clock(),
    );
    return toVerifiedIdentityEvidence(claims, evidence, this.clock().toISOString());
  }
}
