import type { PlatformPermission } from '../../../packages/authorization/src/index.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import type { ApiDependencies, AuthRequestMetadata, CompletePasswordInput, LoginInput, OrganizationUserInput, OrganizationUserStatusInput, PasswordRecoveryInput } from './ports.js';
import { clearSessionCookie, sessionCookie, sessionTokenFromRequest } from './production-adapters/postgres/authentication-repository.js';

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

const MAX_BODY_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+\/-]{16,200}$/;

class AuthRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message = code.replace(/_/g, ' ')) { super(message); }
}

function response(body: unknown, status: number, requestId: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}
function fail(error: AuthRequestError, requestId: string): Response {
  return response({ error: { code: error.code, message: error.message, requestId } }, error.status, requestId);
}
function requireRepository(dependencies: ApiDependencies) {
  if (!dependencies.authentication) throw new AuthRequestError('AUTH_NOT_CONFIGURED', 503);
  return dependencies.authentication;
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new AuthRequestError('UNSUPPORTED_MEDIA_TYPE', 415, 'Content-Type must be application/json');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new AuthRequestError('INVALID_JSON', 400, 'JSON payload is required');
  if (bytes.length > MAX_BODY_BYTES) throw new AuthRequestError('PAYLOAD_TOO_LARGE', 413);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new AuthRequestError('INVALID_JSON', 400, 'JSON payload is malformed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthRequestError('VALIDATION_ERROR', 422);
  return parsed as Record<string, unknown>;
}
function allowed(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new AuthRequestError('VALIDATION_ERROR', 422);
}
function text(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new AuthRequestError('VALIDATION_ERROR', 422, `${field} must be a string`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) throw new AuthRequestError('VALIDATION_ERROR', 422, `${field} has an invalid length`);
  return result;
}
function optionalText(value: unknown, field: string, minimum: number, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, field, minimum, maximum);
}
function loginInput(body: Record<string, unknown>): LoginInput {
  allowed(body, ['email','password']);
  return {
    email: text(body.email, 'email', 3, 254),
    password: text(body.password, 'password', 1, 128),
  };
}
function recoveryInput(body: Record<string, unknown>): PasswordRecoveryInput {
  allowed(body, ['email']);
  return { email: text(body.email, 'email', 3, 254) };
}
function completeInput(body: Record<string, unknown>): CompletePasswordInput {
  allowed(body, ['accessToken','tokenHash','type','password']);
  const accessToken = optionalText(body.accessToken, 'accessToken', 32, 8192);
  const tokenHash = optionalText(body.tokenHash, 'tokenHash', 32, 1024);
  if ((!accessToken && !tokenHash) || (accessToken && tokenHash)) throw new AuthRequestError('AUTH_EMAIL_LINK_INVALID', 401, 'Aktiveringslänken är ogiltig eller har gått ut.');
  const type = body.type === undefined ? undefined : text(body.type, 'type', 6, 8);
  if (tokenHash && type !== 'invite' && type !== 'recovery') throw new AuthRequestError('AUTH_EMAIL_LINK_INVALID', 401, 'Aktiveringslänken är ogiltig eller har gått ut.');
  if (accessToken && type !== undefined) throw new AuthRequestError('AUTH_EMAIL_LINK_INVALID', 401, 'Aktiveringslänken är ogiltig eller har gått ut.');
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(tokenHash ? { tokenHash, type: type as 'invite' | 'recovery' } : {}),
    password: text(body.password, 'password', 12, 128),
  };
}
function organizationUserInput(body: Record<string, unknown>): OrganizationUserInput {
  allowed(body, ['displayName','email','roleKey']);
  const role = text(body.roleKey, 'roleKey', 3, 80);
  const roles: readonly OrganizationUserInput['roleKey'][] = ['tenant_admin','tenant_security_admin','tenant_integration_admin','tenant_archive_admin','department_admin','document_creator','document_sender','approver','auditor','readonly'];
  if (!roles.includes(role as OrganizationUserInput['roleKey'])) throw new AuthRequestError('VALIDATION_ERROR', 422, 'roleKey is invalid');
  return { displayName: text(body.displayName, 'displayName', 2, 200), email: text(body.email, 'email', 3, 254), roleKey: role as OrganizationUserInput['roleKey'] };
}
function organizationUserStatusInput(body: Record<string, unknown>): OrganizationUserStatusInput {
  allowed(body, ['action']);
  const action = text(body.action, 'action', 6, 7);
  if (action !== 'disable' && action !== 'enable') throw new AuthRequestError('VALIDATION_ERROR', 422, 'action is invalid');
  return { action };
}
function sessionMaxAge(): number {
  const parsed = Number(process.env.SESSION_COOKIE_MAX_AGE_SECONDS ?? '28800');
  if (!Number.isInteger(parsed) || parsed < 900 || parsed > 86400) throw new AuthRequestError('AUTH_SESSION_CONFIGURATION_INVALID', 503);
  return parsed;
}
function originHostname(request: Request): string {
  const origin = request.headers.get('origin');
  if (!origin) throw new AuthRequestError('AUTH_ORIGIN_REQUIRED', 400);
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error('invalid');
    return parsed.hostname.toLowerCase();
  } catch { throw new AuthRequestError('AUTH_ORIGIN_INVALID', 400); }
}
function requestMetadata(request: Request): AuthRequestMetadata {
  const forwarded = request.headers.get('x-kommunsign-end-user-ip')?.trim();
  const development = process.env.APP_ENV !== 'production';
  const ipAddress = forwarded || (development ? '127.0.0.1' : '');
  if (!ipAddress) throw new AuthRequestError('AUTH_CLIENT_IP_REQUIRED', 400);
  const userAgent = (request.headers.get('user-agent') || 'unknown').slice(0, 500);
  return { ipAddress, userAgent };
}
function csrfToken(request: Request): string {
  const value = request.headers.get('x-csrf-token')?.trim();
  if (!value) throw new AuthRequestError('CSRF_TOKEN_REQUIRED', 403);
  return value;
}
function idempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key');
  if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) throw new AuthRequestError(value ? 'IDEMPOTENCY_KEY_INVALID' : 'IDEMPOTENCY_KEY_REQUIRED', 400);
  return value;
}
function organizationId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new AuthRequestError('VALIDATION_ERROR', 422, 'organizationId must be a UUID');
  return value;
}
async function platformContext(dependencies: ApiDependencies, request: Request, permission: PlatformPermission) {
  if (!dependencies.resolvePlatformContext || !dependencies.authorizePlatform) throw new AuthRequestError('PLATFORM_AUTH_NOT_CONFIGURED', 503);
  try {
    const context = await dependencies.resolvePlatformContext(request);
    await dependencies.authorizePlatform(context, permission);
    return context;
  } catch (cause) {
    if (cause instanceof Error && ['CSRF_TOKEN_REQUIRED','AUTH_SESSION_INVALID'].includes(cause.message)) throw new AuthRequestError(cause.message, 401);
    throw new AuthRequestError('FORBIDDEN', 403);
  }
}
function safeKnown(cause: unknown): AuthRequestError {
  if (cause instanceof AuthRequestError) return cause;
  if (!(cause instanceof Error)) return new AuthRequestError('INTERNAL_ERROR', 500);
  const mapping: Readonly<Record<string, readonly [number,string]>> = {
    AUTH_INVALID_CREDENTIALS: [401,'E-post eller lösenord är felaktigt.'],
    AUTH_ACCOUNT_NOT_AUTHORIZED: [403,'Kontot saknar åtkomst till den valda organisationen.'],
    AUTH_SESSION_INVALID: [401,'Sessionen är ogiltig eller har gått ut.'],
    AUTH_EMAIL_LINK_INVALID: [401,'Aktiverings- eller återställningslänken är ogiltig eller har gått ut.'],
    AUTH_ORIGIN_REQUIRED: [400,'Säker origin saknas.'],
    AUTH_ORIGIN_INVALID: [400,'Säker origin är ogiltig.'],
    CSRF_TOKEN_REQUIRED: [403,'Säkerhetskontrollen för begäran saknas.'],
    CSRF_TOKEN_INVALID: [403,'Säkerhetskontrollen för begäran är ogiltig.'],
    AUTH_CLIENT_IP_REQUIRED: [400,'Klientadressen kunde inte verifieras.'],
    AUTH_CLIENT_IP_INVALID: [400,'Klientadressen är ogiltig.'],
    PASSWORD_POLICY_FAILED: [422,'Lösenordet uppfyller inte säkerhetskraven.'],
    EMAIL_INVALID: [422,'E-postadressen är ogiltig.'],
    AUTH_RATE_LIMITED: [429,'För många försök. Försök igen senare.'],
    AUTH_PROVIDER_TIMEOUT: [503,'Inloggningstjänsten svarade inte i tid.'],
    AUTH_PROVIDER_UNAVAILABLE: [503,'Inloggningstjänsten är tillfälligt otillgänglig.'],
    ORGANIZATION_PRIMARY_DOMAIN_NOT_ACTIVE: [409,'Organisationens inloggningsadress är inte aktiverad.'],
    ORGANIZATION_ROLE_NOT_PROVISIONED: [409,'Den valda rollen är inte tillgänglig för organisationen.'],
    ORGANIZATION_ACCOUNT_NOT_FOUND: [404,'Kontot kunde inte hittas.'],
    ORGANIZATION_ACCOUNT_NOT_ACTIVATED: [409,'Kontot måste aktiveras via e-post innan det kan återaktiveras.'],
    ORGANIZATION_USER_NOT_FOUND: [404,'Användaren kunde inte hittas i organisationen.'],
  };
  const found = mapping[cause.message];
  return found ? new AuthRequestError(cause.message, found[0], found[1]) : new AuthRequestError('INTERNAL_ERROR', 500, 'Begäran kunde inte slutföras.');
}

