import type { CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { canonicalJson } from '../../crypto/src/canonical-json.js';
import { sha256Hex } from '../../crypto/src/hash.js';

export interface AuditEventInput {
  readonly previousEventHash: string;
  readonly payload: CanonicalJsonValue;
  readonly occurredAt: string;
  readonly eventType: string;
}

export async function calculateAuditEventHash(input: AuditEventInput): Promise<string> {
  return sha256Hex(`${input.previousEventHash}${canonicalJson(input.payload)}${input.occurredAt}${input.eventType}`);
}

export async function verifyAuditChain(
  events: readonly { readonly hash: string; readonly payload: CanonicalJsonValue; readonly occurredAt: string; readonly eventType: string }[],
  initialHash = '0'.repeat(64),
): Promise<boolean> {
  let previous = initialHash;
  for (const event of events) {
    const expected = await calculateAuditEventHash({ previousEventHash: previous, payload: event.payload, occurredAt: event.occurredAt, eventType: event.eventType });
    if (expected !== event.hash) return false;
    previous = event.hash;
  }
  return true;
}
