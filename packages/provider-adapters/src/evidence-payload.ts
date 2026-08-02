import type { StartIdentitySignature } from '../../contracts/src/index.js';
import type { CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { canonicalJsonBytes } from '../../crypto/src/canonical-json.js';

export function bankIdEvidencePayload(input: StartIdentitySignature): CanonicalJsonValue {
  return {
    schema: 'kommunsign.bankid-evidence.v1',
    tenantId: input.tenantId,
    signatureCaseId: input.signatureCaseId,
    documentId: input.documentId,
    documentVersionId: input.documentVersionId,
    documentSha256: input.documentSha256,
    signaturePolicyId: input.signaturePolicyId,
    signaturePolicyVersion: input.signaturePolicyVersion,
    signerId: input.signerId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

export function bankIdEvidenceBytes(input: StartIdentitySignature): Uint8Array {
  return canonicalJsonBytes(bankIdEvidencePayload(input));
}
