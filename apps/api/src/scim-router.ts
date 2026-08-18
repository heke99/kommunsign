import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import {
  applyGroupMembership, applyScimPatch, createScimUser, deprovisionScimUser,
  matchesScimFilter, paginateScim, parseScimFilter, ScimError,
  toScimUserResource, SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA,
  type ScimContext, type ScimUser, type ScimUserWrite,
} from '../../../packages/scim/src/index.js';
import type { ApiDependencies } from './ports.js';

/**
 * The SCIM 2.0 surface.
 *
 * Handled before `resolveContext` in `createApiHandler`, alongside the auth and
 * onboarding routers, because SCIM authenticates with a provisioning client's
 * bearer token rather than a user session. That ordering is not cosmetic: a
 * directory pushing users has no session, and running it through the session
 * resolver would either fail or, worse, need a bypass that some later route
 * inherits.
 *
 * The tenant comes from the credential row. It is never read from the path, the
 * body, or a header (AGENTS.md rule 1) — a provisioning client that could name
 * its own tenant would be a cross-tenant write primitive handed out with every
 * credential.
 *
 * All SCIM errors are returned in the SCIM error schema, not this API's. A
 * provisioning client parses one shape, and giving it another turns a
 * meaningful 409 into an unclassifiable failure that stalls the sync.
 */

const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const MAX_SCIM_BODY_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleScimRequest(
  dependencies: ApiDependencies,
  request: Request,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/scim/v2/')) return null;

  // Every call below is awaited rather than returned as a bare promise.
  // Returning an unawaited promise from inside try/catch lets its rejection
  // escape the handler entirely — the SCIM error mapping below would silently
  // never run, and a client would get an unhandled 500 instead of the 400 that
  // tells it what to fix. The tests caught exactly that.
  try {
    if (!dependencies.scim) throw new ScimError('SCIM_NOT_FOUND', 'SCIM provisioning is not configured');
    const repository = dependencies.scim;

    const credential = await authenticate(repository, request);
    const context: ScimContext = {
      tenantId: credential.tenantId,
      clientId: credential.clientId,
      requestId,
      assignableRoles: credential.assignableRoles,
      groupToRole: credential.groupToRole,
    };

    // Advertised so a provisioning client can discover what is supported
    // rather than probe for it. Unauthenticated in the RFC, but there is
    // nothing tenant-specific in it, so requiring the token costs nothing.
    if (url.pathname === '/scim/v2/ServiceProviderConfig' && request.method === 'GET') {
      return scimJson(serviceProviderConfig(), 200, requestId);
    }

    if (url.pathname === '/scim/v2/Users') {
      if (request.method === 'GET') return await listUsers(repository, context, url, requestId);
      if (request.method === 'POST') return await createUser(repository, context, request, requestId);
      throw new ScimError('SCIM_INVALID_VALUE', `${request.method} is not supported on /Users`);
    }

    const userMatch = /^\/scim\/v2\/Users\/([^/]+)$/.exec(url.pathname);
    if (userMatch) {
      const userId = requireUuid(userMatch[1] ?? '');
      const user = await loadUser(repository, context, userId);
      switch (request.method) {
        case 'GET':
          return scimJson(toScimUserResource(user), 200, requestId);
        case 'PUT':
          return await replaceUser(repository, context, user, request, requestId);
        case 'PATCH':
          return await patchUser(repository, context, user, request, requestId);
        case 'DELETE':
          return await deleteUser(repository, context, user, requestId);
        default:
          throw new ScimError('SCIM_INVALID_VALUE', `${request.method} is not supported on a user`);
      }
    }

    if (url.pathname === '/scim/v2/Groups' && request.method === 'GET') {
      const groups = await repository.listGroups(context);
      const resources = groups.map((group) => ({
        schemas: [SCIM_GROUP_SCHEMA],
        id: group.displayName,
        displayName: group.displayName,
        meta: { resourceType: 'Group', location: `/scim/v2/Groups/${encodeURIComponent(group.displayName)}` },
      }));
      return scimJson(paginateScim(resources, numberParameter(url, 'startIndex'), numberParameter(url, 'count')), 200, requestId);
    }

    throw new ScimError('SCIM_NOT_FOUND', 'No such SCIM endpoint');
  } catch (error) {
    if (error instanceof ScimError) return scimError(error.status, error.code, error.message, requestId);
    if (error instanceof ScimAuthError) {
      // 401 with the challenge header, so a client with an expired token
      // retries with a new one instead of treating it as a permanent failure.
      return new Response(
        JSON.stringify({ schemas: [SCIM_ERROR_SCHEMA], status: '401', detail: 'Invalid provisioning credential' }),
        {
          status: 401,
          headers: {
            'content-type': 'application/scim+json; charset=utf-8',
            'www-authenticate': 'Bearer realm="scim"',
            'cache-control': 'no-store',
            'x-request-id': requestId,
          },
        },
      );
    }
    dependencies.reportError?.(error, requestId);
    return scimError(500, 'SCIM_INTERNAL', 'The provisioning request could not be completed', requestId);
  }
}

