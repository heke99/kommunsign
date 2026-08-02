import type { DocumentStatus, SignatureCaseStatus, SignerStatus } from '../../contracts/src/index.js';

const caseTransitions: Readonly<Record<SignatureCaseStatus, readonly SignatureCaseStatus[]>> = {
  draft: ['preparing', 'cancelled'],
  preparing: ['ready', 'failed', 'cancelled'],
  ready: ['sent', 'cancelled'],
  sent: ['in_progress', 'declined', 'expired', 'cancelled', 'failed'],
  in_progress: ['partially_signed', 'completed', 'declined', 'expired', 'cancelled', 'failed'],
  partially_signed: ['completed', 'declined', 'expired', 'cancelled', 'failed'],
  completed: ['archiving'],
  declined: ['archiving'],
  expired: ['archiving'],
  cancelled: ['archiving'],
  failed: ['archiving'],
  archiving: ['archived', 'failed'],
  archived: [],
};

const signerTransitions: Readonly<Record<SignerStatus, readonly SignerStatus[]>> = {
  pending: ['invited', 'cancelled'],
  invited: ['opened', 'identity_started', 'expired', 'cancelled', 'failed'],
  opened: ['identity_started', 'declined', 'expired', 'cancelled', 'failed'],
  identity_started: ['identity_verified', 'declined', 'expired', 'cancelled', 'failed'],
  identity_verified: ['signing', 'declined', 'expired', 'cancelled', 'failed'],
  signing: ['signed', 'declined', 'expired', 'cancelled', 'failed'],
  signed: [], declined: [], expired: [], cancelled: [], failed: [],
};

const documentTransitions: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  uploaded: ['quarantined', 'rejected'],
  quarantined: ['scanning', 'rejected'],
  scanning: ['canonicalizing', 'rejected'],
  rejected: [],
  canonicalizing: ['ready', 'rejected'],
  ready: ['locked'],
  locked: ['partially_signed', 'signed'],
  partially_signed: ['signed'],
  signed: ['validated'],
  validated: ['archived'],
  archived: [],
};

export function canTransitionCase(from: SignatureCaseStatus, to: SignatureCaseStatus): boolean {
  return caseTransitions[from].includes(to);
}
export function canTransitionSigner(from: SignerStatus, to: SignerStatus): boolean {
  return signerTransitions[from].includes(to);
}
export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return documentTransitions[from].includes(to);
}

export function requireCaseTransition(from: SignatureCaseStatus, to: SignatureCaseStatus): void {
  if (!canTransitionCase(from, to)) throw new Error(`Invalid case transition: ${from} -> ${to}`);
}

export interface CaseCompletionEvidence {
  readonly decisionMode: 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
  readonly allRequiredParticipantsCompleted: boolean;
  readonly documentVersionLocked: boolean;
  readonly approvalEvidenceRecorded: boolean;
  readonly cryptographicSignatureCreated: boolean;
  readonly validationAccepted: boolean;
  readonly archiveCompleted: boolean;
}

export function requireServerEvidenceForCaseStatus(
  to: SignatureCaseStatus,
  evidence: CaseCompletionEvidence,
): void {
  if (to === 'completed' && !evidence.allRequiredParticipantsCompleted) {
    throw new Error('completed requires all required participants to complete their steps');
  }
  if (to === 'completed' && !evidence.documentVersionLocked) {
    throw new Error('completed requires the immutable document version to remain locked');
  }
  if (to === 'completed' && evidence.decisionMode === 'DIGITAL_APPROVAL' && !evidence.approvalEvidenceRecorded) {
    throw new Error('digital approval completion requires immutable approval evidence');
  }
  if (to === 'completed' && evidence.decisionMode === 'ELECTRONIC_SIGNATURE'
      && (!evidence.cryptographicSignatureCreated || !evidence.validationAccepted)) {
    throw new Error('electronic signature completion requires a cryptographic signature and accepted validation');
  }
  if (to === 'archived' && !evidence.archiveCompleted) throw new Error('archived requires completed archive evidence');
}
