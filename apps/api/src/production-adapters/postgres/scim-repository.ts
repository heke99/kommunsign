import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import type { SensitiveDataAdapter } from './infrastructure.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import {
  ScimError, type ScimContext, type ScimUser,
} from '../../../../../packages/scim/src/index.js';

/**
 * SCIM provisioning against the existing identity model.
 *
 * Migration 0017 made the deliberate choice to extend `app.users` rather than
 * introduce a parallel `scim_users` table, because a second user model would
 * immediately disagree with the first about who exists and who is disabled,
 * and every signature already references `app.users`. This repository keeps
 * that promise: a SCIM user *is* a row in `app.users`, with the directory's
 * identifiers alongside.
 *
 * Roles reach a user through the existing membership model rather than a SCIM
 * shortcut. `app.role_assignments` hangs off `app.memberships`, so provisioning
 * ensures a tenant-wide membership exists and assigns roles against it. Doing
 * it any other way would create grants the rest of the system cannot see.
 */

export interface ScimClientCredential {
  readonly tenantId: string;
  readonly clientId: string;
  readonly assignableRoles: readonly string[];
  readonly groupToRole: Readonly<Record<string, string>>;
}

export interface ScimRepository {
  /**
   * Resolves a bearer token to the client that owns it, or null.
   *
   * The tenant comes from this row and never from the request body or path.
   * A provisioning client that could name its own tenant would be a
   * cross-tenant write primitive handed out with every credential.
   */
  authenticate(tokenHash: Uint8Array): Promise<ScimClientCredential | null>;
  listUsers(context: ScimContext): Promise<readonly ScimUser[]>;
  getUser(context: ScimContext, userId: string): Promise<ScimUser | null>;
  createUser(context: ScimContext, user: ScimUser, requestId: string): Promise<ScimUser>;
  saveUser(context: ScimContext, user: ScimUser, action: ScimProvisioningAction, requestId: string): Promise<ScimUser>;
  /** True when the user has signed, handled or decided anything. */
  hasHistory(context: ScimContext, userId: string): Promise<boolean>;
  listGroups(context: ScimContext): Promise<readonly { readonly displayName: string; readonly role: string }[]>;
  /**
   * Issues a provisioning credential and returns the token exactly once.
   *
   * Returned once because it is stored only as a hash: there is nothing to
   * show the customer later. That is the point — a token this system could
   * re-display is a token this system is still holding.
   */
  issueClient(context: TenantContext, input: IssueScimClientInput): Promise<IssuedScimClient>;
}

export interface IssueScimClientInput {
  readonly displayName: string;
  readonly assignableRoles: readonly string[];
  readonly groupToRole: Readonly<Record<string, string>>;
}
export interface IssuedScimClient {
  readonly clientId: string;
  readonly displayName: string;
  readonly assignableRoles: readonly string[];
  /** Shown once and never again. */
  readonly token: string;
}

export type ScimProvisioningAction = 'CREATED' | 'UPDATED' | 'ACTIVATED' | 'DEACTIVATED' | 'DELETED' | 'ROLES_CHANGED';

