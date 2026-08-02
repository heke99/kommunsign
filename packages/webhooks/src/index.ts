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

export function assertSafeWebhookUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('WEBHOOK_URL_MUST_USE_HTTPS');
  if (parsed.username || parsed.password) throw new Error('WEBHOOK_URL_CREDENTIALS_FORBIDDEN');
  if (parsed.port && parsed.port !== '443') throw new Error('WEBHOOK_URL_PORT_FORBIDDEN');
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('WEBHOOK_URL_PRIVATE_HOST_FORBIDDEN');
  }
  if (isForbiddenIpLiteral(hostname)) throw new Error('WEBHOOK_URL_PRIVATE_IP_FORBIDDEN');
  parsed.hostname = hostname;
  parsed.hash = '';
  if (parsed.href.length > 2048) throw new Error('WEBHOOK_URL_TOO_LONG');
  return parsed;
}

export function assertResolvedWebhookAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) throw new Error('WEBHOOK_DNS_RESOLUTION_EMPTY');
  for (const address of addresses) {
    if (isForbiddenIpLiteral(address.toLowerCase())) throw new Error('WEBHOOK_DNS_RESOLVED_PRIVATE_IP');
  }
}

function isForbiddenIpLiteral(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (value.includes(':')) {
    const normalized = value.replace(/^\[|\]$/g, '');
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
      || normalized.startsWith('ff');
  }
  return false;
}

function parseIpv4(value: string): readonly [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
}
