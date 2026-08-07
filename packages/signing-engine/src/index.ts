/**
 * Signing engine boundary and pipeline.
 *
 * Kungälv F001 requires a signature that meets Digg's definition of an
 * *advanced electronic signature*. A workflow that identifies the signer with
 * BankID, hashes the document and writes an audit log does not meet that bar:
 * an advanced signature must be created with signature-creation data the
 * signer controls, and it must be bound to the signed data so that any later
 * change is detectable. That is a cryptographic operation, not a workflow
 * state.
 *
 * This module is the provider-neutral boundary around that operation, plus the
 * pipeline that orders it. It deliberately performs no cryptography. Signing
 * happens in the sign service with real key material, validation in the
 * validation service. What lives here is the part that is pure, testable and
 * historically the part that goes wrong: deciding whether the stages actually
 * happened, in the right order, over the right bytes.
 *
 * The specific failures this module exists to make impossible:
 *
 *   1. Completing a case whose signature covers a *different* document
 *      revision than the one that was locked and shown to the signer.
 *   2. Advancing past a stage that was never executed, so a case reaches
 *      "signed" with no cryptographic artifact behind it.
 *   3. Reporting a PAdES level, or a signature level, higher than the evidence
 *      the validator actually returned.
 *   4. Silently falling back to an unconfigured provider in production.
 *
 * Provider selection is by capability, never by name. The core must never
 * contain `if (provider === 'dss')`; swapping the signing backend is a
 * registry change.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';
import type { PadesLevel, RequiredPadesLevel, SignatureEvidence, ValidationResult } from '../../pades/src/index.js';

/* ------------------------------------------------------------------ *
 * Pipeline stages
 * ------------------------------------------------------------------ */

/**
 * Ordered. Each stage consumes the artifact of the previous one, so the array
 * order *is* the dependency graph — there is no separate ordering table that
 * could drift out of sync with this list.
 */
export const SIGNING_STAGES = [
  'DOCUMENT_LOCKED',
  'POLICY_RESOLVED',
  'IDENTITY_VERIFIED',
  'SIGNATURE_CREATED',
  'TIMESTAMPED',
  'VALIDATED',
  'ADMITTED',
] as const;
export type SigningStage = (typeof SIGNING_STAGES)[number];

export function stageIndex(stage: SigningStage): number {
  return SIGNING_STAGES.indexOf(stage);
}

export type SigningEngineErrorCode =
  | 'SIGNING_STAGE_OUT_OF_ORDER'
  | 'SIGNING_STAGE_ALREADY_COMPLETED'
  | 'SIGNING_DOCUMENT_NOT_LOCKED'
  | 'SIGNING_DOCUMENT_MISMATCH'
  | 'SIGNING_IDENTITY_NOT_BOUND'
  | 'SIGNING_IDENTITY_ASSURANCE_TOO_LOW'
  | 'SIGNING_ARTIFACT_MISSING'
  | 'SIGNING_ARTIFACT_NOT_BOUND'
  | 'SIGNING_TIMESTAMP_REQUIRED'
  | 'SIGNING_NOT_VALIDATED'
  | 'SIGNING_VALIDATION_FAILED'
  | 'SIGNING_PROVIDER_NOT_CONFIGURED'
  | 'SIGNING_PROVIDER_NOT_PRODUCTION_READY'
  | 'SIGNING_LEVEL_NOT_SUPPORTED'
  | 'SIGNING_POLICY_REQUIRES_SIGNATURE';

export class SigningEngineError extends Error {
  constructor(readonly code: SigningEngineErrorCode, message: string) {
    super(message);
    this.name = 'SigningEngineError';
  }
}

/* ------------------------------------------------------------------ *
 * Provider-neutral boundary
 * ------------------------------------------------------------------ */

