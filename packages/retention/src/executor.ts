/**
 * Gallring executor.
 *
 * The decision layer in `./index.ts` answers *what* may be gallrat and *when*.
 * This is the lifecycle that carries a decision through to a verified,
 * reported deletion: queue → plan → approve → execute → verify → report.
 *
 * Kungälv requirements 2068-2072 and 2025. The parts that need a lifecycle
 * rather than a pure decision are the ones where time passes between deciding
 * and acting, and where something can change in between.
 *
 * Three defects this exists to prevent:
 *
 *   1. Executing a stale decision. A case is queued as due, and before the job
 *      runs a legal hold is placed on it. Executing the queued decision would
 *      destroy material someone has just formally demanded be kept. The
 *      decision is therefore re-evaluated at execution time, not trusted from
 *      the queue.
 *
 *   2. Reporting a partial gallring as complete. `buildGallringReport` can only
 *      check the outcomes it is given: a run that silently addressed three of
 *      nine targets reports every target it touched as verified and looks
 *      complete. The plan is therefore declared up front and the report is
 *      checked against the plan, so an unaddressed target is a missing target
 *      rather than an absent one.
 *
 *   3. Gallring without an accountable human. Requirement 2069 says the
 *      customer must be able to gallra without the supplier, which also means
 *      the supplier must not be able to gallra without the customer. Every
 *      execution carries the operator who authorised it.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';
import {
  GALLRING_TARGETS, RetentionPolicyError, buildGallringReport, decideRetention,
  type GallringReport, type GallringTarget, type GallringTargetOutcome,
  type RetentionDecision, type RetentionPolicy, type RetentionSubject,
} from './index.js';

export const GALLRING_STATES = ['QUEUED', 'PLANNED', 'APPROVED', 'EXECUTING', 'VERIFIED', 'REPORTED', 'ABANDONED'] as const;
export type GallringState = (typeof GALLRING_STATES)[number];

export type GallringErrorCode =
  | 'GALLRING_STATE_INVALID'
  | 'GALLRING_NOT_DUE'
  | 'GALLRING_DECISION_STALE'
  | 'GALLRING_APPROVAL_REQUIRED'
  | 'GALLRING_APPROVER_NOT_PERMITTED'
  | 'GALLRING_SELF_APPROVAL'
  | 'GALLRING_TARGET_NOT_PLANNED'
  | 'GALLRING_TARGET_DUPLICATE'
  | 'GALLRING_TARGET_NOT_EXECUTED'
  | 'GALLRING_NOT_VERIFIED'
  | 'GALLRING_TENANT_MISMATCH';

export class GallringExecutionError extends Error {
  constructor(readonly code: GallringErrorCode, message: string) {
    super(message);
    this.name = 'GallringExecutionError';
  }
}

/**
 * Targets that always apply to a case gallring. A run that does not address
 * every one of these has not gallrat the case, it has gallrat part of it —
 * and requirement 2070 says the information must not be recoverable.
 *
 * `search_index`, `cache` and `notifications` are included precisely because
 * they are the copies people forget: derived stores that keep serving the
 * content after the primary row is gone.
 */
export const MANDATORY_CASE_TARGETS: readonly GallringTarget[] = [
  'signature_case', 'documents', 'document_versions', 'object_storage',
  'evidence_packages', 'derived_renders', 'search_index', 'cache', 'notifications',
];

export interface GallringJob {
  readonly tenantId: UUID;
  readonly jobId: UUID;
  readonly state: GallringState;
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly caseIds: readonly UUID[];
  /** The decision recorded when the job was queued. Re-checked before execution. */
  readonly queuedDecision: RetentionDecision;
  readonly queuedAt: IsoDateTime;
  readonly plannedTargets: readonly GallringTarget[];
  readonly requestedBy: UUID;
  readonly approvedBy: UUID | null;
  readonly approvedAt: IsoDateTime | null;
}

function assertState(job: GallringJob, expected: GallringState): void {
  if (job.state !== expected) {
    throw new GallringExecutionError('GALLRING_STATE_INVALID', `Job is ${job.state}, expected ${expected}`);
  }
}

/* ------------------------------------------------------------------ *
 * Queue
 * ------------------------------------------------------------------ */

/**
 * Selects the cases that are actually due. Anything the decision layer says to
 * retain is left alone; only DELETE and ARCHIVE_THEN_DELETE reach the queue.
 */