class ScimAuthError extends Error {}

/**
 * Resolves the bearer token to a client.
 *
 * The token is hashed and compared in the database rather than in code: the
 * hash is the stored column, so the lookup is a single indexed equality on a
 * value that reveals nothing if the row is ever read. A missing or malformed
 * header is the same failure as a wrong one, so probing tells an attacker
 * nothing about which tokens exist.
 */
async function authenticate(
  repository: NonNullable<ApiDependencies['scim']>,
  request: Request,
): Promise<{ readonly tenantId: string; readonly clientId: string; readonly assignableRoles: readonly string[]; readonly groupToRole: Readonly<Record<string, string>> }> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{32,512})$/.exec(header);
  if (!match?.[1]) throw new ScimAuthError('missing credential');
  const digest = await sha256Hex(new TextEncoder().encode(match[1]));
  const credential = await repository.authenticate(hexToBytes(digest));
  if (!credential) throw new ScimAuthError('unknown credential');
  return credential;
}

async function loadUser(
  repository: NonNullable<ApiDependencies['scim']>, context: ScimContext, userId: string,
): Promise<ScimUser> {
  const user = await repository.getUser(context, userId);
  if (!user) throw new ScimError('SCIM_NOT_FOUND', 'No such user');
  // The row was read inside the tenant transaction, so it is already scoped;
  // stamping the context tenant keeps the resource self-describing without
  // ever having taken a tenant from data.
  return { ...user, tenantId: context.tenantId };
}

async function listUsers(
  repository: NonNullable<ApiDependencies['scim']>, context: ScimContext, url: URL, requestId: string,
): Promise<Response> {
  const filter = parseScimFilter(url.searchParams.get('filter') ?? undefined);
  const users = (await repository.listUsers(context)).map((user) => ({ ...user, tenantId: context.tenantId }));
  const matching = users.filter((user) => matchesScimFilter(user, filter));
  const page = paginateScim(matching.map(toScimUserResource), numberParameter(url, 'startIndex'), numberParameter(url, 'count'));
  return scimJson({ ...page, schemas: [SCIM_LIST_SCHEMA] }, 200, requestId);
}

async function createUser(
  repository: NonNullable<ApiDependencies['scim']>, context: ScimContext, request: Request, requestId: string,
): Promise<Response> {
  const write = await readScimBody<ScimUserWrite>(request);
  const existing = (await repository.listUsers(context)).map((user) => ({ ...user, tenantId: context.tenantId }));
  const result = createScimUser(context, write, existing, crypto.randomUUID(), new Date().toISOString());

  // An IdP retries provisioning freely. Returning the existing user with 200
  // instead of a 409 is what keeps a re-sync from stalling.
  if (result.idempotentMatch) return scimJson(toScimUserResource(result.user), 200, requestId);

  const withRoles = applyGroupMembership(context, result.user, groupsFrom(write), result.user.updatedAt);
  const created = await repository.createUser(context, withRoles, requestId);
  return scimJson(toScimUserResource({ ...created, tenantId: context.tenantId }), 201, requestId, {
    location: `/scim/v2/Users/${created.id}`,
  });
}

async function replaceUser(
  repository: NonNullable<ApiDependencies['scim']>, context: ScimContext, user: ScimUser, request: Request, requestId: string,
): Promise<Response> {
  const write = await readScimBody<ScimUserWrite>(request);
  const now = new Date().toISOString();
  // Expressed as a patch so PUT and PATCH cannot drift on what is writable.
  const replaced = applyScimPatch(context, user, [{ op: 'replace', value: writeAsAttributes(write) }], now);
  const withRoles = applyGroupMembership(context, replaced, groupsFrom(write), now);
  const saved = await repository.saveUser(context, withRoles, actionFor(user, withRoles), requestId);
  return scimJson(toScimUserResource({ ...saved, tenantId: context.tenantId }), 200, requestId);
}

