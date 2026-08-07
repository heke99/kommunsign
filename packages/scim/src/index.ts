/**
 * SCIM 2.0 provisioning (RFC 7643 schema, RFC 7644 protocol).
 *
 * Kungälv requirements 2082-2085: the system must support automatic user
 * provisioning covering account creation, account update, permission change
 * and deactivation; provisioning must be driven from the municipality's
 * central identity source; and roles must be assignable automatically during
 * provisioning.
 *
 * This is the decision layer. Persistence lives in the repositories; what is
 * here is the part that decides what a SCIM request *means*, which is where
 * provisioning integrations reliably go wrong:
 *
 *   1. A SCIM token belongs to exactly one tenant. Every resource it touches
 *      must already be in that tenant. Without this check, an IdP
 *      misconfiguration silently writes users into a neighbouring
 *      municipality.
 *   2. Deactivation is not deletion. Entra and most IdPs deprovision by
 *      PATCHing `active: false`. Treating that as a delete destroys the audit
 *      trail that ties a person to signatures they made.
 *   3. SCIM pagination is 1-based. Treating `startIndex` as 0-based silently
 *      skips or duplicates a user on every page boundary, which shows up as
 *      "some staff never got provisioned" months later.
 *   4. Roles come from group membership through an explicit mapping. An
 *      unmapped group must grant nothing.
 */

import type { IsoDateTime, UUID } from '../../contracts/src/index.js';

export type ScimErrorCode =
  | 'SCIM_TENANT_MISMATCH'
  | 'SCIM_INVALID_VALUE'
  | 'SCIM_INVALID_FILTER'
  | 'SCIM_INVALID_PATH'
  | 'SCIM_UNIQUENESS'
  | 'SCIM_NOT_FOUND'
  | 'SCIM_MUTABILITY'
  | 'SCIM_INVALID_PAGINATION'
  | 'SCIM_ROLE_NOT_ASSIGNABLE';

/** SCIM defines the HTTP status per error type; kept together so they agree. */
const SCIM_STATUS: Readonly<Record<ScimErrorCode, number>> = {
  SCIM_TENANT_MISMATCH: 404, // Deliberately 404, not 403: a cross-tenant probe
  SCIM_INVALID_VALUE: 400,   // must not reveal that the resource exists.
  SCIM_INVALID_FILTER: 400,
  SCIM_INVALID_PATH: 400,
  SCIM_UNIQUENESS: 409,
  SCIM_NOT_FOUND: 404,
  SCIM_MUTABILITY: 400,
  SCIM_INVALID_PAGINATION: 400,
  SCIM_ROLE_NOT_ASSIGNABLE: 400,
};

export class ScimError extends Error {
  readonly status: number;
  constructor(readonly code: ScimErrorCode, message: string) {
    super(message);
    this.name = 'ScimError';
    this.status = SCIM_STATUS[code];
  }
}

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

