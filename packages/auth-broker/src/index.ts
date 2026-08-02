import { hmacSha256Hex, verifyHmacSha256Hex } from '../../crypto/src/hmac.js';
import { randomToken } from '../../crypto/src/tokens.js';
import { canonicalHostname } from '../../custom-domains/src/index.js';

export type SessionBoundary = 'tenant' | 'platform' | 'applicant' | 'signer';
export const SESSION_COOKIE_NAMES: Readonly<Record<SessionBoundary, string>> = {
  tenant: '__Host-ks_tenant_session',
  platform: '__Host-ks_platform_session',
  applicant: '__Host-ks_applicant_session',
  signer: '__Host-ks_signer_session',
};

export interface AuthorizationCodeRecord {
  readonly codeHash: string;
  readonly tenantId: string;
  readonly destinationHostname: string;
  readonly subjectId: string;
  readonly authMethod: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly usedAt?: string;
  readonly revokedAt?: string;
}

export interface AuthorizationCodeStore {
  create(record: AuthorizationCodeRecord): Promise<void>;
  consume(codeHash: string, now: Date): Promise<AuthorizationCodeRecord | null>;
}

export async function issueAuthorizationCode(input: {
  readonly store: AuthorizationCodeStore;
  readonly signingKey: string;
  readonly tenantId: string;
  readonly destinationHostname: string;
  readonly subjectId: string;
  readonly authMethod: string;
  readonly now?: Date;
  readonly validitySeconds?: number;
}): Promise<{ readonly code: string; readonly expiresAt: string }> {
  const now = input.now ?? new Date();
  const validitySeconds = input.validitySeconds ?? 60;
  if (validitySeconds < 15 || validitySeconds > 120) throw new Error('AUTH_CODE_VALIDITY_INVALID');
  const destinationHostname = canonicalHostname(input.destinationHostname, { allowPlatformNamespace: true });
  const random = randomToken(32);
  const signature = await hmacSha256Hex(input.signingKey, `${input.tenantId}:${destinationHostname}:${input.subjectId}:${random}`);
  const code = `${random}.${signature}`;
  const codeHash = await hmacSha256Hex(input.signingKey, code);
  const expiresAt = new Date(now.getTime() + validitySeconds * 1000).toISOString();
  await input.store.create({ codeHash, tenantId: input.tenantId, destinationHostname, subjectId: input.subjectId, authMethod: input.authMethod, createdAt: now.toISOString(), expiresAt });
  return { code, expiresAt };
}

export async function exchangeAuthorizationCode(input: {
  readonly store: AuthorizationCodeStore;
  readonly signingKey: string;
  readonly code: string;
  readonly destinationHostname: string;
  readonly now?: Date;
}): Promise<AuthorizationCodeRecord> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(input.code)) throw new Error('AUTH_CODE_INVALID');
  const codeHash = await hmacSha256Hex(input.signingKey, input.code);
  const record = await input.store.consume(codeHash, now);
  if (!record) throw new Error('AUTH_CODE_INVALID_OR_USED');
  if (record.revokedAt || record.usedAt) throw new Error('AUTH_CODE_INVALID_OR_USED');
  if (now.getTime() >= Date.parse(record.expiresAt)) throw new Error('AUTH_CODE_EXPIRED');
  const destination = canonicalHostname(input.destinationHostname, { allowPlatformNamespace: true });
  if (record.destinationHostname !== destination) throw new Error('AUTH_CODE_DESTINATION_MISMATCH');
  const [random, signature] = input.code.split('.');
  if (!random || !signature || !(await verifyHmacSha256Hex(input.signingKey, `${record.tenantId}:${record.destinationHostname}:${record.subjectId}:${random}`, signature))) {
    throw new Error('AUTH_CODE_SIGNATURE_INVALID');
  }
  return record;
}

export function buildHostOnlySessionCookie(boundary: SessionBoundary, token: string, options: { readonly secure: boolean; readonly maxAgeSeconds: number }): string {
  if (!/^[A-Za-z0-9._~-]{32,4096}$/.test(token)) throw new Error('SESSION_TOKEN_INVALID');
  if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 60 || options.maxAgeSeconds > 86_400) throw new Error('SESSION_MAX_AGE_INVALID');
  return `${SESSION_COOKIE_NAMES[boundary]}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAgeSeconds}${options.secure ? '; Secure' : ''}`;
}

export function assertAllowedReturnUrl(returnUrl: string, allowedHostnames: ReadonlySet<string>): URL {
  const parsed = new URL(returnUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error('AUTH_RETURN_URL_INVALID');
  const hostname = canonicalHostname(parsed.hostname, { allowPlatformNamespace: true });
  if (!allowedHostnames.has(hostname)) throw new Error('AUTH_RETURN_URL_NOT_ALLOWED');
  return parsed;
}
