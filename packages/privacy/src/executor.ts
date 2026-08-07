/**
 * Rättighetsbegäran — exekvering (data subject rights workflow).
 *
 * Beslutsskiktet i `./index.ts` avgör *vad* ett svar måste täcka och när det
 * förfaller. Det här är livscykeln som bär en begäran hela vägen: mottagen →
 * identitet verifierad → under handläggning → åtgärdad → levererad.
 *
 * Kungälv krav 2023 och 2024. Delarna som behöver en livscykel snarare än ett
 * rent beslut är de där tid går och där något kan ändras under tiden.
 *
 * Fyra fel den här modulen finns för att omöjliggöra:
 *
 *   1. Att lämna ut personuppgifter till fel person. En rättighetsbegäran är
 *      den enklaste vägen till ett registerutdrag om identiteten inte
 *      verifieras först — man behöver bara påstå att man är någon. Ingen
 *      åtgärd får påbörjas före verifierad identitet.
 *
 *   2. Att radera trots legal hold. Rätten till radering viker för rättsliga
 *      förpliktelser (GDPR art. 17.3 b), och hold-läget omprövas vid
 *      utförandet och inte bara när begäran togs emot.
 *
 *   3. Att leverera ett svar som ser fullständigt ut men saknar ett register.
 *      Beslutsskiktet vägrar redan bygga ett sådant svar; här säkerställs att
 *      ingen väg går runt det.
 *
 *   4. Att tappa trettiodagarsfristen tyst. Fristen räknas från mottagandet,
 *      inte från när handläggningen råkade börja, och en försenad begäran är
 *      synlig i tillståndet i stället för att bara vara ett datum som passerat.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';
import {
  PrivacyRequestError, RESPONSE_DEADLINE_DAYS, buildDataSubjectResponse,
  type DataSubjectRequest, type DataSubjectResponse, type DataSubjectRight, type StoreCoverage,
} from './index.js';

export const PRIVACY_REQUEST_STATES = [
  'RECEIVED',
  'IDENTITY_VERIFIED',
  'IN_PROGRESS',
  'FULFILLED',
  'DELIVERED',
  'REFUSED',
] as const;
export type PrivacyRequestState = (typeof PRIVACY_REQUEST_STATES)[number];

export type PrivacyExecutionCode =
  | 'PRIVACY_STATE_INVALID'
  | 'PRIVACY_IDENTITY_NOT_VERIFIED'
  | 'PRIVACY_IDENTITY_ASSURANCE_TOO_LOW'
  | 'PRIVACY_SUBJECT_MISMATCH'
  | 'PRIVACY_TENANT_MISMATCH'
  | 'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD'
  | 'PRIVACY_RESTRICTION_ACTIVE'
  | 'PRIVACY_NOT_FULFILLED'
  | 'PRIVACY_REFUSAL_NEEDS_GROUND';

export class PrivacyExecutionError extends Error {
  constructor(readonly code: PrivacyExecutionCode, message: string) {
    super(message);
    this.name = 'PrivacyExecutionError';
  }
}

/**
 * Hur den registrerades identitet styrktes. Assurance är med eftersom en
 * e-postbekräftelse inte är samma sak som BankID, och ett registerutdrag som
 * lämnas ut på en e-postadress någon råkar kontrollera är ett personuppgifts-
 * incident i sig.
 */
export interface SubjectIdentityVerification {
  readonly verified: boolean;
  readonly method: string;
  readonly assuranceLevel: 'LOW' | 'SUBSTANTIAL' | 'HIGH';
  /** Den verifierade personens interna subjekt-ID, aldrig personnummer. */
  readonly subjectId: UUID;
  readonly verifiedAt: IsoDateTime;
}

export interface PrivacyRequestJob {
  readonly request: DataSubjectRequest;
  readonly state: PrivacyRequestState;
  /** Den registrerade som begäran gäller. Sätts när ärendet skapas. */
  readonly subjectId: UUID;
  readonly identity: SubjectIdentityVerification | null;
  readonly handledBy: UUID | null;
  readonly refusalGround: string | null;
  readonly response: DataSubjectResponse | null;
}

/**
 * Rättigheter som lämnar ut eller ändrar personuppgifter kräver stark
 * identitet. RESTRICTION gör det inte: att begränsa behandlingen är en åtgärd
 * som skyddar den registrerade, och att kräva stark identitet för den skulle
 * göra skyddet svårare att få än ingreppet.
 */
const HIGH_ASSURANCE_RIGHTS: readonly DataSubjectRight[] = ['ACCESS', 'ERASURE', 'PORTABILITY', 'RECTIFICATION'];

function assertState(job: PrivacyRequestJob, expected: PrivacyRequestState): void {
  if (job.state !== expected) {
    throw new PrivacyExecutionError('PRIVACY_STATE_INVALID', `Begäran är ${job.state}, förväntade ${expected}`);
  }
}

/** Fristen räknas från mottagandet (PUB-avtalet 10.1), inte från handläggningsstart. */
export function deadlineFor(request: DataSubjectRequest): IsoDateTime {
  const base = Date.parse(request.receivedAt);
  if (!Number.isFinite(base)) {
    throw new PrivacyRequestError('PRIVACY_TIMESTAMP_INVALID', 'receivedAt är inte en giltig tidsstämpel');
  }
  return new Date(base + RESPONSE_DEADLINE_DAYS * 86_400_000).toISOString();
}

