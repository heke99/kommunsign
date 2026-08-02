import { base64UrlEncode } from '../../crypto/src/base64.js';
import { sha256Bytes } from '../../crypto/src/hash.js';
import { randomToken } from '../../crypto/src/tokens.js';

export interface OidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

export async function createOidcTransaction(redirectUri: string, now = new Date(), validitySeconds = 600): Promise<OidcTransaction> {
  const parsed = new URL(redirectUri);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('OIDC_REDIRECT_URI_MUST_USE_HTTPS');
  }
  if (!Number.isInteger(validitySeconds) || validitySeconds < 60 || validitySeconds > 900) {
    throw new Error('OIDC_TRANSACTION_VALIDITY_INVALID');
  }
  const codeVerifier = randomToken(48);
  return {
    state: randomToken(32),
    nonce: randomToken(32),
    codeVerifier,
    codeChallenge: base64UrlEncode(await sha256Bytes(new TextEncoder().encode(codeVerifier))),
    redirectUri: parsed.toString(),
    expiresAt: new Date(now.getTime() + validitySeconds * 1000).toISOString(),
  };
}

export function verifyOidcCallback(
  transaction: OidcTransaction,
  input: { readonly state: string; readonly nonce: string; readonly redirectUri: string; readonly now?: Date },
): void {
  const now = input.now ?? new Date();
  if (now.getTime() >= Date.parse(transaction.expiresAt)) throw new Error('OIDC_TRANSACTION_EXPIRED');
  if (!constantTimeTextEqual(transaction.state, input.state)) throw new Error('OIDC_STATE_MISMATCH');
  if (!constantTimeTextEqual(transaction.nonce, input.nonce)) throw new Error('OIDC_NONCE_MISMATCH');
  if (transaction.redirectUri !== new URL(input.redirectUri).toString()) throw new Error('OIDC_REDIRECT_URI_MISMATCH');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
