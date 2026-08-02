import { sha256Hex } from '../../crypto/src/hash.js';
import { randomToken } from '../../crypto/src/tokens.js';

export const APPLICATION_STATUSES = [
  'draft', 'email_verification_pending', 'email_verified', 'submitted',
  'under_initial_review', 'additional_information_requested', 'resubmitted',
  'commercial_review', 'legal_review', 'security_review', 'technical_review',
  'approved', 'rejected', 'withdrawn', 'provisioning', 'provisioning_failed',
  'onboarding', 'ready_for_acceptance_test', 'acceptance_test_failed',
  'ready_for_activation', 'active', 'archived',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const PROVISIONING_STATUSES = [
  'requested', 'validated', 'queued', 'running', 'waiting_for_external_dependency',
  'retry_scheduled', 'failed', 'partially_completed', 'completed', 'cancelled',
] as const;
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];

export const ACTIVATION_STATUSES = [
  'requested', 'pending_approval', 'approved', 'rejected', 'activated', 'cancelled',
] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

const applicationTransitions: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  draft: ['email_verification_pending', 'withdrawn'],
  email_verification_pending: ['email_verified', 'withdrawn'],
  email_verified: ['submitted', 'withdrawn'],
  submitted: ['under_initial_review', 'withdrawn'],
  under_initial_review: ['additional_information_requested', 'commercial_review', 'legal_review', 'security_review', 'technical_review', 'rejected', 'withdrawn'],
  additional_information_requested: ['resubmitted', 'withdrawn'],
  resubmitted: ['under_initial_review', 'commercial_review', 'legal_review', 'security_review', 'technical_review', 'rejected', 'withdrawn'],
  commercial_review: ['legal_review', 'security_review', 'technical_review', 'additional_information_requested', 'approved', 'rejected'],
  legal_review: ['commercial_review', 'security_review', 'technical_review', 'additional_information_requested', 'approved', 'rejected'],
  security_review: ['commercial_review', 'legal_review', 'technical_review', 'additional_information_requested', 'approved', 'rejected'],
  technical_review: ['commercial_review', 'legal_review', 'security_review', 'additional_information_requested', 'approved', 'rejected'],
  approved: ['provisioning', 'archived'],
  rejected: ['archived'],
  withdrawn: ['archived'],
  provisioning: ['provisioning_failed', 'onboarding'],
  provisioning_failed: ['provisioning', 'rejected', 'archived'],
  onboarding: ['ready_for_acceptance_test', 'archived'],
  ready_for_acceptance_test: ['acceptance_test_failed', 'ready_for_activation'],
  acceptance_test_failed: ['onboarding', 'ready_for_acceptance_test', 'archived'],
  ready_for_activation: ['active', 'onboarding', 'archived'],
  active: ['archived'],
  archived: [],
};

export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return applicationTransitions[from].includes(to);
}

export function assertApplicationTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransitionApplication(from, to)) throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
}

export function formatApplicationReference(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2020 || year > 9999) throw new Error('APPLICATION_REFERENCE_YEAR_INVALID');
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999999) throw new Error('APPLICATION_REFERENCE_SEQUENCE_INVALID');
  return `ONB-${year}-${String(sequence).padStart(6, '0')}`;
}

export interface EmailVerificationRecord {
  readonly applicationId: string;
  readonly email: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly usedAt?: string;
  readonly revokedAt?: string;
}

export async function createEmailVerification(input: {
  readonly applicationId: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly now?: Date;
}): Promise<{ readonly token: string; readonly record: EmailVerificationRecord }> {
  const now = input.now ?? new Date();
  const normalizedEmail = normalizeEmail(input.email);
  if (Date.parse(input.expiresAt) <= now.getTime()) throw new Error('EMAIL_VERIFICATION_EXPIRY_INVALID');
  const token = randomToken(32);
  return {
    token,
    record: {
      applicationId: input.applicationId,
      email: normalizedEmail,
      tokenHash: await sha256Hex(token),
      expiresAt: input.expiresAt,
      createdAt: now.toISOString(),
    },
  };
}

export async function verifyEmailToken(record: EmailVerificationRecord, token: string, email: string, now = new Date()): Promise<void> {
  if (record.revokedAt) throw new Error('EMAIL_VERIFICATION_REVOKED');
  if (record.usedAt) throw new Error('EMAIL_VERIFICATION_ALREADY_USED');
  if (now.getTime() >= Date.parse(record.expiresAt)) throw new Error('EMAIL_VERIFICATION_EXPIRED');
  if (record.email !== normalizeEmail(email)) throw new Error('EMAIL_VERIFICATION_EMAIL_MISMATCH');
  if (!constantTimeHexEqual(record.tokenHash, await sha256Hex(token))) throw new Error('EMAIL_VERIFICATION_TOKEN_INVALID');
}

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('EMAIL_INVALID');
  return normalized;
}

export function normalizeOrganizationNumber(value: string): string {
  const normalized = value.replace(/[^0-9]/g, '');
  if (!/^\d{10}$/.test(normalized)) throw new Error('ORGANIZATION_NUMBER_INVALID');
  return normalized;
}

export function assertDistinctApprovers(initiatedBy: string, approvedBy: string): void {
  if (!initiatedBy || !approvedBy) throw new Error('APPROVER_REQUIRED');
  if (initiatedBy === approvedBy) throw new Error('TWO_PERSON_APPROVAL_REQUIRED');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
