import type { StartIdentitySignature } from '../../contracts/src/index.js';
import type { CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { canonicalJsonBytes } from '../../crypto/src/canonical-json.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function bankIdEvidencePayload(input: StartIdentitySignature): CanonicalJsonValue {
  const documents = [...input.documents].sort((left, right) => left.ordinal - right.ordinal).map((document, index) => {
    if (document.ordinal !== index + 1) throw new Error('SIGNING_INTENT_DOCUMENT_ORDINAL_INVALID');
    if (!SHA256.test(document.sha256)) throw new Error('DOCUMENT_SHA256_INVALID');
    if (!Number.isSafeInteger(document.byteSize) || document.byteSize < 1) throw new Error('DOCUMENT_BYTE_SIZE_INVALID');
    return {
      ordinal: document.ordinal,
      documentId: document.documentId,
      documentVersionId: document.documentVersionId,
      displayName: document.displayName,
      mimeType: document.mimeType,
      profile: document.profile,
      byteSize: document.byteSize,
      sha256: document.sha256,
    } as const;
  });
  if (!documents.length) throw new Error('SIGNING_INTENT_DOCUMENTS_REQUIRED');
  if (input.identifierBindingMode === 'STRICT_PREBOUND' && !/^\d{12}$/.test(input.expectedPersonalNumber ?? '')) {
    throw new Error('PERSONAL_NUMBER_REQUIRED');
  }
  if (input.identifierBindingMode === 'BANKID_DISCOVERED' && !input.identifierBindingExceptionCode) {
    throw new Error('PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED');
  }
  return {
    schema: 'kommunsign.bankid-evidence.v2',
    tenantId: input.tenantId,
    signatureCaseId: input.signatureCaseId,
    signingIntentId: input.signingIntentId,
    signerId: input.signerId,
    identifierBindingMode: input.identifierBindingMode,
    identifierBindingExceptionCode: input.identifierBindingExceptionCode ?? null,
    signaturePolicyId: input.signaturePolicyId,
    signaturePolicyVersion: input.signaturePolicyVersion,
    documents,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

export function bankIdEvidenceBytes(input: StartIdentitySignature): Uint8Array {
  return canonicalJsonBytes(bankIdEvidencePayload(input));
}

export function bankIdEvidenceText(input: StartIdentitySignature): string {
  return new TextDecoder().decode(bankIdEvidenceBytes(input));
}