/** Exactly what is being signed. All three fields are server-derived. */
export interface SignedDataReference {
  readonly tenantId: UUID;
  readonly signatureCaseId: UUID;
  readonly documentVersionId: UUID;
  /** SHA-256 of the locked revision. The binding anchor for the whole flow. */
  readonly documentSha256: string;
}

export interface SignCommand {
  readonly signedData: SignedDataReference;
  readonly signingIntentId: UUID;
  /** Reference to the verified identity evidence, never the evidence itself. */
  readonly verifiedIdentityEvidenceReference: string;
  readonly signaturePolicyId: UUID;
  readonly signaturePolicyVersion: number;
  readonly requestedPadesLevel: PadesLevel;
  readonly requestedAt: IsoDateTime;
}

/**
 * What a signing backend returns. `coveredDocumentSha256` is what the backend
 * says it actually signed; the pipeline compares it against the locked hash
 * rather than trusting that they match.
 */
export interface SignArtifact {
  readonly artifactReference: string;
  readonly coveredDocumentSha256: string;
  readonly signedRevisionSha256: string;
  readonly signingCertificateReference: string;
  readonly certificateChainReference: string;
  readonly producedAt: IsoDateTime;
}

export interface TimestampToken {
  readonly tokenReference: string;
  /** RFC 3161 tokens cover a digest; we check it covers *our* revision. */
  readonly coveredSha256: string;
  readonly generatedAt: IsoDateTime;
  readonly authorityName: string;
}

export interface ValidationReport {
  readonly result: ValidationResult;
  readonly attainedLevel: PadesLevel | null;
  readonly revocationEvidenceReferences: readonly string[];
  readonly trustListSnapshotReference: string | null;
  readonly archiveTimestampReference: string | null;
  readonly reportReference: string;
  readonly validatedAt: IsoDateTime;
}

/** Declared capability of a backend. Selection is by these, never by name. */
export interface SigningBackendCapabilities {
  readonly backendKey: string;
  readonly supportedLevels: readonly PadesLevel[];
  readonly producesPdfA: boolean;
  readonly productionReady: boolean;
  /** Set when key material lives in an HSM or equivalent, as QES requires. */
  readonly keyProtection: 'SOFTWARE' | 'HSM' | 'REMOTE_QSCD';
}

export interface SigningEngine {
  readonly capabilities: SigningBackendCapabilities;
  sign(command: SignCommand): Promise<SignArtifact>;
}

export interface TimestampProvider {
  readonly authorityName: string;
  readonly productionReady: boolean;
  timestamp(sha256: string): Promise<TimestampToken>;
}

export interface SignatureValidator {
  readonly validatorKey: string;
  readonly productionReady: boolean;
  validate(artifact: SignArtifact): Promise<ValidationReport>;
}

export interface CertificateProvider {
  readonly providerKey: string;
  readonly productionReady: boolean;
  /** Trust list snapshot the chain must be validated against. */
  currentTrustListSnapshot(): Promise<string>;
}

/* ------------------------------------------------------------------ *
 * Fail-closed defaults
 * ------------------------------------------------------------------ *
 *
 * These are the defaults, not the fallbacks. A deployment that has not been
 * given a real backend must refuse to sign, because the alternative — a
 * permissive stub that returns a plausible-looking artifact — produces cases
 * that look signed and are not. AGENTS.md rule 10.
 */

export class NotConfiguredSigningEngine implements SigningEngine {
  readonly capabilities: SigningBackendCapabilities = {
    backendKey: 'not-configured',
    supportedLevels: [],
    producesPdfA: false,
    productionReady: false,
    keyProtection: 'SOFTWARE',
  };

  async sign(): Promise<SignArtifact> {
    throw new SigningEngineError(
      'SIGNING_PROVIDER_NOT_CONFIGURED',
      'No signing backend is configured. Cryptographic signing requires CA-issued key material, an HSM or remote QSCD, and a TSA.',
    );
  }
}

