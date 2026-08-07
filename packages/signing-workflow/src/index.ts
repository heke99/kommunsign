/**
 * Signing workflow: order, multiple documents, attachments and reminders.
 *
 * Kungälv F008-F012: signing by several people in sequence, by several people
 * in parallel, of several documents at once, with attachment support, and with
 * reminders to those who have not signed.
 *
 * These look like four separate features and are really one question asked
 * four ways: *at this moment, for this signer, what exactly is being signed and
 * are they allowed to sign it yet?* Answering it in one place is the point —
 * the alternative is an ordering check in the invitation path, a different one
 * in the signing path, and a third in the reminder job, which is how a signer
 * ends up receiving a reminder for a step they are not yet entitled to.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';

export type SigningOrderMode = 'parallel' | 'sequential';

export type WorkflowErrorCode =
  | 'WORKFLOW_STEP_NOT_REACHED'
  | 'WORKFLOW_SIGNER_NOT_IN_ORDER'
  | 'WORKFLOW_SIGNER_ALREADY_FINISHED'
  | 'WORKFLOW_CASE_NOT_ACTIVE'
  | 'WORKFLOW_STEP_NUMBERS_INVALID'
  | 'WORKFLOW_NO_SIGNABLE_DOCUMENT'
  | 'WORKFLOW_DOCUMENT_NOT_LOCKED'
  | 'WORKFLOW_ATTACHMENT_NOT_BOUND'
  | 'WORKFLOW_TENANT_MISMATCH';

export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/* ------------------------------------------------------------------ *
 * Order
 * ------------------------------------------------------------------ */

export interface SigningStep {
  readonly signerId: UUID;
  /** 1-based. In parallel mode every step carries the same number. */
  readonly stepNumber: number;
  readonly status: 'pending' | 'signed' | 'declined' | 'expired' | 'cancelled';
}

export interface SigningOrder {
  readonly tenantId: UUID;
  readonly signatureCaseId: UUID;
  readonly mode: SigningOrderMode;
  readonly steps: readonly SigningStep[];
}

const FINISHED: readonly SigningStep['status'][] = ['signed', 'declined', 'expired', 'cancelled'];

/**
 * Validates the order itself before it is used to decide anything.
 *
 * A sequential order with duplicate step numbers has no defined "next", and
 * whichever signer is read first would win — so it is rejected at construction
 * rather than resolved arbitrarily at signing time.
 */
export function assertOrderIsWellFormed(order: SigningOrder): void {
  if (order.steps.length === 0) {
    throw new WorkflowError('WORKFLOW_SIGNER_NOT_IN_ORDER', 'A signing order must contain at least one signer');
  }
  const signerIds = new Set(order.steps.map((step) => step.signerId));
  if (signerIds.size !== order.steps.length) {
    throw new WorkflowError('WORKFLOW_STEP_NUMBERS_INVALID', 'A signer may appear only once in a signing order');
  }
  for (const step of order.steps) {
    if (!Number.isInteger(step.stepNumber) || step.stepNumber < 1) {
      throw new WorkflowError('WORKFLOW_STEP_NUMBERS_INVALID', 'Step numbers are 1-based positive integers');
    }
  }
  if (order.mode === 'sequential') {
    const numbers = order.steps.map((step) => step.stepNumber);
    if (new Set(numbers).size !== numbers.length) {
      throw new WorkflowError('WORKFLOW_STEP_NUMBERS_INVALID', 'A sequential order must not repeat a step number');
    }
    // Gaps are refused too: a missing step 2 would let step 3 become reachable
    // the moment step 1 signs, silently skipping a required approver.
    const sorted = [...numbers].sort((left, right) => left - right);
    if (sorted.some((number, index) => number !== index + 1)) {
      throw new WorkflowError('WORKFLOW_STEP_NUMBERS_INVALID', 'A sequential order must number its steps 1..n without gaps');
    }
  }
}

/**
 * The step numbers that may sign right now.
 *
 * In parallel mode that is every unfinished step. In sequential mode it is the
 * lowest step number that has not finished — and only that one.
 */
export function currentStepNumber(order: SigningOrder): number | null {
  assertOrderIsWellFormed(order);
  const pending = order.steps.filter((step) => !FINISHED.includes(step.status));
  if (pending.length === 0) return null;
  return Math.min(...pending.map((step) => step.stepNumber));
}

