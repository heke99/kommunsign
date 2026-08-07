/**
 * Skyddade personuppgifter.
 *
 * Kungälv requirement 2028: the system must support Skatteverket's collective
 * term for protected personal data. That is not one setting — it is three
 * distinct protections with different legal bases and different consequences,
 * and treating them as one boolean is how a protected person's address ends up
 * in a notification.
 *
 * The threat here is unusual and worth stating plainly, because it changes what
 * "correct" means. For most personal data the harm from disclosure is
 * regulatory. For a person with skyddad folkbokföring the harm is that someone
 * who is trying to find them succeeds. The protection therefore has to hold on
 * every channel at once — screen, export, log, email, search, support tooling —
 * and a single leak on any one of them defeats all the others.
 *
 * So this module is deny-by-default in a way the rest of the system is not:
 * an unknown output channel is refused rather than allowed, and an unknown
 * protection level is treated as the strictest rather than the weakest.
 */

import type { UUID } from '../../contracts/src/index.js';

/**
 * Skatteverket's levels, ordered weakest to strongest.
 *
 * - `SEKRETESSMARKERING`: a flag in folkbokföringen; every disclosure requires
 *   a confidentiality assessment first.
 * - `SKYDDAD_FOLKBOKFORING`: the person is registered in a former municipality
 *   and the real address is held only by Skatteverket.
 * - `FINGERADE_PERSONUPPGIFTER`: the person has been given entirely new
 *   identity details. The old identity must not be resolvable at all.
 */
export const PROTECTION_LEVELS = [
  'NONE',
  'SEKRETESSMARKERING',
  'SKYDDAD_FOLKBOKFORING',
  'FINGERADE_PERSONUPPGIFTER',
] as const;
export type ProtectionLevel = (typeof PROTECTION_LEVELS)[number];

/** Every place a person's details can leave the system. Exhaustive on purpose. */
export const OUTPUT_CHANNELS = [
  'SCREEN_AUTHORISED',
  'SCREEN_COLLEAGUE',
  'SEARCH_RESULT',
  'NOTIFICATION_EMAIL_BODY',
  'NOTIFICATION_EMAIL_SUBJECT',
  'DOCUMENT_VISIBLE_TEXT',
  'EVIDENCE_PACKAGE',
  'ARCHIVE_EXPORT',
  'APPLICATION_LOG',
  'AUDIT_LOG',
  'SUPPORT_TOOLING',
  'ANALYTICS',
  'URL',
] as const;
export type OutputChannel = (typeof OUTPUT_CHANNELS)[number];

/** The fields whose disclosure the protection actually governs. */
export const PROTECTED_FIELDS = [
  'personalNumber',
  'fullName',
  'address',
  'emailAddress',
  'phoneNumber',
  'organisationalUnit',
] as const;
export type ProtectedField = (typeof PROTECTED_FIELDS)[number];

export type ProtectedIdentityErrorCode =
  | 'PROTECTED_CHANNEL_UNKNOWN'
  | 'PROTECTED_DISCLOSURE_FORBIDDEN'
  | 'PROTECTED_ASSESSMENT_REQUIRED'
  | 'PROTECTED_ACCESS_NOT_GRANTED'
  | 'PROTECTED_GRANT_EXPIRED'
  | 'PROTECTED_TENANT_MISMATCH';

export class ProtectedIdentityError extends Error {
  constructor(readonly code: ProtectedIdentityErrorCode, message: string) {
    super(message);
    this.name = 'ProtectedIdentityError';
  }
}

export function protectionAtLeast(actual: ProtectionLevel, threshold: ProtectionLevel): boolean {
  return PROTECTION_LEVELS.indexOf(actual) >= PROTECTION_LEVELS.indexOf(threshold);
}

/**
 * Normalises whatever the caller has into a level.
 *
 * An unrecognised value becomes the *strictest* level, not `NONE`. Failing
 * open here would mean a data error or a new Skatteverket code silently
 * removes the protection — which is precisely the case where being wrong is
 * most dangerous.
 */
export function normaliseProtectionLevel(value: unknown): ProtectionLevel {
  if (value === null || value === undefined) return 'NONE';
  if (typeof value === 'string' && (PROTECTION_LEVELS as readonly string[]).includes(value)) {
    return value as ProtectionLevel;
  }
  return 'FINGERADE_PERSONUPPGIFTER';
}

/* ------------------------------------------------------------------ *
 * Disclosure policy
 * ------------------------------------------------------------------ */

/**
 * Channels that never carry an identifying field, at any protection level
 * including `NONE`.
 *
 * These are unconditional because they are the channels that outlive or escape
 * the access control around them: logs are shipped to operators, analytics to
 * third parties, and a URL ends up in browser history, referrer headers and
 * proxy logs. AGENTS.md rule 6 already forbids personal numbers here; this
 * extends the same reasoning to the other identifying fields.
 */