export interface ScimUser {
  readonly id: UUID;
  readonly tenantId: UUID;
  /** Stable identifier in the customer's directory. The idempotency key. */
  readonly externalId: string | null;
  readonly userName: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface ScimGroup {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly externalId: string | null;
  readonly displayName: string;
  readonly memberUserIds: readonly UUID[];
}

/** The credential's tenant. Never taken from the payload (AGENTS.md rule 1). */
export interface ScimContext {
  readonly tenantId: UUID;
  readonly clientId: UUID;
  readonly requestId: string;
  /** Roles this client may assign. Least privilege for the SCIM token. */
  readonly assignableRoles: readonly string[];
  /** Directory group value -> Kommunsign role. Unlisted grants nothing. */
  readonly groupToRole: Readonly<Record<string, string>>;
}

/**
 * The single place a tenant is checked. Every read and write path calls this,
 * so a new endpoint cannot forget it and quietly become cross-tenant.
 */
export function assertScimTenant(context: ScimContext, resource: { readonly tenantId: UUID }): void {
  if (resource.tenantId !== context.tenantId) {
    // 404, not 403: telling a caller "exists but forbidden" confirms the
    // resource is real and turns ID enumeration into a directory listing.
    throw new ScimError('SCIM_TENANT_MISMATCH', 'Resource does not exist');
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export interface ScimUserWrite {
  readonly schemas?: readonly string[];
  readonly externalId?: string;
  readonly userName?: string;
  readonly displayName?: string;
  readonly emails?: readonly { readonly value?: string; readonly primary?: boolean }[];
  readonly active?: boolean;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScimError('SCIM_INVALID_VALUE', `${field} is required`);
  }
  return value.trim();
}

function primaryEmail(write: ScimUserWrite): string | null {
  const emails = write.emails ?? [];
  const chosen = emails.find((entry) => entry.primary) ?? emails[0];
  const value = chosen?.value;
  return typeof value === 'string' && value.includes('@') ? value.trim().toLowerCase() : null;
}

export interface ScimCreateResult {
  readonly user: ScimUser;
  /** True when an existing user was returned instead of a new one. */
  readonly idempotentMatch: boolean;
}

/**
 * Creating a user is idempotent on `externalId`.
 *
 * IdPs retry provisioning freely — on transient errors, on re-sync, on a
 * changed attribute. Without idempotency each retry either creates a duplicate
 * account or returns 409 and stalls the sync. Matching on externalId is what
 * makes a retry a no-op.
 *
 * `userName` uniqueness is still enforced, because two different directory
 * entries claiming the same login is a real conflict rather than a retry.
 */
export function createScimUser(
  context: ScimContext,
  write: ScimUserWrite,
  existing: readonly ScimUser[],
  id: UUID,
  now: IsoDateTime,
): ScimCreateResult {
  const userName = requireNonEmpty(write.userName, 'userName');
  const externalId = write.externalId === undefined ? null : requireNonEmpty(write.externalId, 'externalId');

  const scoped = existing.filter((user) => user.tenantId === context.tenantId);
  if (externalId !== null) {
    const match = scoped.find((user) => user.externalId === externalId);
    if (match) return { user: match, idempotentMatch: true };
  }
  if (scoped.some((user) => user.userName.toLowerCase() === userName.toLowerCase())) {
    throw new ScimError('SCIM_UNIQUENESS', 'userName is already in use');
  }

  return {
    user: {
      id,
      tenantId: context.tenantId,
      externalId,
      userName,
      displayName: typeof write.displayName === 'string' ? write.displayName.trim() : null,
      email: primaryEmail(write),
      // SCIM's default is active. An account created without the attribute is
      // usable, which matches what every IdP expects.
      active: write.active ?? true,
      roles: [],
      groups: [],
      createdAt: now,
      updatedAt: now,
    },
    idempotentMatch: false,
  };
}

export interface ScimPatchOperation {
  readonly op: string;
  readonly path?: string;
  readonly value?: unknown;
}

/** Attributes the directory owns. Anything else is refused, not ignored. */
const PATCHABLE_PATHS = new Set(['active', 'displayname', 'username', 'externalid', 'emails']);

/**
 * Applies a SCIM PATCH.
 *
 * Deactivation arrives here, as `replace active=false`. It sets the flag and
 * keeps the row: the user's history — which documents they signed, which cases
 * they handled — must survive deprovisioning, or the audit trail develops
 * holes exactly where a leaver is involved.
 */
export function applyScimPatch(
  context: ScimContext,
  user: ScimUser,
  operations: readonly ScimPatchOperation[],
  now: IsoDateTime,
): ScimUser {
  assertScimTenant(context, user);
  let next = user;

  for (const operation of operations) {
    const op = operation.op?.toLowerCase();
    if (op !== 'replace' && op !== 'add' && op !== 'remove') {
      throw new ScimError('SCIM_INVALID_VALUE', `Unsupported patch operation ${operation.op}`);
    }
    // A pathless replace carries an object of attributes; Entra uses both forms.
    if (operation.path === undefined) {
      if (op === 'remove') throw new ScimError('SCIM_INVALID_PATH', 'remove requires a path');
      if (!operation.value || typeof operation.value !== 'object') {
        throw new ScimError('SCIM_INVALID_VALUE', 'Patch without a path requires an object value');
      }
      for (const [key, value] of Object.entries(operation.value as Record<string, unknown>)) {
        next = applySingleAttribute(next, key, value);
      }
      continue;
    }
    const path = operation.path.toLowerCase();
    if (!PATCHABLE_PATHS.has(path)) {
      // Refused rather than ignored: silently dropping an attribute the
      // directory believes it set leaves the two sides disagreeing forever.
      throw new ScimError('SCIM_INVALID_PATH', `Attribute ${operation.path} is not writable over SCIM`);
    }
    next = applySingleAttribute(next, path, op === 'remove' ? null : operation.value);
  }

  return { ...next, updatedAt: now };
}

function applySingleAttribute(user: ScimUser, path: string, value: unknown): ScimUser {
  switch (path.toLowerCase()) {
    case 'active': {
      // Entra sends booleans, some directories send the strings "True"/"False".
      const active = typeof value === 'boolean' ? value
        : typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase()) ? value.toLowerCase() === 'true'
        : null;
      if (active === null) throw new ScimError('SCIM_INVALID_VALUE', 'active must be a boolean');
      return { ...user, active };
    }
    case 'displayname':
      return { ...user, displayName: value === null ? null : requireNonEmpty(value, 'displayName') };
    case 'username':
      return { ...user, userName: requireNonEmpty(value, 'userName') };
    case 'externalid':
      return { ...user, externalId: value === null ? null : requireNonEmpty(value, 'externalId') };
    case 'emails':
      return { ...user, email: primaryEmail({ emails: Array.isArray(value) ? value : [] }) };
    default:
      throw new ScimError('SCIM_INVALID_PATH', `Attribute ${path} is not writable over SCIM`);
  }
}

/**
 * Deprovisioning. A hard DELETE is accepted only when the user has no history
 * worth preserving; otherwise it degrades to deactivation.
 *
 * This is not leniency. Removing the row would orphan audit events and
 * signatures that name this user, and an audit trail with holes around leavers
 * is worse than useless — it is exactly the period an investigation cares
 * about.
 */
export function deprovisionScimUser(
  context: ScimContext,
  user: ScimUser,
  hasHistory: boolean,
  now: IsoDateTime,
): { readonly user: ScimUser; readonly action: 'DEACTIVATED' | 'DELETED' } {
  assertScimTenant(context, user);
  if (hasHistory) {
    return { user: { ...user, active: false, updatedAt: now }, action: 'DEACTIVATED' };
  }
  return { user: { ...user, active: false, updatedAt: now }, action: 'DELETED' };
}

/* ------------------------------------------------------------------ *
 * Group and role mapping
 * ------------------------------------------------------------------ */

/**
 * Derives roles from group membership. Requirement 2085.
 *
 * Deny-by-default: an unmapped group grants nothing, and a mapping pointing at
 * a role the SCIM client may not assign is an error rather than a silent
 * grant. A directory admin adding someone to a group must never be able to
 * escalate beyond what the client was scoped for.
 */
export function resolveScimRoles(context: ScimContext, groups: readonly string[]): readonly string[] {
  const roles: string[] = [];
  for (const group of groups) {
    const role = context.groupToRole[group];
    if (role === undefined) continue;
    if (!context.assignableRoles.includes(role)) {
      throw new ScimError(
        'SCIM_ROLE_NOT_ASSIGNABLE',
        `Group ${group} maps to role ${role}, which this provisioning client may not assign`,
      );
    }
    if (!roles.includes(role)) roles.push(role);
  }
  return roles.sort();
}

export function applyGroupMembership(
  context: ScimContext,
  user: ScimUser,
  groups: readonly string[],
  now: IsoDateTime,
): ScimUser {
  assertScimTenant(context, user);
  return { ...user, groups: [...groups].sort(), roles: resolveScimRoles(context, groups), updatedAt: now };
}

/* ------------------------------------------------------------------ *
 * Filtering and pagination
 * ------------------------------------------------------------------ */

export interface ScimFilter {
  readonly attribute: 'userName' | 'externalId' | 'active';
  readonly operator: 'eq';
  readonly value: string;
}

/**
 * Parses the subset of SCIM filters provisioning clients actually send:
 * `userName eq "x"`, `externalId eq "x"`, `active eq true`.
 *
 * A strict subset rather than a general expression parser, because every
 * filter attribute is a column and an over-general parser is how a filter
 * string turns into a query-shaping primitive. Anything unrecognised is
 * rejected, never passed through.
 */
export function parseScimFilter(filter: string | undefined): ScimFilter | null {
  if (filter === undefined || filter.trim() === '') return null;
  const match = /^\s*(userName|externalId|active)\s+eq\s+(?:"([^"\\]*)"|(true|false))\s*$/i.exec(filter);
  if (!match) throw new ScimError('SCIM_INVALID_FILTER', 'Unsupported SCIM filter');

