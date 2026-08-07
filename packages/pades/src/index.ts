/**
 * PAdES admission gate.
 *
 * AGENTS.md rule 5: a PAdES signature may only be registered after
 * cryptographic signing and DSS or equivalent validation. This module is the
 * decision that enforces it, and it exists to make one specific failure
 * impossible: claiming a PAdES level the collected evidence does not support.
 *
 * It deliberately does not sign or validate anything. Signing belongs in the
 * sign service with real key material, validation in the validation service.
 * Keeping admission separate means the rule "never claim PAdES-LTA unless the
 * archive timestamp is actually present" is a pure function with tests, rather
 * than an assumption buried in an integration.
 */

import type { IsoDateTime } from '../../contracts/src/index.js';

/** ETSI EN 319 142 baseline levels, ordered by the evidence each requires. */
export const PADES_LEVELS = ['B', 'T', 'LT', 'LTA'] as const;
export type PadesLevel = (typeof PADES_LEVELS)[number];

/** As stored on the signature policy. NONE means no PAdES is produced. */
export type RequiredPadesLevel = 'NONE' | PadesLevel;

export type ValidationResult = 'TOTAL_PASSED' | 'INDETERMINATE' | 'TOTAL_FAILED';

/**
 * What the sign and validation services actually produced. Every field is
 * evidence that must be present in the database before admission, not a claim
 * made by a caller.
 */
export interface SignatureEvidence {
  /** Reference to the signing certificate recorded in app.signature_certificates. */
  readonly signingCertificateReference: string | null;
  /** Reference to the certificate chain in app.certificate_chains. */
  readonly certificateChainReference: string | null;
  /** SHA-256 of the signed PDF revision. */
  readonly signedRevisionSha256: string | null;
  /** RFC 3161 signature timestamp from app.timestamp_tokens. */
  readonly signatureTimestampReference: string | null;
  /** Archive timestamp, required for LTA and distinct from the signature timestamp. */
  readonly archiveTimestampReference: string | null;
  /** OCSP or CRL evidence proving revocation status at signing time. */
  readonly revocationEvidenceReferences: readonly string[];
  /** Trust list snapshot the chain was validated against. */
  readonly trustListSnapshotReference: string | null;
  /** Result reported by the DSS or equivalent validator. */
  readonly validationResult: ValidationResult | null;
  readonly validatedAt: IsoDateTime | null;
}

export interface PadesAdmissionPolicy {
  readonly requiredPadesLevel: RequiredPadesLevel;
  readonly requiresTimestamp: boolean;
  readonly allowedValidationResults: readonly ('TOTAL_PASSED' | 'INDETERMINATE')[];
}

export type PadesRejectionCode =
  | 'PADES_SIGNATURE_MISSING'
  | 'PADES_CERTIFICATE_MISSING'
  | 'PADES_CHAIN_MISSING'
  | 'PADES_NOT_VALIDATED'
  | 'PADES_VALIDATION_FAILED'
  | 'PADES_VALIDATION_RESULT_NOT_ALLOWED'
  | 'PADES_TIMESTAMP_MISSING'
  | 'PADES_REVOCATION_EVIDENCE_MISSING'
  | 'PADES_TRUST_LIST_MISSING'
  | 'PADES_ARCHIVE_TIMESTAMP_MISSING'
  | 'PADES_LEVEL_NOT_REACHED'
  | 'PADES_NOT_REQUIRED_BY_POLICY';

export class PadesAdmissionError extends Error {
  constructor(readonly code: PadesRejectionCode, message: string) {
    super(message);
    this.name = 'PadesAdmissionError';
  }
}

/**
 * The highest level the evidence actually supports, independent of what was
 * requested. Returns null when the evidence does not even reach B.
 *
 * Each level is strictly cumulative, so the checks are ordered and the first
 * unmet requirement caps the level.
 */
export function attainedPadesLevel(evidence: SignatureEvidence): PadesLevel | null {
  // B: a cryptographic signature over the revision, made with a certificate
  // whose chain is known.
  if (!evidence.signedRevisionSha256 || !evidence.signingCertificateReference || !evidence.certificateChainReference) {
    return null;
  }
  // T: a trusted timestamp proves the signature existed at a point in time.
  if (!evidence.signatureTimestampReference) return 'B';
  // LT: validation material is embedded so the signature stays verifiable
  // after the signing certificate expires.
  if (evidence.revocationEvidenceReferences.length === 0 || !evidence.trustListSnapshotReference) return 'T';
  // LTA: an archive timestamp protects the validation material itself.
  if (!evidence.archiveTimestampReference) return 'LT';
  return 'LTA';
}