export function createScimRepository(database: SqlDatabase, sensitiveData: SensitiveDataAdapter): ScimRepository {
  return {
    async authenticate(tokenHash) {
      // Read outside a tenant transaction, because the tenant is exactly what
      // this lookup is establishing. The token hash is the only input.
      const result = await database.transaction(async (tx) => tx.query<{
        readonly tenant_id: string; readonly id: string; readonly assignable_roles: readonly string[];
      }>(
        `select tenant_id,id,assignable_roles from app.scim_provisioning_clients
          where token_hash=$1 and enabled=true`,
        [tokenHash],
      ));
      const row = result.rows[0];
      if (!row) return null;

      const mappings = await database.transaction(async (tx) => tx.query<{
        readonly group_value: string; readonly role_key: string;
      }>(
        `select mapping.group_value,role.role_key
           from app.scim_group_role_mappings mapping
           join app.roles role on role.tenant_id=mapping.tenant_id and role.id=mapping.role_id
          where mapping.tenant_id=$1 and mapping.client_id=$2`,
        [row.tenant_id, row.id],
      ));

      // Recorded on use so a credential that stopped being used is visible
      // before someone finds it still valid two years later.
      await database.transaction(async (tx) => tx.query(
        `update app.scim_provisioning_clients set last_used_at=now() where tenant_id=$1 and id=$2`,
        [row.tenant_id, row.id],
      ));

      return {
        tenantId: row.tenant_id,
        clientId: row.id,
        assignableRoles: row.assignable_roles,
        groupToRole: Object.fromEntries(mappings.rows.map((entry) => [entry.group_value, entry.role_key])),
      };
    },

    async listUsers(context) {
      return tenantTx(database, context, async (tx) => {
        const rows = await tx.query<UserRow>(USER_SELECT + ` where u.tenant_id=$1 and u.scim_user_name is not null order by u.created_at,u.id`, [context.tenantId]);
        // Per-row decrypts run concurrently instead of one after another; order is preserved.
        return Promise.all(rows.rows.map((row) => toScimUser(row, sensitiveData)));
      });
    },

    async getUser(context, userId) {
      return tenantTx(database, context, async (tx) => {
        const rows = await tx.query<UserRow>(USER_SELECT + ` where u.tenant_id=$1 and u.id=$2`, [context.tenantId, userId]);
        const row = rows.rows[0];
        return row ? toScimUser(row, sensitiveData) : null;
      });
    },

    async createUser(context, user, requestId) {
      return tenantTx(database, context, async (tx) => {
        const email = user.email ? await encryptEmail(sensitiveData, user.email) : null;
        await tx.query(
          `insert into app.users(tenant_id,id,external_subject,display_name,email_ciphertext,email_blind_index,scim_external_id,scim_user_name)
           values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [context.tenantId, user.id, user.userName, user.displayName, email?.ciphertext ?? null,
            email?.blindIndex ?? null, user.externalId, user.userName],
        );
        await ensureMembership(tx, context.tenantId, user.id);
        await applyRoles(tx, context, user);
        await recordEvent(tx, context, user.id, 'CREATED', { userName: user.userName }, requestId);
        return user;
      });
    },

    async saveUser(context, user, action, requestId) {
      return tenantTx(database, context, async (tx) => {
        const email = user.email ? await encryptEmail(sensitiveData, user.email) : null;
        await tx.query(
          `update app.users
              set display_name=$3,scim_external_id=$4,scim_user_name=$5,
                  email_ciphertext=$6,email_blind_index=$7,
                  disabled_at = case when $8 then null else coalesce(disabled_at,now()) end
            where tenant_id=$1 and id=$2`,
          [context.tenantId, user.id, user.displayName, user.externalId, user.userName,
            email?.ciphertext ?? null, email?.blindIndex ?? null, user.active],
        );
        // Deactivation follows the row, not the other way round: a disabled
        // user keeps their history, and their memberships stop granting.
        await tx.query(
          `update app.memberships set status=$3 where tenant_id=$1 and user_id=$2`,
          [context.tenantId, user.id, user.active ? 'active' : 'disabled'],
        );
        await applyRoles(tx, context, user);
        await recordEvent(tx, context, user.id, action, { active: user.active, roles: user.roles }, requestId);
        return user;
      });
    },

    async hasHistory(context, userId) {
      return tenantTx(database, context, async (tx) => {
        const result = await tx.query<{ readonly present: boolean }>(
          `select exists(
             select 1 from app.signature_cases where tenant_id=$1 and created_by=$2
             union all
             select 1 from audit.audit_events where tenant_id=$1 and actor_id=$2
           ) present`,
          [context.tenantId, userId],
        );
        return result.rows[0]?.present ?? false;
      });
    },

    async issueClient(context, input) {
      // Generated here rather than accepted from the caller: a token the
      // customer chose is a token they may have chosen badly, or reused.
      const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = hexToBytes(await sha256Hex(new TextEncoder().encode(token)));

      return withTenantTransaction(database, context, 'internal_user', async (tx) => {
        const roles = await tx.query<{ readonly role_key: string; readonly id: string }>(
          `select role_key,id from app.roles where tenant_id=$1 and role_key = any($2)`,
          [context.tenantId, [...input.assignableRoles]],
        );
        if (roles.rows.length !== input.assignableRoles.length) {
          throw new ScimError('SCIM_ROLE_NOT_ASSIGNABLE', 'A requested role does not exist in this tenant');
        }
        // Every mapped role must also be within the client's own scope, or the
        // mapping would be a way to grant past the ceiling it is meant to have.
        for (const role of Object.values(input.groupToRole)) {
          if (!input.assignableRoles.includes(role)) {
            throw new ScimError('SCIM_ROLE_NOT_ASSIGNABLE', `Group mapping targets ${role}, outside this client's scope`);
          }
        }

        const inserted = await tx.query<{ readonly id: string }>(
          `insert into app.scim_provisioning_clients(tenant_id,display_name,token_hash,assignable_roles,enabled)
           values($1,$2,$3,$4,true) returning id`,
          [context.tenantId, input.displayName, tokenHash, [...input.assignableRoles]],
        );
        const clientId = inserted.rows[0]?.id;
        if (!clientId) throw new ScimError('SCIM_INVALID_VALUE', 'The provisioning client could not be created');

        const roleIdByKey = new Map(roles.rows.map((role) => [role.role_key, role.id]));
        for (const [group, role] of Object.entries(input.groupToRole)) {
          await tx.query(
            `insert into app.scim_group_role_mappings(tenant_id,client_id,group_value,role_id) values($1,$2,$3,$4)`,
            [context.tenantId, clientId, group, roleIdByKey.get(role)],
          );
        }
        await tx.query(`select audit.append_event($1,'BUSINESS','scim.client_issued',$2,$3,'scim_client',$4,$5::jsonb,now())`,
          [context.tenantId, context.authMethod, context.subjectId, clientId,
            { displayName: input.displayName, assignableRoles: input.assignableRoles }]);

        return { clientId, displayName: input.displayName, assignableRoles: input.assignableRoles, token };
      });
    },

    async listGroups(context) {
      return tenantTx(database, context, async (tx) => {
        const rows = await tx.query<{ readonly group_value: string; readonly role_key: string }>(
          `select mapping.group_value,role.role_key
             from app.scim_group_role_mappings mapping
             join app.roles role on role.tenant_id=mapping.tenant_id and role.id=mapping.role_id
            where mapping.tenant_id=$1 and mapping.client_id=$2 order by mapping.group_value`,
          [context.tenantId, context.clientId],
        );
        return rows.rows.map((entry) => ({ displayName: entry.group_value, role: entry.role_key }));
      });
    },
  };
}