/**
 * Verifierar den registrerades identitet.
 *
 * Det här är den enda vägen ut ur RECEIVED. En rättighetsbegäran är annars den
 * enklaste vägen till någon annans registerutdrag: det räcker att påstå att
 * man är dem.
 */
export function verifySubjectIdentity(
  job: PrivacyRequestJob,
  identity: SubjectIdentityVerification,
): PrivacyRequestJob {
  assertState(job, 'RECEIVED');
  if (!identity.verified) {
    throw new PrivacyExecutionError('PRIVACY_IDENTITY_NOT_VERIFIED', 'Identiteten är inte verifierad');
  }
  // Verifierad *någon* räcker inte. Det måste vara den begäran gäller.
  if (identity.subjectId !== job.subjectId) {
    throw new PrivacyExecutionError('PRIVACY_SUBJECT_MISMATCH', 'Den verifierade identiteten är inte den begäran avser');
  }
  if (HIGH_ASSURANCE_RIGHTS.includes(job.request.right) && identity.assuranceLevel !== 'HIGH') {
    throw new PrivacyExecutionError(
      'PRIVACY_IDENTITY_ASSURANCE_TOO_LOW',
      `${job.request.right} kräver stark identitet; ${identity.assuranceLevel} räcker inte`,
    );
  }
  return { ...job, state: 'IDENTITY_VERIFIED', identity };
}

export function beginHandling(job: PrivacyRequestJob, handledBy: UUID, tenantId: UUID): PrivacyRequestJob {
  assertState(job, 'IDENTITY_VERIFIED');
  if (tenantId !== job.request.tenantId) {
    throw new PrivacyExecutionError('PRIVACY_TENANT_MISMATCH', 'Handläggaren tillhör en annan tenant');
  }
  return { ...job, state: 'IN_PROGRESS', handledBy };
}

/**
 * Genomför åtgärden och bygger svaret.
 *
 * `legalHoldActive` skickas in på nytt i stället för att läsas från begäran,
 * eftersom ett legal hold kan ha lagts efter att begäran togs emot. Att lita
 * på det ursprungliga värdet skulle radera material som någon under tiden
 * formellt krävt bevarat — samma fel som gallringsexekveringen förhindrar.
 */
export function fulfilRequest(
  job: PrivacyRequestJob,
  coverage: readonly StoreCoverage[],
  legalHoldActive: boolean,
  restrictionActive: boolean,
): PrivacyRequestJob {
  assertState(job, 'IN_PROGRESS');
  if (job.identity === null) {
    throw new PrivacyExecutionError('PRIVACY_IDENTITY_NOT_VERIFIED', 'Ingen verifierad identitet på ärendet');
  }
  // En pågående begränsning av behandlingen (art. 18) hindrar radering:
  // uppgifterna ska bevaras men inte behandlas medan tvisten pågår.
  if (job.request.right === 'ERASURE' && restrictionActive) {
    throw new PrivacyExecutionError(
      'PRIVACY_RESTRICTION_ACTIVE',
      'Behandlingen är begränsad enligt artikel 18; uppgifterna ska bevaras tills begränsningen hävs',
    );
  }
  // Beslutsskiktet vägrar bygga ett ofullständigt svar. Det anropas här så att
  // ingen väg går runt kontrollen.
  const response = buildDataSubjectResponse({ ...job.request, legalHoldActive }, coverage);
  return { ...job, state: 'FULFILLED', response };
}

/**
 * Levererar svaret. Skilt från fulfilRequest eftersom åtgärden och utlämnandet
 * är olika händelser med olika bevisbehov: den ena ändrar data, den andra
 * lämnar ut den.
 */
export function deliverResponse(job: PrivacyRequestJob): PrivacyRequestJob {
  assertState(job, 'FULFILLED');
  if (job.response === null || !job.response.complete) {
    throw new PrivacyExecutionError('PRIVACY_NOT_FULFILLED', 'Ett ofullständigt svar får inte levereras');
  }
  return { ...job, state: 'DELIVERED' };
}

/**
 * Avslår begäran. Ett avslag utan angiven rättslig grund är inte ett avslag,
 * det är en utebliven handläggning — och den registrerade har rätt att få veta
 * varför för att kunna klaga.
 */
export function refuseRequest(job: PrivacyRequestJob, ground: string): PrivacyRequestJob {
  if (job.state === 'DELIVERED') {
    throw new PrivacyExecutionError('PRIVACY_STATE_INVALID', 'En levererad begäran kan inte avslås i efterhand');
  }
  if (!ground.trim()) {
    throw new PrivacyExecutionError('PRIVACY_REFUSAL_NEEDS_GROUND', 'Ett avslag kräver angiven rättslig grund');
  }
  return { ...job, state: 'REFUSED', refusalGround: ground.trim() };
}

/**
 * Begäranden som passerat fristen och ännu inte levererats.
 *
 * Räknar mot mottagandet och tittar på tillståndet, så att en försenad begäran
 * är synlig som ett öppet ärende i stället för att bara vara ett datum som
 * hunnit passera obemärkt.
 */
export function overdueRequests(
  jobs: readonly PrivacyRequestJob[],
  now: Date,
): readonly { readonly requestId: UUID; readonly dueAt: IsoDateTime; readonly state: PrivacyRequestState }[] {
  return jobs
    .filter((job) => job.state !== 'DELIVERED' && job.state !== 'REFUSED')
    .map((job) => ({ requestId: job.request.requestId, dueAt: deadlineFor(job.request), state: job.state }))
    .filter((entry) => Date.parse(entry.dueAt) <= now.getTime())
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt, 'en'));
}