export async function handleAuthRequest(dependencies: ApiDependencies, request: Request, requestId: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/auth') && !url.pathname.startsWith('/v1/platform/organizations/')) return null;
  try {
    const repository = requireRepository(dependencies);
    if (request.method === 'POST' && url.pathname === '/v1/auth/login') {
      const result = await repository.login(loginInput(await readJson(request)), requestMetadata(request));
      const { sessionToken, ...view } = result;
      return response(view, 200, requestId, { 'set-cookie': sessionCookie(sessionToken, sessionMaxAge()) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/password/forgot') {
      await repository.forgotPassword(recoveryInput(await readJson(request)), requestMetadata(request));
      return response({ accepted: true, message: 'Om adressen har ett konto skickas ett återställningsmeddelande.' }, 202, requestId);
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/password/complete') {
      const result = await repository.completePassword(completeInput(await readJson(request)), requestMetadata(request));
      const { sessionToken, ...view } = result;
      return response(view, 200, requestId, { 'set-cookie': sessionCookie(sessionToken, sessionMaxAge()) });
    }
    if (request.method === 'GET' && url.pathname === '/v1/auth/session') {
      const token = sessionTokenFromRequest(request);
      if (!token) throw new AuthRequestError('AUTH_SESSION_INVALID', 401);
      return response(await repository.session(token, originHostname(request)), 200, requestId);
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
      const token = sessionTokenFromRequest(request);
      if (token) {
        await repository.logout(token, originHostname(request), csrfToken(request));
      }
      return response({ loggedOut: true }, 200, requestId, { 'set-cookie': clearSessionCookie() });
    }
    const userStatus = url.pathname.match(/^\/v1\/platform\/organizations\/([^/]+)\/users\/([^/]+)$/);
    if (userStatus?.[1] && userStatus[2] && request.method === 'PATCH') {
      const context = await platformContext(dependencies, request, 'organization:user_manage');
      idempotencyKey(request);
      return response(await repository.setOrganizationUserStatus(
        context,
        organizationId(userStatus[1]),
        organizationId(userStatus[2]),
        organizationUserStatusInput(await readJson(request)),
      ), 200, requestId);
    }
    const users = url.pathname.match(/^\/v1\/platform\/organizations\/([^/]+)\/users$/);
    if (users?.[1] && request.method === 'GET') {
      const context = await platformContext(dependencies, request, 'organization:user_manage');
      return response(await repository.listOrganizationUsers(context, organizationId(users[1])), 200, requestId);
    }
    if (users?.[1] && request.method === 'POST') {
      const context = await platformContext(dependencies, request, 'organization:user_manage');
      const input = organizationUserInput(await readJson(request));
      const key = idempotencyKey(request);
      const payloadHash = await sha256Hex(canonicalJson(input as unknown as CanonicalJsonValue));
      return response(await repository.inviteOrganizationUser(context, organizationId(users[1]), input, key, payloadHash), 201, requestId);
    }
    return response({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId } }, 404, requestId);
  } catch (cause) {
    const mapped = safeKnown(cause);
    if (mapped.status === 500) dependencies.reportError?.(cause, requestId);
    return fail(mapped, requestId);
  }
}
