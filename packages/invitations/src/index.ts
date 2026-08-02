import { sha256Hex } from '../../crypto/src/hash.js';
import { randomToken } from '../../crypto/src/tokens.js';

export interface InvitationTokenRecord {
  readonly tenantId: string;
  readonly signatureCaseId: string;
  readonly signerId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly usedAt?: string;
}

export async function createInvitationToken(input: {
  readonly tenantId: string;
  readonly signatureCaseId: string;
  readonly signerId: string;
  readonly expiresAt: string;
}): Promise<{ readonly token: string; readonly record: InvitationTokenRecord }> {
  if (Date.parse(input.expiresAt) <= Date.now()) throw new Error('INVITATION_EXPIRY_INVALID');
  const token = randomToken(32);
  return {
    token,
    record: { ...input, tokenHash: await sha256Hex(token) },
  };
}

export async function verifyInvitationToken(record: InvitationTokenRecord, token: string, now = new Date()): Promise<void> {
  if (record.revokedAt) throw new Error('INVITATION_REVOKED');
  if (record.usedAt) throw new Error('INVITATION_ALREADY_USED');
  if (now.getTime() >= Date.parse(record.expiresAt)) throw new Error('INVITATION_EXPIRED');
  const actual = await sha256Hex(token);
  if (!constantTimeHexEqual(record.tokenHash, actual)) throw new Error('INVITATION_TOKEN_INVALID');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
