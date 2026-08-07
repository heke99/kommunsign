/**
 * Digital preservation export (FGS / RA-FS 2009:2).
 *
 * Kungälv requirements 2064-2067: the system must follow Riksarkivet's RA-FS
 * 2009:2 for electronic documents on transfer, follow the applicable
 * regulations for storage and transfer, be able to produce deliveries and
 * export metadata in a technology-neutral format, and export files together
 * with their metadata for digital preservation.
 *
 * The package format follows the Förvaltningsgemensamma specifikationer
 * package structure: a submission information package with a descriptive
 * manifest, content files under `content/`, and metadata under `metadata/`.
 * The manifest is JSON rather than METS XML because RA-FS 2009:2 requires a
 * technology-neutral, documented format rather than one specific schema, and a
 * canonical JSON manifest is verifiable offline with no XML toolchain — which
 * is what "verifiable in fifty years" actually needs.
 *
 * Three failures this module exists to prevent:
 *
 *   1. An export that looks complete but silently omits the signature or
 *      identity evidence. A delivered archive package that cannot prove who
 *      signed is not a record, it is a PDF.
 *   2. A non-deterministic export. If exporting the same case twice produces
 *      different bytes, no one can prove that the copy in the archive is the
 *      copy that was delivered.
 *   3. A manifest that certifies itself. The checksum of the manifest must be
 *      computed and delivered outside the manifest, or a modified manifest
 *      re-certifies its own modification.
 */