const USER_SELECT = `select u.id,u.display_name,u.email_ciphertext,u.disabled_at,u.created_at,
                            u.scim_external_id,u.scim_user_name,
                            coalesce(array_agg(r.role_key) filter (where r.role_key is not null),'{}') roles
                       from app.users u
                       left join app.memberships m on m.tenant_id=u.tenant_id and m.user_id=u.id
                       left join app.role_assignments a on a.tenant_id=m.tenant_id and a.membership_id=m.id
                       left join app.roles r on r.tenant_id=a.tenant_id and r.id=a.role_id`;

interface UserRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly email_ciphertext: Uint8Array | null;
  readonly disabled_at: string | Date | null;
  readonly created_at: string | Date;
  readonly scim_external_id: string | null;
  readonly scim_user_name: string | null;
  readonly roles: readonly string[];
}

async function toScimUser(row: UserRow, sensitiveData: SensitiveDataAdapter): Promise<ScimUser> {
  const created = new Date(row.created_at).toISOString();
  return {
    id: row.id,
    tenantId: '', // filled by the caller's context; never read from a row
    externalId: row.scim_external_id,
    userName: row.scim_user_name ?? row.id,
    displayName: row.display_name,
    email: row.email_ciphertext ? await sensitiveData.decryptText(row.email_ciphertext, 'user.email') : null,
    active: row.disabled_at === null,
    roles: [...row.roles].sort(),
    groups: [],
    createdAt: created,
    updatedAt: created,
  };
}

