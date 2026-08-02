import type { CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { canonicalJson } from '../../crypto/src/canonical-json.js';
import { sha256Hex } from '../../crypto/src/hash.js';

export interface AuditEventInput {
  readonly previousEventHash: string;
  readonly tenantId: string;
  readonly sequence: number;
  readonly category: 'TECHNICAL' | 'BUSINESS';
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly payload: CanonicalJsonValue;
  readonly occurredAt: string;
}

export function createAuditHashMaterial(input: AuditEventInput): string {
  return canonicalJson({
    hashVersion: 2,
    previousEventHash: input.previousEventHash,
    tenantId: input.tenantId,
    sequence: input.sequence,
    category: input.category,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
}

export async function calculateAuditEventHash(input: AuditEventInput): Promise<string> {
  return sha256Hex(createAuditHashMaterial(input));
}

export type AuditEventRecord = Omit<AuditEventInput, 'previousEventHash'> & {
  readonly hash: string;
  readonly hashMaterial: string;
};

function materialMatchesEvent(material: unknown, event: AuditEventRecord, previousEventHash: string): boolean {
  if (!material || typeof material !== 'object' || Array.isArray(material)) return false;
  const value = material as Record<string, unknown>;
  return value.hashVersion === 2
    && value.previousEventHash === previousEventHash
    && value.tenantId === event.tenantId
    && value.sequence === event.sequence
    && value.category === event.category
    && value.eventType === event.eventType
    && value.actorType === event.actorType
    && value.actorId === event.actorId
    && value.resourceType === event.resourceType
    && value.resourceId === event.resourceId
    && value.occurredAt === event.occurredAt
    && canonicalJson(value.payload as CanonicalJsonValue) === canonicalJson(event.payload);
}

export async function verifyAuditChain(
  events: readonly AuditEventRecord[],
  initialHash = '0'.repeat(64),
): Promise<boolean> {
  let previous = initialHash;
  for (const event of events) {
    let material: unknown;
    try {
      material = JSON.parse(event.hashMaterial);
    } catch {
      return false;
    }
    if (!materialMatchesEvent(material, event, previous)) return false;
    if (await sha256Hex(event.hashMaterial) !== event.hash) return false;
    previous = event.hash;
  }
  return true;
}