const NEVER_IDENTIFYING: readonly OutputChannel[] = ['APPLICATION_LOG', 'ANALYTICS', 'URL'];

/**
 * What each level permits per channel.
 *
 * Written as an explicit table rather than derived from a numeric threshold,
 * because the rules are genuinely not monotonic in an obvious way — an
 * evidence package must retain enough to prove who signed even for a protected
 * person, while a colleague's screen must not show the same information.
 */
interface ChannelRule {
  /** Fields that may appear without any further check. */
  readonly allowed: readonly ProtectedField[];
  /** Fields that require a recorded confidentiality assessment first. */
  readonly requiresAssessment: readonly ProtectedField[];
}

const ALL_FIELDS = PROTECTED_FIELDS;
const IDENTIFYING_ONLY: readonly ProtectedField[] = ['fullName', 'personalNumber'];

function rulesFor(level: ProtectionLevel, channel: OutputChannel): ChannelRule {
  if (NEVER_IDENTIFYING.includes(channel)) return { allowed: [], requiresAssessment: [] };

  switch (level) {
    case 'NONE':
      return { allowed: ALL_FIELDS, requiresAssessment: [] };

    case 'SEKRETESSMARKERING':
      // A flag, not a redaction: disclosure is possible but only after someone
      // has made and recorded a confidentiality assessment.
      switch (channel) {
        case 'SCREEN_AUTHORISED':
        case 'SUPPORT_TOOLING':
          return { allowed: [], requiresAssessment: ALL_FIELDS };
        case 'EVIDENCE_PACKAGE':
        case 'AUDIT_LOG':
          // The signature has to remain provable. These stores are already
          // access-controlled and are not disclosed without an assessment
          // anyway.
          return { allowed: IDENTIFYING_ONLY, requiresAssessment: [] };
        case 'SCREEN_COLLEAGUE':
        case 'SEARCH_RESULT':
        case 'NOTIFICATION_EMAIL_BODY':
        case 'DOCUMENT_VISIBLE_TEXT':
        case 'ARCHIVE_EXPORT':
          return { allowed: [], requiresAssessment: IDENTIFYING_ONLY };
        default:
          return { allowed: [], requiresAssessment: [] };
      }

    case 'SKYDDAD_FOLKBOKFORING':
      // The address is the thing being protected, and it is never ours to
      // disclose — Skatteverket holds it. Name may still be needed to prove a
      // signature.
      switch (channel) {
        case 'EVIDENCE_PACKAGE':
        case 'AUDIT_LOG':
          return { allowed: IDENTIFYING_ONLY, requiresAssessment: [] };
        case 'SCREEN_AUTHORISED':
          return { allowed: [], requiresAssessment: IDENTIFYING_ONLY };
        default:
          return { allowed: [], requiresAssessment: [] };
      }

    case 'FINGERADE_PERSONUPPGIFTER':
      // The old identity must not be resolvable at all. Even the evidence
      // package carries only the internal signer reference; anyone who needs
      // to resolve it goes through Skatteverket, not through us.
      return { allowed: [], requiresAssessment: [] };
  }
}

/** A recorded confidentiality assessment (menprövning). */
export interface ConfidentialityAssessment {
  readonly tenantId: UUID;
  readonly subjectId: UUID;
  readonly assessedBy: UUID;
  readonly assessedAt: string;
  readonly expiresAt: string;
  readonly ground: string;
}

export interface DisclosureRequest {
  readonly tenantId: UUID;
  readonly subjectId: UUID;
  readonly level: ProtectionLevel;
  readonly channel: OutputChannel;
  readonly fields: readonly ProtectedField[];
  readonly assessment: ConfidentialityAssessment | null;
  readonly now: Date;
}

export interface DisclosureDecision {
  /** Fields that may be rendered as-is. */
  readonly disclosed: readonly ProtectedField[];
  /** Fields that must be replaced with a non-identifying placeholder. */
  readonly redacted: readonly ProtectedField[];
}

/**
 * Decides, per channel, which fields may be disclosed.
 *
 * Returns a redaction list rather than throwing on the common path, because
 * the caller's job is usually to render *something* — a case still has to be
 * listed even when the signer's name cannot be shown. Throwing would push
 * callers towards catching and falling back, and a fallback is where the
 * unredacted value creeps back in.
 *
 * It does throw when the caller asks for a channel it does not know about, so
 * that adding an output path forces a decision here instead of defaulting to
 * disclosure.
 */
