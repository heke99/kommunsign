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

export function requireServerEvidenceForCaseStatus(
  to: SignatureCaseStatus,
  evidence: { readonly allRequiredSignersSigned: boolean; readonly validationAccepted: boolean; readonly archiveCompleted: boolean },
): void {
  if (to === 'completed' && (!evidence.allRequiredSignersSigned || !evidence.validationAccepted)) {
    throw new Error('completed requires all signatures and accepted validation');
  }
  if (to === 'archived' && !evidence.archiveCompleted) throw new Error('archived requires completed archive evidence');
}