function levelAtLeast(actual: PadesLevel, required: PadesLevel): boolean {
  return PADES_LEVELS.indexOf(actual) >= PADES_LEVELS.indexOf(required);
}

/** Why the attained level stopped where it did. Drives the rejection code. */
function missingEvidenceCode(evidence: SignatureEvidence, required: PadesLevel): PadesRejectionCode {
  if (!evidence.signedRevisionSha256) return 'PADES_SIGNATURE_MISSING';
  if (!evidence.signingCertificateReference) return 'PADES_CERTIFICATE_MISSING';
  if (!evidence.certificateChainReference) return 'PADES_CHAIN_MISSING';
  if (!evidence.signatureTimestampReference) return 'PADES_TIMESTAMP_MISSING';
  if (required === 'LT' || required === 'LTA') {
    if (evidence.revocationEvidenceReferences.length === 0) return 'PADES_REVOCATION_EVIDENCE_MISSING';
    if (!evidence.trustListSnapshotReference) return 'PADES_TRUST_LIST_MISSING';
  }
  if (required === 'LTA' && !evidence.archiveTimestampReference) return 'PADES_ARCHIVE_TIMESTAMP_MISSING';
  return 'PADES_LEVEL_NOT_REACHED';
}

export interface PadesAdmission {
  /** The level that may be recorded. Never higher than what evidence supports. */
  readonly admittedLevel: PadesLevel;
  readonly validationResult: 'TOTAL_PASSED' | 'INDETERMINATE';
  readonly validatedAt: IsoDateTime;
}

/**
 * Decides whether a signature artifact may be registered, and at which level.
 *
 * Throws rather than downgrading. A silent downgrade would let a case complete
 * while its evidence claims less than the policy demanded, which is exactly the
 * kind of quiet mismatch that makes a signature indefensible later.
 */
export function admitPadesSignature(
  policy: PadesAdmissionPolicy,
  evidence: SignatureEvidence,
): PadesAdmission {
  if (policy.requiredPadesLevel === 'NONE') {
    throw new PadesAdmissionError(
      'PADES_NOT_REQUIRED_BY_POLICY',
      'Policy does not produce a PAdES signature, so none may be registered',
    );
  }

  // Validation is checked before level, because an unvalidated signature must
  // never be registered at any level (AGENTS.md rule 5).
  if (evidence.validationResult === null || evidence.validatedAt === null) {
    throw new PadesAdmissionError('PADES_NOT_VALIDATED', 'Signature has not been validated by the validation service');
  }
  if (evidence.validationResult === 'TOTAL_FAILED') {
    throw new PadesAdmissionError('PADES_VALIDATION_FAILED', 'Validation reported TOTAL_FAILED');
  }
  if (!policy.allowedValidationResults.includes(evidence.validationResult)) {
    throw new PadesAdmissionError(
      'PADES_VALIDATION_RESULT_NOT_ALLOWED',
      `Policy does not accept validation result ${evidence.validationResult}`,
    );
  }

  const attained = attainedPadesLevel(evidence);
  if (attained === null) {
    throw new PadesAdmissionError(missingEvidenceCode(evidence, policy.requiredPadesLevel), 'Evidence does not reach PAdES-B');
  }
  // A policy may require a timestamp even at level B.
  if (policy.requiresTimestamp && !evidence.signatureTimestampReference) {
    throw new PadesAdmissionError('PADES_TIMESTAMP_MISSING', 'Policy requires a trusted timestamp');
  }
  if (!levelAtLeast(attained, policy.requiredPadesLevel)) {
    throw new PadesAdmissionError(
      missingEvidenceCode(evidence, policy.requiredPadesLevel),
      `Evidence reaches PAdES-${attained} but policy requires PAdES-${policy.requiredPadesLevel}`,
    );
  }

  return {
    // Record what the evidence supports, not what was requested. Recording the
    // requested level would overstate the signature whenever evidence exceeds
    // or merely meets it by coincidence.
    admittedLevel: attained,
    validationResult: evidence.validationResult,
    validatedAt: evidence.validatedAt,
  };
}

/**
 * Describes a level in Swedish for user-facing evidence output. Kept here so
 * the wording cannot drift from the level the gate actually admitted.
 */
export function describePadesLevel(level: PadesLevel): string {
  switch (level) {
    case 'B': return 'PAdES-B — kryptografisk signatur med signeringscertifikat';
    case 'T': return 'PAdES-T — signatur med betrodd tidsstämpel';
    case 'LT': return 'PAdES-LT — signatur med valideringsmaterial för långtidsvalidering';
    case 'LTA': return 'PAdES-LTA — långtidsvalidering med arkivtidsstämpel';
  }
}
