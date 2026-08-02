import type { DecisionMode, IdentityProviderName, SignatureLevel, UUID } from '../../contracts/src/index.js';

export interface SignaturePolicySnapshot {
  readonly id: UUID;
  readonly version: number;
  readonly name: string;
  readonly decisionMode: DecisionMode;
  readonly signatureLevel: SignatureLevel;
  readonly allowedIdentityProviders: readonly Exclude<IdentityProviderName, 'TEST_ONLY'>[];
  readonly minimumAssuranceLevel: string;
  readonly requiresExpectedSubject: boolean;
  readonly allowsQr: boolean;
  readonly requiresSigningOrder: boolean;
  readonly requiresAuthorityCheck: boolean;
  readonly requiresTimestamp: boolean;
  readonly requiredPadesLevel: 'NONE' | 'B' | 'T' | 'LT' | 'LTA';
  readonly allowedValidationResults: readonly ('TOTAL_PASSED' | 'INDETERMINATE')[];
  readonly retainOriginalDocument: boolean;
  readonly retentionDays: number | null;
  readonly reminderIntervalHours: number | null;
  readonly validityMinutes: number;
  readonly allowsDelegation: boolean;
  readonly allowedMimeTypes: readonly string[];
  readonly maximumDocumentBytes: number;
}

export interface PolicyValidationInput {
  readonly provider: IdentityProviderName;
  readonly expectedSubject?: string;
  readonly usesQr: boolean;
  readonly mimeType: string;
  readonly documentBytes: number;
}

export function validatePolicyUse(policy: SignaturePolicySnapshot, input: PolicyValidationInput): readonly string[] {
  const errors: string[] = [];
  if (input.provider === 'TEST_ONLY') errors.push('Test provider is never valid for a production policy');
  if (input.provider !== 'TEST_ONLY' && !policy.allowedIdentityProviders.includes(input.provider)) errors.push('Identity provider is not allowed');
  if (policy.requiresExpectedSubject && !input.expectedSubject) errors.push('Expected signer identity is required');
  if (input.usesQr && !policy.allowsQr) errors.push('QR flow is not allowed');
  if (!policy.allowedMimeTypes.includes(input.mimeType)) errors.push('Document MIME type is not allowed');
  if (input.documentBytes > policy.maximumDocumentBytes) errors.push('Document exceeds policy size limit');
  if (policy.decisionMode === 'ELECTRONIC_SIGNATURE' && policy.requiredPadesLevel === 'NONE') errors.push('Electronic signature policy must require a cryptographic signature format');
  if (policy.validityMinutes < 1) errors.push('Policy validity must be positive');
  return errors;
}

export function lockPolicy<T extends SignaturePolicySnapshot>(policy: T): Readonly<T> {
  return Object.freeze({ ...policy });
}
