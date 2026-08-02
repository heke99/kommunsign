export type UUID = string;
export type IsoDateTime = string;

export const CASE_STATUSES = [
  'draft', 'preparing', 'ready', 'sent', 'in_progress', 'partially_signed',
  'completed', 'declined', 'expired', 'cancelled', 'failed', 'archiving', 'archived',
] as const;
export type SignatureCaseStatus = (typeof CASE_STATUSES)[number];

export const SIGNER_STATUSES = [
  'pending', 'invited', 'opened', 'identity_started', 'identity_verified',
  'signing', 'signed', 'declined', 'expired', 'cancelled', 'failed',
] as const;
export type SignerStatus = (typeof SIGNER_STATUSES)[number];

export const DOCUMENT_STATUSES = [
  'uploaded', 'quarantined', 'scanning', 'rejected', 'canonicalizing', 'ready',
  'locked', 'partially_signed', 'signed', 'validated', 'archived',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export type DecisionMode = 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
export type SignatureLevel =
  | 'DIGITAL_APPROVAL'
  | 'ELECTRONIC_SIGNATURE'
  | 'ADVANCED_ELECTRONIC_SIGNATURE'
  | 'QUALIFIED_ELECTRONIC_SIGNATURE_FUTURE';

export type IdentityProviderName = 'TIC_BANKID' | 'FREJA_DIRECT' | 'TEST_ONLY';
export type IdentityStatus =
  | 'PENDING'
  | 'USER_ACTION_REQUIRED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';

export interface TenantContext {
  readonly tenantId: UUID;
  readonly source: 'verified-domain' | 'membership' | 'api-client' | 'deployment';
  readonly subjectId: UUID;
  readonly requestId: string;
}

export interface StartIdentitySignature {
  readonly tenantId: UUID;
  readonly signatureCaseId: UUID;
  readonly documentId: UUID;
  readonly documentVersionId: UUID;
  readonly documentSha256: string;
  readonly signaturePolicyId: UUID;
  readonly signaturePolicyVersion: number;
  readonly signerId: UUID;
  readonly expectedSubject?: string;
  readonly visibleText: string;
  readonly endUserIp: string;
  readonly userAgent: string;
  readonly issuedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly state: string;
  readonly nonce: string;
}

export interface IdentitySession {
  readonly id: string;
  readonly provider: IdentityProviderName;
  readonly status: IdentityStatus;
  readonly providerReference: string;
  readonly autoStartToken?: string;
  readonly qrStartToken?: string;
  readonly qrStartSecret?: string;
  readonly subscriptionToken?: string;
  readonly orderReference?: string;
  readonly expiresAt: IsoDateTime;
}

export interface IdentityEvidence {
  readonly provider: IdentityProviderName;
  readonly providerReference: string;
  readonly rawPayload: unknown;
  readonly collectedAt: IsoDateTime;
}

export interface VerifiedIdentityEvidence {
  readonly provider: IdentityProviderName;
  readonly providerReference: string;
  readonly subject: string;
  readonly displayName?: string;
  readonly assuranceLevel: string;
  readonly signedPayloadSha256: string;
  readonly verifiedAt: IsoDateTime;
  readonly originalEvidence: IdentityEvidence;
}

export interface ElectronicIdentityProvider {
  startSignature(input: StartIdentitySignature): Promise<IdentitySession>;
  getStatus(sessionId: string): Promise<IdentityStatus>;
  collectEvidence(sessionId: string): Promise<IdentityEvidence>;
  cancel(sessionId: string): Promise<void>;
  verifyEvidence(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence>;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export interface DomainEvent<T = Readonly<Record<string, unknown>>> {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly type: string;
  readonly occurredAt: IsoDateTime;
  readonly apiVersion: '2026-08-01';
  readonly data: T;
}