async function encryptEmail(sensitiveData: SensitiveDataAdapter, email: string): Promise<{ readonly ciphertext: Uint8Array; readonly blindIndex: Uint8Array }> {
  return {
    ciphertext: await sensitiveData.encryptText(email, 'user.email'),
    blindIndex: await sensitiveData.blindIndex(email, 'user.email'),
  };
}

/** A tenant-wide membership. Departments are assigned by people, not by a directory sync. */
async function ensureMembership(tx: SqlTransaction, tenantId: string, userId: string): Promise<string> {
  const existing = await tx.query<{ readonly id: string }>(
    `select id from app.memberships where tenant_id=$1 and user_id=$2 and department_id is null limit 1`,
    [tenantId, userId],
  );
  const found = existing.rows[0]?.id;
  if (found) return found;
  const inserted = await tx.query<{ readonly id: string }>(
    `insert into app.memberships(tenant_id,user_id,department_id,status) values($1,$2,null,'active') returning id`,
    [tenantId, userId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new ScimError('SCIM_INVALID_VALUE', 'Membership could not be created');
  return id;
}

/**
 * Replaces the user's role assignments with exactly what the groups resolved to.
 *
 * Replacement rather than addition: a person removed from a directory group
 * must lose the role, and an additive sync is how someone keeps an
 * administrator grant years after leaving the team that justified it.
 *
 * The client's `assignable_roles` is re-checked here, in SQL, rather than
 * trusted from the caller. `resolveScimRoles` already refuses an unassignable
 * role, but this is the boundary where a bug above it would become a real
 * privilege escalation.
 */
async function applyRoles(tx: SqlTransaction, context: ScimContext, user: ScimUser): Promise<void> {
  const membershipId = await ensureMembership(tx, context.tenantId, user.id);
  const granted = user.roles.filter((role) => context.assignableRoles.includes(role));
  if (granted.length !== user.roles.length) {
    throw new ScimError('SCIM_ROLE_NOT_ASSIGNABLE', 'A role outside this client’s scope was requested');
  }
  await tx.query(`delete from app.role_assignments where tenant_id=$1 and membership_id=$2`, [context.tenantId, membershipId]);
  if (granted.length === 0) return;
  await tx.query(
    `insert into app.role_assignments(tenant_id,membership_id,role_id)
     select $1,$2,role.id from app.roles role where role.tenant_id=$1 and role.role_key = any($3)`,
    [context.tenantId, membershipId, granted],
  );
}

/**
 * The provisioning trail (requirement 3518).
 *
 * Never the raw payload: it carries directory attributes we have no reason to
 * retain, and retaining them would be its own processing without a purpose.
 */
async function recordEvent(
  tx: SqlTransaction, context: ScimContext, userId: string,
  action: ScimProvisioningAction, detail: Readonly<Record<string, unknown>>, requestId: string,
): Promise<void> {
  await tx.query(
    `insert into app.scim_provisioning_events(tenant_id,client_id,user_id,action,detail,request_id)
     values($1,$2,$3,$4,$5::jsonb,$6)`,
    [context.tenantId, context.clientId, userId, action, detail, requestId],
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function tenantTx<T>(database: SqlDatabase, context: ScimContext, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  const tenantContext: TenantContext = {
    tenantId: context.tenantId,
    subjectId: context.clientId,
    requestId: context.requestId,
    authMethod: 'oauth2_client_credentials',
    source: 'api-client',
  };
  return withTenantTransaction(database, tenantContext, 'external_client', work);
}