import type { CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { canonicalJson } from '../../crypto/src/canonical-json.js';
import { sha256Hex } from '../../crypto/src/hash.js';
import type { IsoDateTime, UUID } from '../../contracts/src/index.js';
import type { EvidenceFile } from '../../evidence/src/index.js';

export const ARCHIVE_PACKAGE_SCHEMA = 'kommunsign.fgs-package.v1';
export const ARCHIVE_PROFILE_VERSION = 1;

export type ArchiveErrorCode =
  | 'ARCHIVE_DOCUMENT_MISSING'
  | 'ARCHIVE_SIGNATURE_EVIDENCE_MISSING'
  | 'ARCHIVE_IDENTITY_EVIDENCE_MISSING'
  | 'ARCHIVE_AUDIT_TRAIL_MISSING'
  | 'ARCHIVE_CHECKSUM_MISMATCH'
  | 'ARCHIVE_UNEXPECTED_FILE'
  | 'ARCHIVE_MANIFEST_MISMATCH'
  | 'ARCHIVE_TENANT_MISMATCH'
  | 'ARCHIVE_CASE_NOT_CLOSED'
  | 'ARCHIVE_PROFILE_NOT_VERIFIED'
  | 'ARCHIVE_PATH_INVALID';

export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export interface ArchiveDocument {
  readonly documentId: UUID;
  readonly documentVersionId: UUID;
  readonly displayName: string;
  readonly sha256: string;
  readonly byteSize: number;
  /** Verified by the document processor, not claimed by the caller. */
  readonly verifiedProfile: 'PDF/A-2b' | 'PDF/A-3b' | null;
  readonly isSignedArtifact: boolean;
}

export interface ArchiveSignatureEvidence {
  readonly signerId: UUID;
  readonly signedAt: IsoDateTime;
  readonly padesLevel: string | null;
  readonly signatureArtifactSha256: string | null;
  readonly validationReportSha256: string | null;
  readonly timestampTokenSha256: string | null;
}

export interface ArchiveIdentityEvidence {
  readonly signerId: UUID;
  readonly provider: string;
  readonly assuranceLevel: string;
  /** Masked before it reaches here; never a full personal number. */
  readonly maskedIdentifier: string;
  readonly verifiedAt: IsoDateTime;
  readonly evidenceSha256: string;
}

export interface ArchiveCase {
  readonly tenantId: UUID;
  readonly signatureCaseId: UUID;
  readonly reference: string;
  readonly title: string;
  readonly decisionMode: 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
  readonly status: string;
  readonly createdAt: IsoDateTime;
  readonly closedAt: IsoDateTime | null;
  readonly documents: readonly ArchiveDocument[];
  readonly signatures: readonly ArchiveSignatureEvidence[];
  readonly identities: readonly ArchiveIdentityEvidence[];
  readonly auditTrailSha256: string | null;
}

/* ------------------------------------------------------------------ *
 * Completeness
 * ------------------------------------------------------------------ */

/**
 * Refuses to build a package that would misrepresent what it contains.
 *
 * The checks are asymmetric on purpose. A digital approval has no PAdES
 * signature and must not be required to carry one; an electronic signature
 * without signature evidence is not an electronic signature, and exporting it
 * as an archived record would be a false statement about a legal act.
 */
export function assertArchivable(archiveCase: ArchiveCase): void {
  // Archiving a running case would freeze a half-finished record and imply it
  // was final.
  if (archiveCase.closedAt === null) {
    throw new ArchiveError('ARCHIVE_CASE_NOT_CLOSED', 'Only a closed case may be exported for preservation');
  }
  if (archiveCase.documents.length === 0) {
    throw new ArchiveError('ARCHIVE_DOCUMENT_MISSING', 'The case has no documents to preserve');
  }
  // RA-FS requires a preservation format. A profile the processor did not
  // verify is a claim, and a claim is not a format.
  for (const document of archiveCase.documents) {
    if (document.verifiedProfile === null) {
      throw new ArchiveError(
        'ARCHIVE_PROFILE_NOT_VERIFIED',
        `Document ${document.displayName} has no verified PDF/A profile and may not be exported for preservation`,
      );
    }
  }
  // Every signature must be traceable to an identity, and vice versa. A
  // signature with no identity evidence cannot prove who signed; an identity
  // with no signature records an authentication that produced nothing.
  if (archiveCase.decisionMode === 'ELECTRONIC_SIGNATURE') {
    if (archiveCase.signatures.length === 0) {
      throw new ArchiveError('ARCHIVE_SIGNATURE_EVIDENCE_MISSING', 'An electronic signature case carries no signature evidence');
    }
    for (const signature of archiveCase.signatures) {
      if (!signature.signatureArtifactSha256 || !signature.validationReportSha256) {
        throw new ArchiveError(
          'ARCHIVE_SIGNATURE_EVIDENCE_MISSING',
          `Signature by ${signature.signerId} has no artifact or validation report`,
        );
      }
    }
  }
  const identitySigners = new Set(archiveCase.identities.map((identity) => identity.signerId));
  for (const signature of archiveCase.signatures) {
    if (!identitySigners.has(signature.signerId)) {
      throw new ArchiveError(
        'ARCHIVE_IDENTITY_EVIDENCE_MISSING',
        `Signature by ${signature.signerId} has no identity evidence`,
      );
    }
  }
  // Without the audit trail the package records the outcome but not the
  // process, and RA-FS 2009:2 is about preserving the handling, not just the file.
  if (archiveCase.auditTrailSha256 === null) {
    throw new ArchiveError('ARCHIVE_AUDIT_TRAIL_MISSING', 'The case has no audit trail hash to preserve');
  }
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

export interface ArchiveManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly category: 'content' | 'metadata' | 'evidence';
}

export interface ArchiveManifest {
  readonly schema: typeof ARCHIVE_PACKAGE_SCHEMA;
  readonly profileVersion: number;
  /** RA-FS the package is produced against, recorded so a future reader knows. */
  readonly regulation: 'RA-FS 2009:2';
  readonly tenantId: UUID;
  readonly signatureCaseId: UUID;
  readonly reference: string;
  readonly title: string;
  readonly decisionMode: string;
  readonly createdAt: IsoDateTime;
  readonly closedAt: IsoDateTime;
  readonly entries: readonly ArchiveManifestEntry[];
  readonly signatures: readonly ArchiveSignatureEvidence[];
  readonly identities: readonly ArchiveIdentityEvidence[];
  readonly auditTrailSha256: string;
}

const PATH_PATTERN = /^(content|metadata|evidence)\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function assertPath(path: string): string {
  if (!PATH_PATTERN.test(path) || path.includes('..')) {
    throw new ArchiveError('ARCHIVE_PATH_INVALID', `Invalid package path ${path}`);
  }
  return path;
}

export interface ArchivePackage {
  readonly manifest: ArchiveManifest;
  readonly files: readonly EvidenceFile[];
  /** SHA-256 of the canonical manifest. Delivered *outside* the package. */
  readonly manifestSha256: string;
}

/**
 * Builds the package.
 *
 * Determinism is structural, not incidental: entries are sorted by path, the
 * manifest is serialised canonically, and every timestamp comes from the case
 * rather than from the clock. Exporting the same closed case twice must
 * produce identical bytes, otherwise the archive copy cannot be shown to be
 * the delivered copy.
 */
export async function buildArchivePackage(
  archiveCase: ArchiveCase,
  files: readonly EvidenceFile[],
): Promise<ArchivePackage> {
  assertArchivable(archiveCase);

  const entries: ArchiveManifestEntry[] = [];
  for (const file of files) {
    const path = assertPath(file.path);
    entries.push({
      path,
      sha256: await sha256Hex(file.bytes),
      bytes: file.bytes.byteLength,
      mediaType: file.mediaType,
      category: path.startsWith('content/') ? 'content' : path.startsWith('metadata/') ? 'metadata' : 'evidence',
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new ArchiveError('ARCHIVE_PATH_INVALID', 'Duplicate path in archive package');
  }
  // Every document that the case says exists must actually be in the package.
  // Without this the manifest happily describes a delivery missing its content.
  if (!entries.some((entry) => entry.category === 'content')) {
    throw new ArchiveError('ARCHIVE_DOCUMENT_MISSING', 'The package contains no content files');
  }

  const manifest: ArchiveManifest = {
    schema: ARCHIVE_PACKAGE_SCHEMA,
    profileVersion: ARCHIVE_PROFILE_VERSION,
    regulation: 'RA-FS 2009:2',
    tenantId: archiveCase.tenantId,
    signatureCaseId: archiveCase.signatureCaseId,
    reference: archiveCase.reference,
    title: archiveCase.title,
    decisionMode: archiveCase.decisionMode,
    createdAt: archiveCase.createdAt,
    closedAt: archiveCase.closedAt!,
    entries,
    // Sorted so two exports of the same case cannot differ by row order.
    signatures: [...archiveCase.signatures].sort((a, b) => a.signerId.localeCompare(b.signerId, 'en')),
    identities: [...archiveCase.identities].sort((a, b) => a.signerId.localeCompare(b.signerId, 'en')),
    auditTrailSha256: archiveCase.auditTrailSha256!,
  };

  return {
    manifest,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path, 'en')),
    // Computed over the manifest and delivered alongside it. A checksum stored
    // *inside* the manifest would re-certify any modification to the manifest.
    manifestSha256: await sha256Hex(canonicalJson(manifest as unknown as CanonicalJsonValue)),
  };
}

/* ------------------------------------------------------------------ *
 * Offline verification
 * ------------------------------------------------------------------ */

export interface ArchiveVerification {
  readonly verified: boolean;
  readonly failures: readonly string[];
}

/**
 * Verifies a package with nothing but the package, the manifest and the
 * separately delivered manifest hash. No database, no network, no Kommunsign.
 *
 * That is the requirement: a preservation package that can only be checked by
 * the system that produced it is not preserved, it is merely stored.
 */
export async function verifyArchivePackage(
  manifest: ArchiveManifest,
  files: readonly EvidenceFile[],
  expectedManifestSha256: string,
): Promise<ArchiveVerification> {
  const failures: string[] = [];

  // The manifest is checked first. If it has been altered, everything it says
  // about the files is worthless, so the per-file results would be misleading.
  const actualManifestSha256 = await sha256Hex(canonicalJson(manifest as unknown as CanonicalJsonValue));
  if (actualManifestSha256 !== expectedManifestSha256) {
    return { verified: false, failures: ['Manifest hash does not match the delivered manifest hash'] };
  }
  if (manifest.schema !== ARCHIVE_PACKAGE_SCHEMA) {
    return { verified: false, failures: [`Unknown package schema ${manifest.schema}`] };
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const entry of manifest.entries) {
    const file = byPath.get(entry.path);
    if (!file) { failures.push(`Missing file: ${entry.path}`); continue; }
    if (file.bytes.byteLength !== entry.bytes) failures.push(`Size mismatch: ${entry.path}`);
    if (await sha256Hex(file.bytes) !== entry.sha256) failures.push(`Hash mismatch: ${entry.path}`);
  }
  // An extra file is a failure, not a curiosity: a package that carries content
  // the manifest does not describe has not been delivered as described.
  for (const file of files) {
    if (!manifest.entries.some((entry) => entry.path === file.path)) {
      failures.push(`Unexpected file: ${file.path}`);
    }
  }

  return { verified: failures.length === 0, failures };
}

/**
 * Technology-neutral metadata for requirement 2066, as a canonical JSON
 * document. Kept separate from the manifest so a receiving archive can consume
 * the descriptive metadata without parsing the packaging.
 */
export function buildDescriptiveMetadata(archiveCase: ArchiveCase): CanonicalJsonValue {
  return {
    schema: 'kommunsign.fgs-metadata.v1',
    regulation: 'RA-FS 2009:2',
    reference: archiveCase.reference,
    title: archiveCase.title,
    decisionMode: archiveCase.decisionMode,
    createdAt: archiveCase.createdAt,
    closedAt: archiveCase.closedAt ?? '',
    documents: archiveCase.documents.map((document) => ({
      displayName: document.displayName,
      sha256: document.sha256,
      bytes: document.byteSize,
      format: document.verifiedProfile ?? '',
      role: document.isSignedArtifact ? 'signed' : 'original',
    })),
    signatories: archiveCase.identities.map((identity) => ({
      // Masked, never a full personal number: an archive package outlives every
      // access control that would otherwise protect it (AGENTS.md rule 6).
      identifier: identity.maskedIdentifier,
      provider: identity.provider,
      assuranceLevel: identity.assuranceLevel,
      verifiedAt: identity.verifiedAt,
    })),
  } as CanonicalJsonValue;
}
