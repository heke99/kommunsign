import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import { TENANT_ROLES, type TenantRole } from '../../../../../packages/authorization/src/index.js';
import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction } from '../../../../../packages/database/src/index.js';

export interface TenantRepository {
  rolesForSubject(context: TenantContext): Promise<readonly TenantRole[]>;
  ensureSubjectUser(context: TenantContext): Promise<string>;
}

export function createTenantRepository(database: SqlDatabase): TenantRepository {
  return {
    async rolesForSubject(context) {
      return withTenantTransaction(database, context, actorKind(context), async (transaction) => {
        const result = await transaction.query<{ readonly role_key: string }>(
          `select distinct r.role_key
             from app.users u
             join app.memberships m on m.tenant_id = u.tenant_id and m.user_id = u.id and m.status = 'active'
             join app.role_assignments ra on ra.tenant_id = m.tenant_id and ra.membership_id = m.id
             join app.roles r on r.tenant_id = ra.tenant_id and r.id = ra.role_id
            where u.tenant_id = $1 and u.external_subject = $2 and u.disabled_at is null`,
          [context.tenantId, context.subjectId],
        );
        const allowed = new Set<string>(TENANT_ROLES);
        return result.rows.map((row) => row.role_key).filter((role): role is TenantRole => allowed.has(role));
      });
    },
    async ensureSubjectUser(context) {
      return withTenantTransaction(database, context, actorKind(context), async (transaction) => {
        const existing = await transaction.query<{ readonly id: string }>(
          `select id from app.users where tenant_id = $1 and external_subject = $2 and disabled_at is null limit 1`,
          [context.tenantId, context.subjectId],
        );
        const row = existing.rows[0];
        if (!row) throw new Error('TENANT_SUBJECT_NOT_PROVISIONED');
        return row.id;
      });
    },
  };
}

function actorKind(context: TenantContext): 'internal_user' | 'external_client' | 'worker' | 'trusted_service' {
  if (context.authMethod === 'oauth2_client_credentials' || context.authMethod === 'mtls') return 'external_client';
  if (context.authMethod === 'worker') return 'worker';
  if (context.authMethod === 'trusted_service') return 'trusted_service';
  return 'internal_user';
}
