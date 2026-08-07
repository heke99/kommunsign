/**
 * Registrerades rättigheter (GDPR data subject rights).
 *
 * Krav 2023: stöd för registerutdrag, rättelse, begränsning, radering och
 * dataportabilitet, för både externa parter och användare av systemet.
 *
 * Kommunsign lagrar personuppgifter i två separata databaser plus objektlagring
 * och auditlogg. Den vanligaste och allvarligaste defekten i en sådan
 * arkitektur är att en rättighetsbegäran besvaras från en av dem. Modulen är
 * därför byggd så att en begäran inte kan slutföras utan att varje register är
 * uttryckligen redovisat.
 *
 * Beslutslager. Själva sökningen och raderingen görs av anropande kod.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';

export const DATA_SUBJECT_RIGHTS = [
  'ACCESS',
  'RECTIFICATION',
  'RESTRICTION',
  'ERASURE',
  'PORTABILITY',
] as const;
export type DataSubjectRight = (typeof DATA_SUBJECT_RIGHTS)[number];

/**
 * Varje register som kan innehålla personuppgifter. Listan är uttömmande med
 * flit: en ny lagringsplats ska tvinga fram ett kompletterande beslut här,
 * inte glömmas bort i en enskild förfrågan.
 */
export const PERSONAL_DATA_STORES = [
  'CONTROL',
  'DATA',
  'OBJECT_STORAGE',
  'AUDIT_LOG',
  'BACKUP',
] as const;
export type PersonalDataStore = (typeof PERSONAL_DATA_STORES)[number];

/**
 * PUB-avtalet 10.1: åtgärd vid begärd rättelse eller radering ska vidtas utan
 * onödigt dröjsmål och senast inom trettio dagar.
 */
export const RESPONSE_DEADLINE_DAYS = 30;

export class PrivacyRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PrivacyRequestError';
  }
}

export interface StoreCoverage {
  readonly store: PersonalDataStore;
  /** Antal poster som berörs. Noll är ett giltigt, redovisat resultat. */
  readonly recordCount: number;
  /** True när registret faktiskt genomsökts eller behandlats. */
  readonly searched: boolean;
  /**
   * Satt när registret medvetet undantas från åtgärden, med rättslig grund.
   * Ett undantag utan grund accepteras inte.
   */
  readonly exemptionReason?: string;
}

export interface DataSubjectRequest {
  readonly tenantId: UUID;
  readonly requestId: UUID;
  readonly right: DataSubjectRight;
  readonly receivedAt: IsoDateTime;
  /** True när ärenden som rör den registrerade omfattas av legal hold. */
  readonly legalHoldActive: boolean;
}

/**
 * Register som inte får raderas vid en raderingsbegäran, med den grund som
 * gör undantaget lagligt. Rätten till radering är inte absolut: den viker för
 * rättsliga förpliktelser enligt GDPR artikel 17.3 b.
 */
const ERASURE_EXEMPT_STORES: Readonly<Partial<Record<PersonalDataStore, string>>> = {
  // PUB-avtalet 7.5 kräver att åtkomstloggar bevaras i fem år. Loggen kan
  // därför inte raderas på begäran, men det ska framgå av svaret.
  AUDIT_LOG: 'Åtkomstloggar bevaras enligt PUB-avtalet 7.5 och raderas först fem år efter loggningstillfället',
  // Backuper raderas genom att retentionen löper ut, inte genom punktradering.
  BACKUP: 'Säkerhetskopior punktraderas inte; uppgifterna försvinner när backupretentionen löper ut',
};

export interface DataSubjectResponse {
  readonly requestId: UUID;
  readonly right: DataSubjectRight;
  readonly schemaVersion: 1;
  readonly dueAt: IsoDateTime;
  readonly coverage: readonly StoreCoverage[];
  readonly totalRecords: number;
  /** Register som medvetet undantagits, med grund. */
  readonly exemptedStores: readonly PersonalDataStore[];
  readonly complete: boolean;
}

function addDays(instant: string, days: number): string {
  const base = Date.parse(instant);
  if (!Number.isFinite(base)) throw new PrivacyRequestError('PRIVACY_TIMESTAMP_INVALID', 'receivedAt is not a valid timestamp');
  return new Date(base + days * 86_400_000).toISOString();
}

/**
 * Bygger svaret på en rättighetsbegäran och vägrar när det är ofullständigt.
 *
 * Kastar hellre än att svara delvis: ett registerutdrag som tyst utelämnar
 * CONTROL är värre än inget utdrag, eftersom det ser fullständigt ut.
 */
export function buildDataSubjectResponse(
  request: DataSubjectRequest,
  coverage: readonly StoreCoverage[],
): DataSubjectResponse {
  if (!DATA_SUBJECT_RIGHTS.includes(request.right)) {
    throw new PrivacyRequestError('PRIVACY_RIGHT_UNKNOWN', `Unknown data subject right ${request.right}`);
  }

  // Radering blockeras av legal hold på samma sätt som gallring.
  if (request.right === 'ERASURE' && request.legalHoldActive) {
    throw new PrivacyRequestError(
      'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD',
      'Radering kan inte utföras medan ärenden omfattas av legal hold',
    );
  }

  const seen = new Set<PersonalDataStore>();
  for (const entry of coverage) {
    if (!PERSONAL_DATA_STORES.includes(entry.store)) {
      throw new PrivacyRequestError('PRIVACY_STORE_UNKNOWN', `Unknown personal data store ${entry.store}`);
    }
    if (seen.has(entry.store)) {
      throw new PrivacyRequestError('PRIVACY_STORE_DUPLICATE', `Duplicate coverage for ${entry.store}`);
    }
    seen.add(entry.store);
    if (entry.recordCount < 0 || !Number.isSafeInteger(entry.recordCount)) {
      throw new PrivacyRequestError('PRIVACY_RECORD_COUNT_INVALID', 'Record count must be a non-negative integer');
    }
    // Ett register är antingen genomsökt eller undantaget med grund. Aldrig
    // varken eller: det är precis så CONTROL glöms bort.
    if (!entry.searched && !entry.exemptionReason?.trim()) {
      throw new PrivacyRequestError(
        'PRIVACY_STORE_NOT_SEARCHED',
        `${entry.store} är varken genomsökt eller undantaget med angiven grund`,
      );
    }
  }

  const missing = PERSONAL_DATA_STORES.filter((store) => !seen.has(store));
  if (missing.length > 0) {
    throw new PrivacyRequestError(
      'PRIVACY_COVERAGE_INCOMPLETE',
      `Rättighetsbegäran saknar redovisning för: ${missing.join(', ')}`,
    );
  }

  return {
    requestId: request.requestId,
    right: request.right,
    schemaVersion: 1,
    dueAt: addDays(request.receivedAt, RESPONSE_DEADLINE_DAYS),
    coverage,
    totalRecords: coverage.reduce((total, entry) => total + entry.recordCount, 0),
    exemptedStores: coverage.filter((entry) => entry.exemptionReason).map((entry) => entry.store),
    complete: true,
  };
}

/**
 * Den rättsliga grund som gör att ett register får undantas från radering,
 * eller null när registret ska raderas. Används för att fylla i coverage så
 * att undantagen blir konsekventa i stället för att formuleras per ärende.
 */
export function erasureExemption(store: PersonalDataStore): string | null {
  return ERASURE_EXEMPT_STORES[store] ?? null;
}

/** True när begäran är försenad i förhållande till PUB-avtalets 30 dagar. */
export function isOverdue(response: DataSubjectResponse, now: Date = new Date()): boolean {
  return Date.parse(response.dueAt) < now.getTime();
}