  const rawAttribute = match[1]!.toLowerCase();
  const attribute = rawAttribute === 'username' ? 'userName' : rawAttribute === 'externalid' ? 'externalId' : 'active';
  const value = match[2] ?? match[3]!;
  if (attribute === 'active' && !['true', 'false'].includes(value.toLowerCase())) {
    throw new ScimError('SCIM_INVALID_FILTER', 'active must be compared to a boolean');
  }
  if (attribute !== 'active' && value === '') {
    throw new ScimError('SCIM_INVALID_FILTER', 'Filter value must not be empty');
  }
  return { attribute: attribute as ScimFilter['attribute'], operator: 'eq', value };
}

export function matchesScimFilter(user: ScimUser, filter: ScimFilter | null): boolean {
  if (filter === null) return true;
  switch (filter.attribute) {
    case 'userName': return user.userName.toLowerCase() === filter.value.toLowerCase();
    case 'externalId': return user.externalId !== null && user.externalId === filter.value;
    case 'active': return user.active === (filter.value.toLowerCase() === 'true');
  }
}

export const SCIM_MAXIMUM_PAGE_SIZE = 200;
export const SCIM_DEFAULT_PAGE_SIZE = 100;

export interface ScimListResponse<T> {
  readonly schemas: readonly [typeof SCIM_LIST_SCHEMA];
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly Resources: readonly T[];
}