export function selectDueCases(
  policy: RetentionPolicy,
  subjects: readonly RetentionSubject[],
  now: Date,
): readonly { readonly subject: RetentionSubject; readonly decision: RetentionDecision }[] {
  return subjects
    .map((subject) => ({ subject, decision: decideRetention(policy, subject, now) }))
    .filter((entry) => entry.decision.action !== 'RETAIN');
}

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

/**
 * Declares up front every store the run will touch. Declaring the plan before
 * execution is what makes an unaddressed target detectable later: without it,
 * the report can only describe what was done and has no way to notice what was
 * not.
 */
export function planGallring(job: GallringJob, additionalTargets: readonly GallringTarget[] = []): GallringJob {
  assertState(job, 'QUEUED');
  for (const target of additionalTargets) {
    if (!GALLRING_TARGETS.includes(target)) {
      throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', `Unknown gallring target ${target}`);
    }
  }
  const planned = [...new Set([...MANDATORY_CASE_TARGETS, ...additionalTargets])].sort();
  return { ...job, state: 'PLANNED', plannedTargets: planned };
}

/* ------------------------------------------------------------------ *
 * Approval
 * ------------------------------------------------------------------ */

export interface GallringApprover {
  readonly actorId: UUID;
  readonly tenantId: UUID;
  /** Requirement 2071: only permitted users may gallra. */
  readonly hasRetentionExecutePermission: boolean;
  /** Requirement 2069: gallring belongs to the customer, not the supplier. */
  readonly isPlatformStaff: boolean;
}

/**
 * Approves a planned gallring.
 *
 * Requirement 2069 cuts both ways: the customer must be able to gallra without
 * the supplier, which also means the supplier must not gallra without the
 * customer. Platform staff are refused here even with the permission bit set.
 *
 * Approval is also separated from the request. Gallring is irreversible by
 * design, and a single compromised or mistaken account should not be able to
 * both propose and carry out an irreversible deletion.
 */
