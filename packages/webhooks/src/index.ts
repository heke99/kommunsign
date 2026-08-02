import { canonicalJson, type CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { hmacSha256Hex, verifyHmacSha256Hex } from '../../crypto/src/hmac.js';

export interface SignedWebhook {
  readonly body: string;
  readonly timestamp: string;
  readonly signature: string;
}
export async function signWebhook(payload: CanonicalJsonValue, secret: string, timestamp = String(Math.floor(Date.now()/1000))): Promise<SignedWebhook> {
  const body = canonicalJson(payload);
  const signature = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return { body, timestamp, signature: `sha256=${signature}` };
}
export async function verifyWebhook(
  signed: SignedWebhook,
  secret: string,
  nowEpochSeconds = Math.floor(Date.now()/1000),
  maximumAgeSeconds = 300,
): Promise<boolean> {
  const timestamp = Number(signed.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowEpochSeconds - timestamp) > maximumAgeSeconds) return false;
  return verifyHmacSha256Hex(secret, `${signed.timestamp}.${signed.body}`, signed.signature);
}
