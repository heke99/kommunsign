/**
 * Gallring (retention and disposal).
 *
 * Covers Kungälv requirements 2068-2072: the system must have a gallring
 * function, the customer must be able to run it without supplier involvement,
 * gallrad information must not be recoverable, the function must be permission
 * controlled, and every gallring must produce a traceable report.
 *
 * This module is the decision layer only. It decides *what* may be gallrat and
 * *when*; executing the deletion against the database, object storage and
 * derived data is the caller's responsibility. Keeping the decision pure makes
 * the rules — especially the legal-hold and log-floor rules — directly testable.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';

/** Modes as stored in control.tenant_retention_policies.mode. */
export const RETENTION_MODES = [
  'retain_forever',
  'retain_for_period',
  'archive_then_delete',
  'delete_after_period',
  'legal_hold',
] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

/**
 * Retention classes are tracked separately because they answer to different
 * rules. Gallring of business data must never take the access log with it:
 * PUB-avtalet 7.5 states that logs may be gallrade only five years after the
 * logging occasion unless the Instruktion says otherwise.
 */
export const RETENTION_CLASSES = ['business_data', 'security_log', 'access_log'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** PUB-avtalet 7.5. A floor, not a target: longer retention is permitted. */
export const ACCESS_LOG_MINIMUM_RETENTION_DAYS = 5 * 365;

export interface RetentionPolicy {
  readonly policyKey: string;
  readonly version: number;
  readonly retentionClass: RetentionClass;
  readonly mode: RetentionMode;
  readonly periodDays: number | null;
  readonly active: boolean;
  /**
   * Set only when the personuppgiftsansvarige has issued a written Instruktion
   * that departs from the PUB-avtalet default. Without it a log policy may not
   * be shorter than the statutory floor.
   */
  readonly instructionReference?: string;
}

export interface RetentionSubject {
  readonly tenantId: UUID;
  readonly caseId: UUID;
  /** Terminal states are the only ones eligible for gallring. */
  readonly status: string;
  /** When the case reached its terminal state. Null while still running. */
  readonly closedAt: IsoDateTime | null;
  readonly legalHoldActive: boolean;
}

export type RetentionAction = 'RETAIN' | 'ARCHIVE_THEN_DELETE' | 'DELETE';

export type RetentionReason =
  | 'LEGAL_HOLD'
  | 'CASE_NOT_CLOSED'
  | 'POLICY_INACTIVE'
  | 'RETAIN_FOREVER'
  | 'PERIOD_NOT_ELAPSED'
  | 'MINIMUM_RETENTION_NOT_ELAPSED'
  | 'DUE_FOR_DELETION'
  | 'DUE_FOR_ARCHIVE_THEN_DELETION';

export interface RetentionDecision {
  readonly action: RetentionAction;
  readonly reason: RetentionReason;
  /** When the subject becomes eligible. Null when it never becomes eligible. */
  readonly eligibleAt: IsoDateTime | null;
}

export class RetentionPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RetentionPolicyError';
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'declined', 'expired', 'cancelled', 'failed', 'archived']);

/**
 * Rejects policies that would breach the PUB-avtalet log floor or that are
 * internally inconsistent. Called when a policy is created or activated so a
 * bad policy cannot reach the executor.
 */
export function assertPolicyIsLawful(policy: RetentionPolicy): void {
  if (!RETENTION_MODES.includes(policy.mode)) {
    throw new RetentionPolicyError('RETENTION_MODE_INVALID', 'Unknown retention mode');
  }
  if (policy.version < 1 || !Number.isSafeInteger(policy.version)) {
    throw new RetentionPolicyError('RETENTION_VERSION_INVALID', 'Policy version must be a positive integer');
  }
  const needsPeriod = policy.mode === 'retain_for_period' || policy.mode === 'delete_after_period' || policy.mode === 'archive_then_delete';
  if (needsPeriod) {
    if (policy.periodDays === null || !Number.isSafeInteger(policy.periodDays) || policy.periodDays < 0) {
      throw new RetentionPolicyError('RETENTION_PERIOD_REQUIRED', `Mode ${policy.mode} requires a non-negative periodDays`);
    }
  } else if (policy.periodDays !== null) {
    throw new RetentionPolicyError('RETENTION_PERIOD_FORBIDDEN', `Mode ${policy.mode} must not carry periodDays`);
  }

  const isLog = policy.retentionClass === 'access_log' || policy.retentionClass === 'security_log';
  if (isLog && policy.mode === 'archive_then_delete') {
    throw new RetentionPolicyError('RETENTION_LOG_MODE_INVALID', 'Log retention classes are not archived through the case archive path');
  }
  if (
    policy.retentionClass === 'access_log' &&
    policy.periodDays !== null &&
    policy.periodDays < ACCESS_LOG_MINIMUM_RETENTION_DAYS &&
    !policy.instructionReference
  ) {
    throw new RetentionPolicyError(
      'RETENTION_BELOW_PUB_FLOOR',
      `Access log retention below ${ACCESS_LOG_MINIMUM_RETENTION_DAYS} days requires a documented Instruktion (PUB-avtalet 7.5)`,
    );
  }
}

