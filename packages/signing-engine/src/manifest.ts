import { canonicalJson, type CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { sha256Hex } from '../../crypto/src/hash.js';

/**
 * The deterministic manifest binding every document in one signing intent.
 *
 * A signing intent may cover several documents, and the signer consents once, to
 * the set. Without a single artifact naming that set, "what was agreed to" is
 * only reconstructible by re-querying tables that may since have changed, and a
 * document quietly added or removed after the fact leaves no trace.
 *
 * Determinism is what makes the hash meaningful: the same set of documents must
 * always produce the same bytes, on any machine, in any order of retrieval. Entries
 * are therefore sorted by ordinal and serialised through canonical JSON rather
 * than trusted to arrive in a stable order.
 */

export const SIGNING_INTENT_MANIFEST_SCHEMA = 'kommunsign.signing-intent-manifest.v1';

export interface SigningIntentManifestDocument {
  readonly ordinal: number;
  readonly documentVersionId: string;
  readonly documentSha256: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly profile: string;
  readonly byteSize: number;
}

export interface SigningIntentManifest {
  readonly schema: typeof SIGNING_INTENT_MANIFEST_SCHEMA;
  readonly tenantId: string;
  readonly signatureCaseId: string;
  readonly signingIntentId: string;
  readonly signerId: string;
  readonly documents: readonly SigningIntentManifestDocument[];
}

export class SigningIntentManifestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SigningIntentManifestError';
  }
}

export function buildSigningIntentManifest(input: {
  readonly tenantId: string;
  readonly signatureCaseId: string;
  readonly signingIntentId: string;
  readonly signerId: string;
  readonly documents: readonly SigningIntentManifestDocument[];
}): SigningIntentManifest {
  if (input.documents.length === 0) {
    throw new SigningIntentManifestError('MANIFEST_EMPTY', 'a signing intent must cover at least one document');
  }

  const documents = [...input.documents].sort((left, right) => left.ordinal - right.ordinal);

  // Ordinals must be contiguous from 1. A gap means a document was dropped
  // between reading the intent and building the manifest, and a manifest that
  // silently renumbers around the gap would record a set nobody consented to.
  for (const [index, document] of documents.entries()) {
    if (document.ordinal !== index + 1) {
      throw new SigningIntentManifestError('MANIFEST_ORDINALS_NOT_CONTIGUOUS', 'document ordinals must be contiguous and start at 1');
    }
    if (!/^[0-9a-f]{64}$/.test(document.documentSha256)) {
      throw new SigningIntentManifestError('MANIFEST_DOCUMENT_HASH_INVALID', 'each document must carry a lowercase SHA-256 hex digest');
    }
    if (!Number.isSafeInteger(document.byteSize) || document.byteSize <= 0) {
      throw new SigningIntentManifestError('MANIFEST_DOCUMENT_SIZE_INVALID', 'each document must carry a positive byte size');
    }
  }

  const seen = new Set(documents.map((document) => document.documentVersionId));
  if (seen.size !== documents.length) {
    throw new SigningIntentManifestError('MANIFEST_DOCUMENT_DUPLICATED', 'a document version may appear only once in a signing intent');
  }

  return {
    schema: SIGNING_INTENT_MANIFEST_SCHEMA,
    tenantId: input.tenantId,
    signatureCaseId: input.signatureCaseId,
    signingIntentId: input.signingIntentId,
    signerId: input.signerId,
    documents,
  };
}

export function signingIntentManifestBytes(manifest: SigningIntentManifest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest as unknown as CanonicalJsonValue));
}

export async function signingIntentManifestSha256(manifest: SigningIntentManifest): Promise<string> {
  return sha256Hex(signingIntentManifestBytes(manifest));
}