/**
 * Whether this signer may sign now.
 *
 * This is the single authority. A signer holding a perfectly valid invitation
 * link for step 3 must still be refused until step 2 finishes: the link proves
 * who they are, not that it is their turn.
 */
export function assertSignerMaySign(
  order: SigningOrder,
  signerId: UUID,
  caseIsActive: boolean,
): void {
  assertOrderIsWellFormed(order);
  if (!caseIsActive) {
    throw new WorkflowError('WORKFLOW_CASE_NOT_ACTIVE', 'The case is not accepting signatures');
  }
  const step = order.steps.find((candidate) => candidate.signerId === signerId);
  if (step === undefined) {
    throw new WorkflowError('WORKFLOW_SIGNER_NOT_IN_ORDER', 'This signer is not part of the signing order');
  }
  if (FINISHED.includes(step.status)) {
    throw new WorkflowError('WORKFLOW_SIGNER_ALREADY_FINISHED', `This signer has already ${step.status}`);
  }
  if (order.mode === 'parallel') return;

  const current = currentStepNumber(order);
  if (current === null || step.stepNumber !== current) {
    throw new WorkflowError(
      'WORKFLOW_STEP_NOT_REACHED',
      `Step ${step.stepNumber} cannot sign yet; step ${current ?? '-'} is outstanding`,
    );
  }
}

/** Signers who may act now. Drives both invitations and reminders. */
export function signersAwaitingAction(order: SigningOrder): readonly UUID[] {
  const current = currentStepNumber(order);
  if (current === null) return [];
  return order.steps
    .filter((step) => !FINISHED.includes(step.status))
    .filter((step) => order.mode === 'parallel' || step.stepNumber === current)
    .map((step) => step.signerId)
    .sort();
}

export type CaseOutcome = 'IN_PROGRESS' | 'COMPLETED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';

/**
 * The outcome the order implies.
 *
 * A single decline ends the case rather than being skipped over. That is the
 * conservative reading: if one required approver refuses, the remaining
 * signatures do not add up to an approved decision, and continuing to collect
 * them would produce a case that looks nearly complete but can never complete.
 */
export function caseOutcome(order: SigningOrder): CaseOutcome {
  assertOrderIsWellFormed(order);
  if (order.steps.some((step) => step.status === 'cancelled')) return 'CANCELLED';
  if (order.steps.some((step) => step.status === 'declined')) return 'DECLINED';
  if (order.steps.some((step) => step.status === 'expired')) return 'EXPIRED';
  return order.steps.every((step) => step.status === 'signed') ? 'COMPLETED' : 'IN_PROGRESS';
}

/* ------------------------------------------------------------------ *
 * Documents and attachments
 * ------------------------------------------------------------------ */

/**
 * A document in a case. `role` is what separates F010 from F011: a signable
 * document receives the signature, an attachment is context the signer sees
 * and that must be provably unchanged, but which is not itself signed.
 */
export interface CaseDocument {
  readonly documentId: UUID;
  readonly documentVersionId: UUID;
  readonly displayName: string;
  readonly sha256: string;
  readonly role: 'signable' | 'attachment';
  readonly locked: boolean;
  readonly ordinal: number;
}

export interface SigningBundle {
  readonly signableDocuments: readonly CaseDocument[];
  readonly attachments: readonly CaseDocument[];
  /** Covers signable documents *and* attachments, in a fixed order. */
  readonly bundleSha256Material: readonly string[];
}

/**
 * Assembles what a signer is being asked to sign.
 *
 * Attachments are included in the binding material even though they are not
 * signed. That is the whole point of an attachment: the signer approved a
 * decision *in the light of* those appendices, so swapping one afterwards has
 * to be detectable. Excluding them would make attachments the obvious place to
 * put anything you wanted to change later.
 */