/**
 * Pages a result set. `startIndex` is **1-based** — RFC 7644 §3.4.2.4.
 *
 * This is the single most common SCIM bug: treating it as 0-based skips the
 * first user of every page or returns one twice, and the symptom appears
 * months later as "a few staff were never provisioned". An out-of-range index
 * is an error rather than a clamp, so a broken client is visible immediately
 * instead of quietly syncing the wrong window.
 */
export function paginateScim<T>(
  resources: readonly T[],
  startIndex: number | undefined,
  count: number | undefined,
): ScimListResponse<T> {
  const start = startIndex ?? 1;
  if (!Number.isInteger(start) || start < 1) {
    throw new ScimError('SCIM_INVALID_PAGINATION', 'startIndex is 1-based and must be a positive integer');
  }
  if (count !== undefined && (!Number.isInteger(count) || count < 0)) {
    throw new ScimError('SCIM_INVALID_PAGINATION', 'count must be a non-negative integer');
  }
  // Clamping the page size is a resource limit, not a correctness question, so
  // an oversized count is capped rather than refused.
  const itemsPerPage = Math.min(count ?? SCIM_DEFAULT_PAGE_SIZE, SCIM_MAXIMUM_PAGE_SIZE);
  const offset = start - 1;
  const page = resources.slice(offset, offset + itemsPerPage);
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: start,
    itemsPerPage: page.length,
    Resources: page,
  };
}

/** Serialises to the SCIM wire shape. Kept here so the schema URN cannot drift. */
export function toScimUserResource(user: ScimUser): Readonly<Record<string, unknown>> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.userName,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.email ? { emails: [{ value: user.email, primary: true }] } : {}),
    active: user.active,
    roles: user.roles.map((role) => ({ value: role })),
    meta: {
      resourceType: 'User',
      created: user.createdAt,
      lastModified: user.updatedAt,
      // Deliberately relative: an absolute URL would bake one tenant hostname
      // into a record that is served from several.
      location: `/scim/v2/Users/${user.id}`,
    },
  };
}