export class NotConfiguredTimestampProvider implements TimestampProvider {
  readonly authorityName = 'not-configured';
  readonly productionReady = false;
  async timestamp(): Promise<TimestampToken> {
    throw new SigningEngineError('SIGNING_PROVIDER_NOT_CONFIGURED', 'No timestamp authority is configured');
  }
}

export class NotConfiguredSignatureValidator implements SignatureValidator {
  readonly validatorKey = 'not-configured';
  readonly productionReady = false;
  async validate(): Promise<ValidationReport> {
    throw new SigningEngineError('SIGNING_PROVIDER_NOT_CONFIGURED', 'No signature validator is configured');
  }
}

/* ------------------------------------------------------------------ *
 * Backend admission
 * ------------------------------------------------------------------ */

export interface SigningRuntime {
  readonly environment: 'development' | 'test' | 'production';
  readonly engine: SigningEngine;
  readonly timestamps: TimestampProvider;
  readonly validator: SignatureValidator;
}

/**
 * Checked before a case may start signing, not after it has failed. Running
 * this early turns "the signature silently never appears" into a refusal at
 * the point where a human is still watching.
 */
export function assertSigningRuntimeUsable(runtime: SigningRuntime, requiredLevel: RequiredPadesLevel): void {
  if (requiredLevel === 'NONE') {
    throw new SigningEngineError(
      'SIGNING_POLICY_REQUIRES_SIGNATURE',
      'Policy produces no PAdES signature; the signing pipeline must not be started for it',
    );
  }
  if (!runtime.engine.capabilities.supportedLevels.includes(requiredLevel)) {
    throw new SigningEngineError(
      'SIGNING_LEVEL_NOT_SUPPORTED',
      `Signing backend ${runtime.engine.capabilities.backendKey} does not support PAdES-${requiredLevel}`,
    );
  }
  if (runtime.environment !== 'production') return;

  // In production every participant must be production ready. A validator that
  // is still a stub would let an unvalidated signature through the gate.
  for (const [what, ready] of [
    ['signing backend', runtime.engine.capabilities.productionReady],
    ['timestamp authority', runtime.timestamps.productionReady],
    ['signature validator', runtime.validator.productionReady],
  ] as const) {
    if (!ready) {
      throw new SigningEngineError(
        'SIGNING_PROVIDER_NOT_PRODUCTION_READY',
        `The configured ${what} is not production ready and may not be used in production`,
      );
    }
  }
  // PAdES-LTA underpins long-term archival; software-held keys undermine the
  // non-repudiation the archive is supposed to preserve.
  if (requiredLevel === 'LTA' && runtime.engine.capabilities.keyProtection === 'SOFTWARE') {
    throw new SigningEngineError(
      'SIGNING_PROVIDER_NOT_PRODUCTION_READY',
      'PAdES-LTA requires key material held in an HSM or remote QSCD',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Pipeline state
 * ------------------------------------------------------------------ */

export interface SigningPipelineState {
  readonly signedData: SignedDataReference;
  readonly signingIntentId: UUID;
  readonly requiredLevel: PadesLevel;
  readonly requiresTimestamp: boolean;
  readonly completedStages: readonly SigningStage[];
  readonly artifact: SignArtifact | null;
  readonly signatureTimestamp: TimestampToken | null;
  readonly report: ValidationReport | null;
}

export function beginSigningPipeline(input: {
  readonly signedData: SignedDataReference;
  readonly signingIntentId: UUID;
  readonly requiredLevel: PadesLevel;
  readonly requiresTimestamp: boolean;
  readonly documentLocked: boolean;
}): SigningPipelineState {
  // The lock is what makes the hash meaningful. Signing an unlocked document
  // means the bytes can change between display and signature.
  if (!input.documentLocked) {
    throw new SigningEngineError('SIGNING_DOCUMENT_NOT_LOCKED', 'The document version must be locked before signing begins');
  }
  if (!/^[0-9a-f]{64}$/.test(input.signedData.documentSha256)) {
    throw new SigningEngineError('SIGNING_DOCUMENT_MISMATCH', 'documentSha256 must be a lowercase hex SHA-256');
  }
  return {
    signedData: input.signedData,
    signingIntentId: input.signingIntentId,
    requiredLevel: input.requiredLevel,
    requiresTimestamp: input.requiresTimestamp,
    completedStages: ['DOCUMENT_LOCKED'],
    artifact: null,
    signatureTimestamp: null,
    report: null,
  };
}

function assertStageReachable(state: SigningPipelineState, stage: SigningStage): void {
  if (state.completedStages.includes(stage)) {
    throw new SigningEngineError('SIGNING_STAGE_ALREADY_COMPLETED', `Stage ${stage} has already been completed`);
  }
  const previous = SIGNING_STAGES[stageIndex(stage) - 1];
  if (previous !== undefined && !state.completedStages.includes(previous)) {
    throw new SigningEngineError(
      'SIGNING_STAGE_OUT_OF_ORDER',
      `Stage ${stage} requires ${previous} to be completed first`,
    );
  }
}

function withStage(state: SigningPipelineState, stage: SigningStage, patch: Partial<SigningPipelineState> = {}): SigningPipelineState {
  return { ...state, ...patch, completedStages: [...state.completedStages, stage] };
}

export function recordPolicyResolved(state: SigningPipelineState): SigningPipelineState {
  assertStageReachable(state, 'POLICY_RESOLVED');
  return withStage(state, 'POLICY_RESOLVED');
}

/**
 * The identity evidence must belong to *this* intent. Accepting evidence from
 * another intent is how a valid BankID session for document A ends up
 * completing a signature over document B.
 */
export function recordIdentityVerified(
  state: SigningPipelineState,
  evidence: {
    readonly signingIntentId: UUID;
    readonly signatureCaseId: UUID;
    readonly tenantId: UUID;
    readonly assuranceLevel: string;
  },
  minimumAssuranceLevels: readonly string[],
): SigningPipelineState {
  assertStageReachable(state, 'IDENTITY_VERIFIED');
  if (
    evidence.signingIntentId !== state.signingIntentId ||
    evidence.signatureCaseId !== state.signedData.signatureCaseId ||
    evidence.tenantId !== state.signedData.tenantId
  ) {
    throw new SigningEngineError('SIGNING_IDENTITY_NOT_BOUND', 'Identity evidence does not bind to this signing intent');
  }
  if (!minimumAssuranceLevels.includes(evidence.assuranceLevel)) {
    throw new SigningEngineError(
      'SIGNING_IDENTITY_ASSURANCE_TOO_LOW',
      `Assurance level ${evidence.assuranceLevel} is below what the policy accepts`,
    );
  }
  return withStage(state, 'IDENTITY_VERIFIED');
}

/**
 * The artifact must cover the hash that was locked. This is the check that
 * turns "the backend signed something" into "the backend signed *this*".
 */
export function recordSignatureCreated(state: SigningPipelineState, artifact: SignArtifact): SigningPipelineState {
  assertStageReachable(state, 'SIGNATURE_CREATED');
  if (artifact.coveredDocumentSha256 !== state.signedData.documentSha256) {
    throw new SigningEngineError(
      'SIGNING_ARTIFACT_NOT_BOUND',
      'The signature covers a different document revision than the one that was locked',
    );
  }
  if (!artifact.signingCertificateReference || !artifact.certificateChainReference) {
    throw new SigningEngineError('SIGNING_ARTIFACT_MISSING', 'Signature artifact is missing certificate or chain reference');
  }
  return withStage(state, 'SIGNATURE_CREATED', { artifact });
}

/**
 * Timestamping is a distinct stage rather than part of signing, because
 * PAdES-T upwards depends on a token from an authority the signer does not
 * control. When the policy does not require one the stage is recorded as
 * skipped, so the ordering invariant still holds.
 */
export function recordTimestamped(state: SigningPipelineState, token: TimestampToken | null): SigningPipelineState {
  assertStageReachable(state, 'TIMESTAMPED');
  const needsTimestamp = state.requiresTimestamp || state.requiredLevel !== 'B';
  if (token === null) {
    if (needsTimestamp) {
      throw new SigningEngineError('SIGNING_TIMESTAMP_REQUIRED', `PAdES-${state.requiredLevel} requires a trusted timestamp`);
    }
    return withStage(state, 'TIMESTAMPED');
  }
  if (state.artifact === null) {
    throw new SigningEngineError('SIGNING_ARTIFACT_MISSING', 'Cannot timestamp before a signature exists');
  }
  // A token over some other digest proves nothing about our revision.
  if (token.coveredSha256 !== state.artifact.signedRevisionSha256) {
    throw new SigningEngineError('SIGNING_ARTIFACT_NOT_BOUND', 'Timestamp does not cover the signed revision');
  }
  return withStage(state, 'TIMESTAMPED', { signatureTimestamp: token });
}

export function recordValidated(state: SigningPipelineState, report: ValidationReport): SigningPipelineState {
  assertStageReachable(state, 'VALIDATED');
  if (report.result === 'TOTAL_FAILED') {
    throw new SigningEngineError('SIGNING_VALIDATION_FAILED', 'Validation reported TOTAL_FAILED');
  }
  return withStage(state, 'VALIDATED', { report });
}

/**
 * Assembles the evidence the PAdES admission gate consumes.
 *
 * Every field is taken from what a provider actually returned. Nothing is
 * defaulted to a truthy value, because a default here would manufacture the
 * very evidence the gate is meant to check for.
 */
export function collectSignatureEvidence(state: SigningPipelineState): SignatureEvidence {
  if (state.artifact === null) {
    throw new SigningEngineError('SIGNING_ARTIFACT_MISSING', 'No signature artifact was produced');
  }
  if (state.report === null) {
    throw new SigningEngineError('SIGNING_NOT_VALIDATED', 'The signature has not been validated');
  }
  return {
    signingCertificateReference: state.artifact.signingCertificateReference,
    certificateChainReference: state.artifact.certificateChainReference,
    signedRevisionSha256: state.artifact.signedRevisionSha256,
    signatureTimestampReference: state.signatureTimestamp?.tokenReference ?? null,
    archiveTimestampReference: state.report.archiveTimestampReference,
    revocationEvidenceReferences: state.report.revocationEvidenceReferences,
    trustListSnapshotReference: state.report.trustListSnapshotReference,
    validationResult: state.report.result,
    validatedAt: state.report.validatedAt,
  };
}

/**
 * True only when every stage ran. The case status machine consumes this;
 * deriving it from the stage list rather than a boolean flag means a case
 * cannot be marked signed by setting a column.
 */
export function pipelineIsComplete(state: SigningPipelineState): boolean {
  return SIGNING_STAGES.every((stage) => state.completedStages.includes(stage));
}

export function recordAdmitted(state: SigningPipelineState): SigningPipelineState {
  assertStageReachable(state, 'ADMITTED');
  return withStage(state, 'ADMITTED');
}

/** Human-readable stage list for evidence packages, in Swedish. */
export function describeStage(stage: SigningStage): string {
  switch (stage) {
    case 'DOCUMENT_LOCKED': return 'Dokumentversionen låstes och hashades';
    case 'POLICY_RESOLVED': return 'Signaturpolicy fastställdes och versionslåstes';
    case 'IDENTITY_VERIFIED': return 'Undertecknarens identitet verifierades';
    case 'SIGNATURE_CREATED': return 'Kryptografisk signatur skapades';
    case 'TIMESTAMPED': return 'Signaturen tidsstämplades av betrodd tidsstämplingstjänst';
    case 'VALIDATED': return 'Signaturen validerades mot tillitslista och spärrinformation';
    case 'ADMITTED': return 'Signaturen antogs och PAdES-nivå registrerades';
  }
}