export function buildSigningBundle(documents: readonly CaseDocument[]): SigningBundle {
  const signable = documents.filter((document) => document.role === 'signable');
  const attachments = documents.filter((document) => document.role === 'attachment');
  if (signable.length === 0) {
    throw new WorkflowError('WORKFLOW_NO_SIGNABLE_DOCUMENT', 'A signing case needs at least one signable document');
  }
  // An unlocked document can change between display and signature, so its hash
  // proves nothing — for attachments exactly as much as for the main document.
  for (const document of documents) {
    if (!document.locked) {
      throw new WorkflowError('WORKFLOW_DOCUMENT_NOT_LOCKED', `Document ${document.displayName} is not locked`);
    }
  }
  const byOrdinal = (left: CaseDocument, right: CaseDocument) =>
    left.ordinal - right.ordinal || left.documentVersionId.localeCompare(right.documentVersionId, 'en');

  const orderedSignable = [...signable].sort(byOrdinal);
  const orderedAttachments = [...attachments].sort(byOrdinal);
  return {
    signableDocuments: orderedSignable,
    attachments: orderedAttachments,
    // Deterministic and role-tagged: without the tag, moving a document
    // between roles would leave the material unchanged.
    bundleSha256Material: [...orderedSignable, ...orderedAttachments].map(
      (document) => `${document.role}:${document.documentVersionId}:${document.sha256}`,
    ),
  };
}

/**
 * Verifies that the bundle presented at signing is the bundle recorded on the
 * intent. Catches an attachment added, removed or swapped between the moment
 * the signer looked and the moment they signed.
 */
export function assertBundleUnchanged(
  recorded: readonly string[],
  presented: readonly string[],
): void {
  if (recorded.length !== presented.length || recorded.some((entry, index) => entry !== presented[index])) {
    throw new WorkflowError('WORKFLOW_ATTACHMENT_NOT_BOUND', 'The document bundle changed after the signing intent was created');
  }
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

export interface ReminderSchedule {
  readonly tenantId: UUID;
  readonly signatureCaseId: UUID;
  readonly signerId: UUID;
  readonly nextReminderAt: IsoDateTime;
  readonly intervalHours: number;
  readonly remainingAttempts: number;
}

export interface ReminderDecision {
  readonly send: boolean;
  readonly reason:
    | 'DUE'
    | 'NOT_DUE'
    | 'NO_ATTEMPTS_LEFT'
    | 'SIGNER_NOT_AWAITING_ACTION'
    | 'CASE_CLOSED'
    | 'CASE_EXPIRED';
  readonly nextReminderAt: IsoDateTime | null;
}

/**
 * Decides whether to remind one signer.
 *
 * The check that matters is `SIGNER_NOT_AWAITING_ACTION`. In a sequential
 * order, a schedule created for every signer up front would otherwise nag
 * signer three about a document they cannot open yet — which teaches people to
 * ignore the reminders, and is the reason reminders and ordering have to share
 * one definition of "whose turn it is" rather than each having their own.
 */
export function decideReminder(
  schedule: ReminderSchedule,
  order: SigningOrder,
  caseExpiresAt: IsoDateTime,
  now: Date,
): ReminderDecision {
  if (schedule.tenantId !== order.tenantId || schedule.signatureCaseId !== order.signatureCaseId) {
    throw new WorkflowError('WORKFLOW_TENANT_MISMATCH', 'Reminder schedule does not belong to this case');
  }
  const outcome = caseOutcome(order);
  if (outcome !== 'IN_PROGRESS') {
    return { send: false, reason: 'CASE_CLOSED', nextReminderAt: null };
  }
  // Reminding someone to sign something that can no longer be signed is worse
  // than silence: it invites a wasted attempt and a confusing error.
  if (Date.parse(caseExpiresAt) <= now.getTime()) {
    return { send: false, reason: 'CASE_EXPIRED', nextReminderAt: null };
  }
  if (!signersAwaitingAction(order).includes(schedule.signerId)) {
    return { send: false, reason: 'SIGNER_NOT_AWAITING_ACTION', nextReminderAt: null };
  }
  if (schedule.remainingAttempts <= 0) {
    return { send: false, reason: 'NO_ATTEMPTS_LEFT', nextReminderAt: null };
  }
  if (Date.parse(schedule.nextReminderAt) > now.getTime()) {
    return { send: false, reason: 'NOT_DUE', nextReminderAt: schedule.nextReminderAt };
  }

  // The next slot is computed from now rather than from the previous due time.
  // Advancing from the stored value would let a paused worker fire several
  // reminders back to back once it resumes.
  const next = new Date(now.getTime() + schedule.intervalHours * 3_600_000).toISOString();
  return {
    send: true,
    reason: 'DUE',
    nextReminderAt: schedule.remainingAttempts > 1 ? next : null,
  };
}