function addDays(instant: string, days: number): string {
  const base = Date.parse(instant);
  if (!Number.isFinite(base)) throw new RetentionPolicyError('RETENTION_ANCHOR_INVALID', 'Retention anchor is not a valid timestamp');
  return new Date(base + days * 86_400_000).toISOString();
}

/**
 * Decides what may happen to one case under one policy at a given time.
 *
 * Order matters. A legal hold wins over every other rule, and a case that has
 * not reached a terminal state is never eligible regardless of age — its
 * retention clock has not started.
 */
export function decideRetention(
  policy: RetentionPolicy,
  subject: RetentionSubject,
  now: Date = new Date(),
): RetentionDecision {
  assertPolicyIsLawful(policy);

  if (subject.legalHoldActive || policy.mode === 'legal_hold') {
    return { action: 'RETAIN', reason: 'LEGAL_HOLD', eligibleAt: null };
  }
  if (!policy.active) {
    return { action: 'RETAIN', reason: 'POLICY_INACTIVE', eligibleAt: null };
  }
  if (policy.mode === 'retain_forever') {
    return { action: 'RETAIN', reason: 'RETAIN_FOREVER', eligibleAt: null };
  }
  if (!subject.closedAt || !TERMINAL_STATUSES.has(subject.status)) {
    return { action: 'RETAIN', reason: 'CASE_NOT_CLOSED', eligibleAt: null };
  }

  const eligibleAt = addDays(subject.closedAt, policy.periodDays ?? 0);
  if (Date.parse(eligibleAt) > now.getTime()) {
    return {
      action: 'RETAIN',
      reason: policy.mode === 'retain_for_period' ? 'MINIMUM_RETENTION_NOT_ELAPSED' : 'PERIOD_NOT_ELAPSED',
      eligibleAt,
    };
  }

  // retain_for_period expresses a minimum retention only. Once it has elapsed
  // the case may be gallrat, but never automatically: an operator with
  // retention:execute must decide. delete_after_period is the automatic mode.
  if (policy.mode === 'retain_for_period') {
    return { action: 'RETAIN', reason: 'MINIMUM_RETENTION_NOT_ELAPSED', eligibleAt };
  }
  if (policy.mode === 'archive_then_delete') {
    return { action: 'ARCHIVE_THEN_DELETE', reason: 'DUE_FOR_ARCHIVE_THEN_DELETION', eligibleAt };
  }
  return { action: 'DELETE', reason: 'DUE_FOR_DELETION', eligibleAt };
}

/**
 * Targets a gallring touches. Recorded per executed job so the report can show
 * that every copy was addressed, not just the primary row (krav 2070).
 */
export const GALLRING_TARGETS = [
  'signature_case',
  'documents',
  'document_versions',
  'object_storage',
  'evidence_packages',
  'derived_renders',
  'search_index',
  'cache',
  'notifications',
] as const;
export type GallringTarget = (typeof GALLRING_TARGETS)[number];

export interface GallringTargetOutcome {
  readonly target: GallringTarget;
  readonly deletedCount: number;
  /** False when the target could not be confirmed deleted. */
  readonly verified: boolean;
  readonly note?: string;
}

export interface GallringReportInput {
  readonly tenantId: UUID;
  readonly jobId: UUID;
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly retentionClass: RetentionClass;
  readonly executedBy: UUID;
  readonly executedAt: IsoDateTime;
  readonly caseIds: readonly UUID[];
  readonly outcomes: readonly GallringTargetOutcome[];
}

export interface GallringReport extends GallringReportInput {
  readonly schemaVersion: 1;
  readonly caseCount: number;
  readonly deletedTotal: number;
  /** True only when every target reported a verified deletion (krav 2070). */
  readonly complete: boolean;
  readonly unverifiedTargets: readonly GallringTarget[];
}

/**
 * Builds the gallringsrapport required by krav 2072. The report is the evidence
 * that a gallring happened and that it was complete; it deliberately records
 * unverified targets rather than reporting success on partial deletion.
 */
export function buildGallringReport(input: GallringReportInput): GallringReport {
  if (input.caseIds.length === 0) {
    throw new RetentionPolicyError('GALLRING_REPORT_EMPTY', 'A gallring report must cover at least one case');
  }
  const seen = new Set<GallringTarget>();
  for (const outcome of input.outcomes) {
    if (!GALLRING_TARGETS.includes(outcome.target)) {
      throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', `Unknown gallring target ${outcome.target}`);
    }
    if (seen.has(outcome.target)) {
      throw new RetentionPolicyError('GALLRING_TARGET_DUPLICATE', `Duplicate gallring target ${outcome.target}`);
    }
    seen.add(outcome.target);
    if (outcome.deletedCount < 0 || !Number.isSafeInteger(outcome.deletedCount)) {
      throw new RetentionPolicyError('GALLRING_COUNT_INVALID', 'Deleted count must be a non-negative integer');
    }
  }
  const unverifiedTargets = input.outcomes.filter((outcome) => !outcome.verified).map((outcome) => outcome.target);
  return {
    ...input,
    schemaVersion: 1,
    caseCount: input.caseIds.length,
    deletedTotal: input.outcomes.reduce((total, outcome) => total + outcome.deletedCount, 0),
    complete: unverifiedTargets.length === 0,
    unverifiedTargets,
  };
}