async function patchUser(
  repository: NonNullable<ApiDependencies['scim']>, context: ScimContext, user: ScimUser, request: Request, requestId: string,
): Promise<Response> {
  const body = await readScimBody<{ readonly Operations?: readonly { readonly op: string; readonly path?: string; readonly value?: unknown }[] }>(request);
  const operations = body.Operations ?? [];
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ScimError('SCIM_INVALID_VALUE', 'A PATCH must carry at least one operation');
  }
  const patched = applyScimPatch(context, user, operations, new Date().toISOString());
  const saved = await repository.saveUser(context, patched, actionFor(user, patched), requestId);
  return scimJson(toScimUserResource({ ...saved, tenantId: context.tenantId }), 200, requestId);
}

/**
 * DELETE deactivates rather than destroys when the user has history.
 *
 * A leaver's signatures, cases and audit entries must survive their departure,
 * or the trail develops holes exactly where a leaver is involved — which is
 * the one place anybody will look.
 */
async function deleteUser(
  repository: NonNullable<ApiDependencies['scim']>, context: ScimContext, user: ScimUser, requestId: string,
): Promise<Response> {
  const hasHistory = await repository.hasHistory(context, user.id);
  const outcome = deprovisionScimUser(context, user, hasHistory, new Date().toISOString());
  // Roles go regardless of which branch: a deprovisioned account must stop
  // granting anything immediately, whether or not the row stays.
  await repository.saveUser(context, { ...outcome.user, roles: [] }, outcome.action, requestId);
  return new Response(null, { status: 204, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } });
}

function actionFor(before: ScimUser, after: ScimUser): 'UPDATED' | 'ACTIVATED' | 'DEACTIVATED' | 'ROLES_CHANGED' {
  if (before.active && !after.active) return 'DEACTIVATED';
  if (!before.active && after.active) return 'ACTIVATED';
  if (before.roles.join(',') !== after.roles.join(',')) return 'ROLES_CHANGED';
  return 'UPDATED';
}

/** Group values as the directory sends them: verbatim, never case-folded. */
function groupsFrom(write: ScimUserWrite & { readonly groups?: readonly { readonly value?: string; readonly display?: string }[] }): readonly string[] {
  const groups = write.groups ?? [];
  return groups
    .map((group) => group.display ?? group.value)
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

function writeAsAttributes(write: ScimUserWrite): Readonly<Record<string, unknown>> {
  const attributes: Record<string, unknown> = {};
  if (write.userName !== undefined) attributes.userName = write.userName;
  if (write.displayName !== undefined) attributes.displayName = write.displayName;
  if (write.externalId !== undefined) attributes.externalId = write.externalId;
  if (write.emails !== undefined) attributes.emails = write.emails;
  if (write.active !== undefined) attributes.active = write.active;
  if (Object.keys(attributes).length === 0) throw new ScimError('SCIM_INVALID_VALUE', 'No writable attribute was supplied');
  return attributes;
}

function serviceProviderConfig(): Readonly<Record<string, unknown>> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Tenant-scoped provisioning credential issued by Kommunsign',
      primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: '/scim/v2/ServiceProviderConfig' },
  };
}

async function readScimBody<T>(request: Request): Promise<T> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_SCIM_BODY_BYTES) {
    throw new ScimError('SCIM_INVALID_VALUE', 'Payload is too large');
  }
  const text = await request.text();
  if (text.length > MAX_SCIM_BODY_BYTES) throw new ScimError('SCIM_INVALID_VALUE', 'Payload is too large');
  if (!text.trim()) throw new ScimError('SCIM_INVALID_VALUE', 'A body is required');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ScimError('SCIM_INVALID_VALUE', 'Body is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScimError('SCIM_INVALID_VALUE', 'Body must be a JSON object');
  }
  return parsed as T;
}

function numberParameter(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ScimError('SCIM_INVALID_PAGINATION', `${name} must be a number`);
  return value;
}

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new ScimError('SCIM_NOT_FOUND', 'No such user');
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function scimJson(body: unknown, status: number, requestId: string, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/scim+json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
      ...headers,
    },
  });
}

function scimError(status: number, code: string, detail: string, requestId: string): Response {
  return scimJson({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), scimType: scimTypeFor(code), detail }, status, requestId);
}

/** Maps our codes onto the `scimType` values RFC 7644 §3.12 defines. */
function scimTypeFor(code: string): string | undefined {
  switch (code) {
    case 'SCIM_UNIQUENESS': return 'uniqueness';
    case 'SCIM_INVALID_FILTER': return 'invalidFilter';
    case 'SCIM_INVALID_PATH': return 'invalidPath';
    case 'SCIM_INVALID_VALUE': return 'invalidValue';
    case 'SCIM_MUTABILITY': return 'mutability';
    default: return undefined;
  }
}