export function approveGallring(job: GallringJob, approver: GallringApprover, approvedAt: IsoDateTime): GallringJob {
  assertState(job, 'PLANNED');
  if (approver.tenantId !== job.tenantId) {
    throw new GallringExecutionError('GALLRING_TENANT_MISMATCH', 'Approver belongs to another tenant');
  }
  if (approver.isPlatformStaff) {
    throw new GallringExecutionError('GALLRING_APPROVER_NOT_PERMITTED', 'Gallring is reserved for the customer, not the supplier');
  }
  if (!approver.hasRetentionExecutePermission) {
    throw new GallringExecutionError('GALLRING_APPROVER_NOT_PERMITTED', 'Approver lacks retention:execute');
  }
  if (approver.actorId === job.requestedBy) {
    throw new GallringExecutionError('GALLRING_SELF_APPROVAL', 'Gallring must be approved by someone other than the requester');
  }
  return { ...job, state: 'APPROVED', approvedBy: approver.actorId, approvedAt };
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

/**
 * Re-evaluates the decision immediately before deleting anything.
 *
 * This is the check that stops a job queued yesterday from destroying material
 * that was placed under legal hold this morning. The queued decision is
 * treated as a proposal, never as authority.
 */
export function beginGallringExecution(
  job: GallringJob,
  policy: RetentionPolicy,
  subjects: readonly RetentionSubject[],
  now: Date,
): GallringJob {
  assertState(job, 'APPROVED');
  if (subjects.length !== job.caseIds.length) {
    throw new GallringExecutionError('GALLRING_DECISION_STALE', 'Subject set no longer matches the queued cases');
  }
  for (const subject of subjects) {
    if (subject.tenantId !== job.tenantId) {
      throw new GallringExecutionError('GALLRING_TENANT_MISMATCH', 'Subject belongs to another tenant');
    }
    if (!job.caseIds.includes(subject.caseId)) {
      throw new GallringExecutionError('GALLRING_DECISION_STALE', `Case ${subject.caseId} was not in the approved job`);
    }
    const current = decideRetention(policy, subject, now);
    // A legal hold placed after queuing turns a due case into a retained one.
    // Executing the stale decision would destroy exactly what someone just
    // formally demanded be kept.
    if (current.action === 'RETAIN') {
      throw new GallringExecutionError(
        'GALLRING_DECISION_STALE',
        `Case ${subject.caseId} is no longer due for gallring: ${current.reason}`,
      );
    }
    if (current.action !== job.queuedDecision.action) {
      throw new GallringExecutionError(
        'GALLRING_DECISION_STALE',
        `Case ${subject.caseId} decision changed from ${job.queuedDecision.action} to ${current.action}`,
      );
    }
  }
  return { ...job, state: 'EXECUTING' };
}

/**
 * Checks the run against the plan before a report may be produced.
 *
 * `buildGallringReport` can only judge the outcomes it is handed. A run that
 * addressed three of nine targets hands over three verified outcomes and looks
 * complete. Comparing against the declared plan is what turns an unaddressed
 * target into a detected omission.
 */
export function verifyGallringExecution(
  job: GallringJob,
  outcomes: readonly GallringTargetOutcome[],
): GallringJob {
  assertState(job, 'EXECUTING');
  // Two outcome rows for one store can disagree — one verified, one not — and
  // whichever is read first decides the answer. Rejected here rather than at
  // report time, so the ambiguity never reaches the verification logic below.
  const addressed = new Set<GallringTarget>();
  for (const outcome of outcomes) {
    if (addressed.has(outcome.target)) {
      throw new GallringExecutionError(
        'GALLRING_TARGET_DUPLICATE',
        `Duplicate outcome reported for target ${outcome.target}`,
      );
    }
    addressed.add(outcome.target);
  }
  const missing = job.plannedTargets.filter((target) => !addressed.has(target));
  if (missing.length > 0) {
    throw new GallringExecutionError(
      'GALLRING_TARGET_NOT_EXECUTED',
      `Planned targets were never addressed: ${missing.join(', ')}`,
    );
  }
  // The converse: an outcome for something that was never planned means the
  // run deleted from a store nobody authorised.
  const unplanned = outcomes.map((outcome) => outcome.target).filter((target) => !job.plannedTargets.includes(target));
  if (unplanned.length > 0) {
    throw new GallringExecutionError(
      'GALLRING_TARGET_NOT_PLANNED',
      `Outcomes reported for unplanned targets: ${unplanned.join(', ')}`,
    );
  }
  const unverified = outcomes.filter((outcome) => !outcome.verified).map((outcome) => outcome.target);
  if (unverified.length > 0) {
    // Requirement 2070: the information must not be recoverable. A target we
    // could not confirm is a target that may still hold a readable copy.
    throw new GallringExecutionError(
      'GALLRING_NOT_VERIFIED',
      `Deletion could not be verified for: ${unverified.join(', ')}`,
    );
  }
  return { ...job, state: 'VERIFIED' };
}

export interface GallringCompletion {
  readonly job: GallringJob;
  readonly report: GallringReport;
}

/**
 * Produces the gallringsrapport (requirement 2072) and closes the job. Only a
 * verified execution reaches this point, so a report can never describe a
 * partial deletion as a completed one.
 */
export function completeGallring(
  job: GallringJob,
  outcomes: readonly GallringTargetOutcome[],
  retentionClass: RetentionPolicy['retentionClass'],
  executedAt: IsoDateTime,
): GallringCompletion {
  assertState(job, 'VERIFIED');
  if (job.approvedBy === null) {
    throw new GallringExecutionError('GALLRING_APPROVAL_REQUIRED', 'A gallring report requires a recorded approver');
  }
  const report = buildGallringReport({
    tenantId: job.tenantId,
    jobId: job.jobId,
    policyKey: job.policyKey,
    policyVersion: job.policyVersion,
    retentionClass,
    // The approver, not the requester: this is who authorised the irreversible
    // act, and the report is the evidence of who is accountable for it.
    executedBy: job.approvedBy,
    executedAt,
    caseIds: job.caseIds,
    outcomes,
  });
  if (!report.complete) {
    throw new GallringExecutionError('GALLRING_NOT_VERIFIED', 'Report is not complete');
  }
  return { job: { ...job, state: 'REPORTED' }, report };
}

/** Abandoning is always allowed: stopping a deletion is never the dangerous direction. */
export function abandonGallring(job: GallringJob, reason: string): GallringJob {
  if (job.state === 'REPORTED') {
    throw new GallringExecutionError('GALLRING_STATE_INVALID', 'A reported gallring cannot be abandoned');
  }
  void reason;
  return { ...job, state: 'ABANDONED' };
}