export function decideDisclosure(request: DisclosureRequest): DisclosureDecision {
  if (!OUTPUT_CHANNELS.includes(request.channel)) {
    throw new ProtectedIdentityError('PROTECTED_CHANNEL_UNKNOWN', `Unknown output channel ${request.channel}`);
  }
  // A subject-scoped assessment from another tenant, or about another person,
  // is not an assessment for this disclosure.
  const assessment = request.assessment;
  const assessmentValid = assessment !== null
    && assessment.tenantId === request.tenantId
    && assessment.subjectId === request.subjectId
    && assessment.ground.trim() !== ''
    && Date.parse(assessment.expiresAt) > request.now.getTime();

  const rule = rulesFor(request.level, request.channel);
  const disclosed: ProtectedField[] = [];
  const redacted: ProtectedField[] = [];
  for (const field of request.fields) {
    if (rule.allowed.includes(field)) disclosed.push(field);
    else if (assessmentValid && rule.requiresAssessment.includes(field)) disclosed.push(field);
    else redacted.push(field);
  }
  return { disclosed, redacted };
}

/**
 * The email subject line is separated out because it is the one channel that
 * is *always* readable without authenticating: it appears in notification
 * previews on a lock screen, in mail server logs, and in any shared mailbox
 * the address happens to be forwarded to.
 *
 * So it carries no identifying field for anyone — protected or not.
 */
export function assertSubjectLineIsSafe(subject: string, identifiers: readonly string[]): void {
  for (const identifier of identifiers) {
    if (identifier.trim() !== '' && subject.includes(identifier)) {
      throw new ProtectedIdentityError(
        'PROTECTED_DISCLOSURE_FORBIDDEN',
        'An email subject must not carry an identifying value',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Support and administrative access
 * ------------------------------------------------------------------ */

export interface SupportAccessGrant {
  readonly tenantId: UUID;
  readonly subjectId: UUID;
  readonly grantedTo: UUID;
  /** Granted by the customer, never by the supplier to itself. */
  readonly grantedBy: UUID;
  readonly grantedByCustomer: boolean;
  readonly expiresAt: string;
  readonly reason: string;
}

/**
 * Support access to a protected person's data.
 *
 * Standing access is refused: every look is a separate, time-boxed, reasoned
 * grant issued by the customer. That is deliberately inconvenient. The
 * alternative — a support role that can read protected data whenever it likes
 * — means the protection depends on the supplier's internal discipline rather
 * than on a control the customer can see and revoke.
 */
export function assertSupportAccess(
  grant: SupportAccessGrant | null,
  request: { readonly tenantId: UUID; readonly subjectId: UUID; readonly actorId: UUID; readonly now: Date },
): void {
  if (grant === null) {
    throw new ProtectedIdentityError('PROTECTED_ACCESS_NOT_GRANTED', 'Support access to protected personal data requires an explicit grant');
  }
  if (grant.tenantId !== request.tenantId) {
    throw new ProtectedIdentityError('PROTECTED_TENANT_MISMATCH', 'The grant belongs to another tenant');
  }
  // A grant for one protected person does not open the others.
  if (grant.subjectId !== request.subjectId || grant.grantedTo !== request.actorId) {
    throw new ProtectedIdentityError('PROTECTED_ACCESS_NOT_GRANTED', 'The grant does not cover this person or this actor');
  }
  if (!grant.grantedByCustomer) {
    throw new ProtectedIdentityError('PROTECTED_ACCESS_NOT_GRANTED', 'Only the customer may grant access to protected personal data');
  }
  if (!grant.reason.trim()) {
    throw new ProtectedIdentityError('PROTECTED_ACCESS_NOT_GRANTED', 'A grant must record why access was needed');
  }
  if (Date.parse(grant.expiresAt) <= request.now.getTime()) {
    throw new ProtectedIdentityError('PROTECTED_GRANT_EXPIRED', 'The grant has expired');
  }
}

/**
 * Whether a person may appear in a listing or search result at all.
 *
 * Distinct from field redaction: for the stronger levels the *existence* of a
 * match is itself informative. Returning a redacted row still confirms that
 * this person has a case in this municipality, which for someone with skyddad
 * folkbokföring can be the piece of information that locates them.
 */
export function isSearchable(level: ProtectionLevel): boolean {
  return !protectionAtLeast(level, 'SKYDDAD_FOLKBOKFORING');
}

/** Non-identifying placeholder for a redacted field, in Swedish. */
export function redactedPlaceholder(field: ProtectedField): string {
  switch (field) {
    case 'personalNumber': return 'Skyddad uppgift';
    case 'fullName': return 'Skyddad identitet';
    case 'address': return 'Skyddad adress';
    case 'emailAddress': return 'Skyddad e-postadress';
    case 'phoneNumber': return 'Skyddat telefonnummer';
    case 'organisationalUnit': return 'Skyddad organisationstillhörighet';
  }
}
