import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import type { PlatformContext, TenantContext } from '../../../../../packages/contracts/src/index.js';
import { randomToken } from '../../../../../packages/crypto/src/tokens.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../../../packages/crypto/src/canonical-json.js';
import { canonicalHostname } from '../../../../../packages/custom-domains/src/index.js';
import { SupabaseAuthProvider, validatePassword } from '../../../../../packages/provider-adapters/src/supabase-auth.js';
import type {
  AuthenticatedSessionView, AuthenticationRepository, AuthRequestMetadata, CompletePasswordInput, LoginInput,
  OrganizationUserInput, OrganizationUserView, PasswordRecoveryInput,
} from '../../ports.js';
import type { ProductionInfrastructure } from './infrastructure.js';

const SESSION_COOKIE_NAME = '__Host-ks_api_session';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuthenticationRepositoryConfiguration {
  readonly rootDomain: string;
  readonly platformAdminHostname: string;
  readonly tenantDiscoveryHostname: string;
  readonly authPortalUrl: string;
  readonly sessionLifetimeSeconds: number;
}

interface ResolvedDestination {
  readonly boundary: 'tenant' | 'platform';
  readonly hostname: string;
  readonly destinationUrl: string;
  readonly tenantId?: string;
}

export function createAuthenticationRepository(
  controlDatabase: SqlDatabase,
  dataDatabase: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  provider: SupabaseAuthProvider,
  configuration: AuthenticationRepositoryConfiguration,
): AuthenticationRepository {
  canonicalHostname(configuration.rootDomain, { allowPlatformNamespace: true });
  const platformAdminHostname = canonicalHostname(configuration.platformAdminHostname, { allowPlatformNamespace: true });
  canonicalHostname(configuration.tenantDiscoveryHostname, { allowPlatformNamespace: true });
  const authPortal = new URL(configuration.authPortalUrl);
  if (authPortal.protocol !== 'https:' || authPortal.username || authPortal.password || authPortal.port) throw new Error('AUTH_PORTAL_URL_INVALID');
  if (!Number.isInteger(configuration.sessionLifetimeSeconds) || configuration.sessionLifetimeSeconds < 900 || configuration.sessionLifetimeSeconds > 86_400) throw new Error('AUTH_SESSION_LIFETIME_INVALID');

  async function resolveSubjectDestination(subjectId: string): Promise<ResolvedDestination> {
    const platform = await controlDatabase.transaction(async (transaction) => transaction.query<{ readonly id: string }>(
      `select s.id
         from control.platform_subjects s
        where s.id=$1
          and s.status='active'
          and exists (
            select 1
              from control.platform_role_assignments r
             where r.platform_subject_id=s.id
               and r.revoked_at is null
          )
        limit 1`,
      [subjectId],
    ));
    if (platform.rows[0]) return { boundary: 'platform', hostname: platformAdminHostname, destinationUrl: `https://${platformAdminHostname}/` };

    const memberships = await dataDatabase.transaction(async (transaction) => transaction.query<{ readonly tenant_id: string }>(
      `select u.tenant_id
         from app.users u
         join app.memberships m on m.tenant_id=u.tenant_id and m.user_id=u.id and m.status='active'
        where u.external_subject=$1 and u.disabled_at is null
        group by u.tenant_id
        order by max(m.created_at) desc, u.tenant_id
        limit 25`,
      [subjectId],
    ));
    for (const membership of memberships.rows) {
      try { return await primaryTenantDestination(controlDatabase, membership.tenant_id); }
      catch (cause) { if (!(cause instanceof Error) || cause.message !== 'ORGANIZATION_PRIMARY_DOMAIN_NOT_ACTIVE') throw cause; }
    }
    throw new Error('AUTH_ACCOUNT_NOT_AUTHORIZED');
  }

  async function assertSubjectAccess(subjectId: string, destination: ResolvedDestination): Promise<string | undefined> {
    if (destination.boundary === 'platform') {
      const result = await controlDatabase.transaction(async (transaction) => transaction.query<{ readonly display_name: string }>(
        `select s.display_name
           from control.platform_subjects s
          where s.id=$1
            and s.status='active'
            and exists (
              select 1
                from control.platform_role_assignments r
               where r.platform_subject_id=s.id
                 and r.revoked_at is null
            )
          limit 1`,
        [subjectId],
      ));
      const row = result.rows[0];
      if (!row) throw new Error('AUTH_ACCOUNT_NOT_AUTHORIZED');
      return row.display_name;
    }
    const tenantId = requiredTenant(destination);
    const context: TenantContext = { tenantId, subjectId, requestId: crypto.randomUUID(), authMethod: 'trusted_service', source: 'deployment' };
    return withTenantTransaction(dataDatabase, context, 'trusted_service', async (transaction) => {
      const result = await transaction.query<{ readonly display_name: string }>(
        `select u.display_name
           from app.users u
           join app.memberships m on m.tenant_id=u.tenant_id and m.user_id=u.id and m.status='active'
          where u.tenant_id=$1 and u.external_subject=$2 and u.disabled_at is null
          limit 1`,
        [tenantId, subjectId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('AUTH_ACCOUNT_NOT_AUTHORIZED');
      return row.display_name;
    });
  }

  async function createSession(subjectId: string, destination: ResolvedDestination, displayName?: string): Promise<AuthenticatedSessionView & { readonly sessionToken: string }> {
    const sessionToken = randomToken(48);
    const csrfToken = randomToken(32);
    const sessionHash = await sha256Hex(sessionToken);
    const csrfHash = await sha256Hex(csrfToken);
    const expiresAt = new Date(Date.now() + configuration.sessionLifetimeSeconds * 1000).toISOString();
    await controlDatabase.transaction(async (transaction) => {
      await transaction.query(
        `insert into control.host_bound_sessions
           (token_hash,tenant_id,boundary,hostname,subject_id,authentication_method,csrf_token_hash,expires_at)
         values(decode($1,'hex'),$2,$3,$4,$5,'session',decode($6,'hex'),$7)`,
        [sessionHash, destination.tenantId ?? null, destination.boundary, destination.hostname, subjectId, csrfHash, expiresAt],
      );
    });
    return {
      sessionToken, csrfToken, subjectId, boundary: destination.boundary,
      destinationUrl: destination.destinationUrl, expiresAt,
      ...(destination.tenantId ? { tenantId: destination.tenantId } : {}),
      ...(displayName ? { displayName } : {}),
    };
  }

  return {
    async login(input: LoginInput, metadata: AuthRequestMetadata) {
      const email = normalizeEmail(input.email);
      const bucket = await enforceAuthRateLimit(controlDatabase, 'login', metadata, email, 10);
      const session = await provider.signInWithPassword(email, input.password);
      const destination = await resolveSubjectDestination(session.user.id);
      const displayName = await assertSubjectAccess(session.user.id, destination);
      await clearAuthRateLimit(controlDatabase, 'login', bucket);
      return createSession(session.user.id, destination, displayName);
    },

    async forgotPassword(input: PasswordRecoveryInput, metadata: AuthRequestMetadata) {
      const email = normalizeEmail(input.email);
      await enforceAuthRateLimit(controlDatabase, 'password_recovery', metadata, email, 5);
      const redirect = new URL('/aterstall/', authPortal);
      await provider.sendPasswordRecovery(email, redirect.toString());
      return { accepted: true as const };
    },

    async completePassword(input: CompletePasswordInput, metadata: AuthRequestMetadata) {
      validatePassword(input.password);
      const bucket = await enforceAuthRateLimit(controlDatabase, 'password_complete', metadata, undefined, 10);
      const verified = input.tokenHash
        ? await provider.verifyEmailOtp(input.tokenHash, input.type ?? 'recovery')
        : input.accessToken
          ? { accessToken: input.accessToken, expiresIn: 1, user: await provider.getUser(input.accessToken) }
          : undefined;
      if (!verified) throw new Error('AUTH_EMAIL_LINK_INVALID');
      const destination = await resolveSubjectDestination(verified.user.id);
      const displayName = await assertSubjectAccess(verified.user.id, destination);
      const user = await provider.updatePassword(verified.accessToken, input.password);
      if (verified.user.id !== user.id) throw new Error('AUTH_PROVIDER_IDENTITY_MISMATCH');
      await markInvitationAccepted(controlDatabase, destination.tenantId, user.id);
      await clearAuthRateLimit(controlDatabase, 'password_complete', bucket);
      return createSession(user.id, destination, displayName);
    },

    async session(sessionToken, originHostname) {
      const tokenHash = await sha256Hex(validateSessionToken(sessionToken));
      const hostname = canonicalHostname(originHostname, { allowPlatformNamespace: true });
      const csrfToken = randomToken(32);
      const csrfHash = await sha256Hex(csrfToken);
      const result = await controlDatabase.transaction(async (transaction) => transaction.query<SessionRow>(
        `update control.host_bound_sessions
            set last_seen_at=now(),csrf_token_hash=decode($3,'hex'),session_version=session_version+1
          where token_hash=decode($1,'hex')
            and hostname=$2
            and revoked_at is null
            and expires_at>now()
          returning tenant_id,boundary,hostname,subject_id,expires_at`,
        [tokenHash, hostname, csrfHash],
      ));
      const row = result.rows[0];
      if (!row) throw new Error('AUTH_SESSION_INVALID');
      const displayName = await assertSubjectAccess(row.subject_id, {
        boundary: row.boundary,
        hostname: row.hostname,
        destinationUrl: `https://${row.hostname}/`,
        ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      });
      return {
        csrfToken, subjectId: row.subject_id, boundary: row.boundary,
        destinationUrl: `https://${row.hostname}/`, expiresAt: iso(row.expires_at),
        ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
        ...(displayName ? { displayName } : {}),
      };
    },

    async logout(sessionToken, originHostname, csrfToken) {
      const tokenHash = await sha256Hex(validateSessionToken(sessionToken));
      const hostname = canonicalHostname(originHostname, { allowPlatformNamespace: true });
      const csrfHash = await sha256Hex(validateCsrfToken(csrfToken));
      const result = await controlDatabase.transaction(async (transaction) => transaction.query<{ readonly id: string }>(
        `update control.host_bound_sessions
            set revoked_at=coalesce(revoked_at,now())
          where token_hash=decode($1,'hex')
            and hostname=$2
            and csrf_token_hash=decode($3,'hex')
            and revoked_at is null
            and expires_at>now()
          returning id`,
        [tokenHash, hostname, csrfHash],
      ));
      if (!result.rows[0]) throw new Error('CSRF_TOKEN_INVALID');
      return { loggedOut: true as const };
    },

    async listOrganizationUsers(context, tenantId) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      const rows = await controlDatabase.transaction(async (transaction) => transaction.query<InvitationRow>(
        `select id,tenant_id,provider_user_id,display_name,email_ciphertext,role_key,status,created_at
           from control.organization_account_invitations
          where tenant_id=$1
          order by created_at desc,id`, [tenantId],
      ));
      const views: OrganizationUserView[] = [];
      for (const row of rows.rows) views.push(await invitationView(row, infrastructure));
      return views;
    },

    async inviteOrganizationUser(context, tenantId, input, idempotencyKey, payloadHash) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      const email = normalizeEmail(input.email);
      const displayName = cleanText(input.displayName, 2, 200);
      const roleKey = input.roleKey;
      const existing = await controlDatabase.transaction(async (transaction) => transaction.query<InvitationRow>(
        `select id,tenant_id,provider_user_id,display_name,email_ciphertext,role_key,status,created_at
           from control.organization_account_invitations
          where tenant_id=$1 and idempotency_key=$2 limit 1`, [tenantId, idempotencyKey],
      ));
      if (existing.rows[0]) return invitationView(existing.rows[0], infrastructure);

      const destination = await primaryTenantDestination(controlDatabase, tenantId);
      const redirect = new URL('/aktivera/', authPortal);
      redirect.searchParams.set('destination', destination.hostname);
      const invitation = await provider.inviteOrFindUser(email, redirect.toString(), {
        kommunsignTenantId: tenantId,
        kommunsignRole: roleKey,
        organizationName: await organizationName(controlDatabase, tenantId),
        displayName,
      });
      const emailCiphertext = await infrastructure.sensitiveData.encryptText(email, 'organization.account_email');
      const emailBlindIndex = await infrastructure.sensitiveData.blindIndex(email, 'organization.account_email');
      const intendedStatus = invitation.invited ? 'invited' : 'active';

      const pendingRow = await controlDatabase.transaction(async (transaction) => {
        const inserted = await transaction.query<InvitationRow>(
          `insert into control.organization_account_invitations
             (tenant_id,provider,provider_user_id,display_name,email_ciphertext,email_blind_index,role_key,status,invited_by,idempotency_key,invite_sent_at,accepted_at,last_error_code,updated_at)
           values($1,'supabase_auth',$2,$3,$4,$5,$6,$7,$8,$9,case when $7='invited' then now() end,case when $7='active' then now() end,null,now())
           on conflict(tenant_id,provider,provider_user_id) do update set
             display_name=excluded.display_name,
             email_ciphertext=excluded.email_ciphertext,
             email_blind_index=excluded.email_blind_index,
             role_key=excluded.role_key,
             status=excluded.status,
             invited_by=excluded.invited_by,
             idempotency_key=excluded.idempotency_key,
             invite_sent_at=case when excluded.status='invited' then now() else control.organization_account_invitations.invite_sent_at end,
             accepted_at=case when excluded.status='active' then coalesce(control.organization_account_invitations.accepted_at,now()) else null end,
             last_error_code=null,
             updated_at=now()
           returning id,tenant_id,provider_user_id,display_name,email_ciphertext,role_key,status,created_at`,
          [tenantId, invitation.user.id, displayName, emailCiphertext, emailBlindIndex, roleKey, intendedStatus, context.subjectId, idempotencyKey],
        );
        return requiredRow(inserted.rows[0], 'ORGANIZATION_ACCOUNT_INVITATION_CREATE_FAILED');
      });

      try {
        await provisionTenantUser(dataDatabase, infrastructure, context, tenantId, invitation.user.id, displayName, email, roleKey);
      } catch (cause) {
        const safeCode = cause instanceof Error && /^[A-Z0-9_]{3,100}$/.test(cause.message) ? cause.message : 'ORGANIZATION_ACCOUNT_PROVISION_FAILED';
        await controlDatabase.transaction(async (transaction) => {
          await transaction.query(
            `update control.organization_account_invitations
                set status='failed',last_error_code=$2,updated_at=now()
              where id=$1`,
            [pendingRow.id, safeCode],
          );
          await appendControlAudit(transaction, tenantId, context.subjectId, 'organization.user_invitation_failed', {
            invitationId: pendingRow.id,
            tenantId,
            providerSubjectHash: await sha256Hex(invitation.user.id),
            roleKey,
            payloadHash,
            safeErrorCode: safeCode,
          });
        });
        throw cause;
      }

      await controlDatabase.transaction(async (transaction) => {
        await appendControlAudit(transaction, tenantId, context.subjectId, 'organization.user_invited', {
          invitationId: pendingRow.id,
          tenantId,
          providerSubjectHash: await sha256Hex(invitation.user.id),
          roleKey,
          payloadHash,
          inviteEmailSent: invitation.invited,
        });
      });
      return invitationView(pendingRow, infrastructure);
    },

    async setOrganizationUserStatus(context, tenantId, accountId, input) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      requireUuid(accountId, 'ORGANIZATION_ACCOUNT_ID_INVALID');
      const accountResult = await controlDatabase.transaction(async (transaction) => transaction.query<AccountLifecycleRow>(
        `select id,tenant_id,provider_user_id,display_name,email_ciphertext,role_key,status,created_at,accepted_at
           from control.organization_account_invitations
          where id=$1 and tenant_id=$2
          limit 1`,
        [accountId, tenantId],
      ));
      const account = requiredRow(accountResult.rows[0], 'ORGANIZATION_ACCOUNT_NOT_FOUND');
      const enabled = input.action === 'enable';
      if ((enabled && account.status === 'active') || (!enabled && account.status === 'disabled')) {
        return invitationView(account, infrastructure);
      }
      if (enabled && !account.accepted_at) throw new Error('ORGANIZATION_ACCOUNT_NOT_ACTIVATED');
      await setTenantUserEnabled(dataDatabase, context, tenantId, account.provider_user_id, enabled);
      const updated = await controlDatabase.transaction(async (transaction) => {
        const result = await transaction.query<InvitationRow>(
          `update control.organization_account_invitations
              set status=$3,disabled_at=case when $3='disabled' then now() else null end,
                  last_error_code=null,updated_at=now()
            where id=$1 and tenant_id=$2
            returning id,tenant_id,provider_user_id,display_name,email_ciphertext,role_key,status,created_at`,
          [accountId, tenantId, enabled ? 'active' : 'disabled'],
        );
        if (!enabled) {
          await transaction.query(
            `update control.host_bound_sessions
                set revoked_at=coalesce(revoked_at,now())
              where tenant_id=$1 and subject_id=$2 and revoked_at is null`,
            [tenantId, account.provider_user_id],
          );
        }
        await appendControlAudit(transaction, tenantId, context.subjectId, enabled ? 'organization.user_enabled' : 'organization.user_disabled', {
          invitationId: accountId,
          tenantId,
          providerSubjectHash: await sha256Hex(account.provider_user_id),
        });
        return requiredRow(result.rows[0], 'ORGANIZATION_ACCOUNT_STATUS_UPDATE_FAILED');
      });
      return invitationView(updated, infrastructure);
    },

  };
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  validateSessionToken(token);
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
export function sessionTokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME) return decodeURIComponent(rawValue.join('='));
  }
  return null;
}

async function provisionTenantUser(
  dataDatabase: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  platformContext: PlatformContext,
  tenantId: string,
  providerSubjectId: string,
  displayName: string,
  email: string,
  roleKey: OrganizationUserInput['roleKey'],
): Promise<void> {
  const context: TenantContext = { tenantId, subjectId: platformContext.subjectId, requestId: platformContext.requestId, authMethod: 'trusted_service', source: 'deployment' };
  await withTenantTransaction(dataDatabase, context, 'trusted_service', async (transaction) => {
    const emailCiphertext = await infrastructure.sensitiveData.encryptText(email, 'tenant.user_email');
    const emailBlindIndex = await infrastructure.sensitiveData.blindIndex(email, 'tenant.user_email');
    const existing = await transaction.query<{ readonly id: string }>(
      `select id from app.users where tenant_id=$1 and (external_subject=$2 or email_blind_index=$3) order by created_at limit 1`,
      [tenantId, providerSubjectId, emailBlindIndex],
    );
    let userId = existing.rows[0]?.id;
    if (userId) {
      await transaction.query(
        `update app.users set external_subject=$3,display_name=$4,email_ciphertext=$5,email_blind_index=$6,disabled_at=null
          where tenant_id=$1 and id=$2`,
        [tenantId, userId, providerSubjectId, displayName, emailCiphertext, emailBlindIndex],
      );
    } else {
      const created = await transaction.query<{ readonly id: string }>(
        `insert into app.users(tenant_id,external_subject,display_name,email_ciphertext,email_blind_index)
         values($1,$2,$3,$4,$5) returning id`,
        [tenantId, providerSubjectId, displayName, emailCiphertext, emailBlindIndex],
      );
      userId = requiredRow(created.rows[0], 'ORGANIZATION_USER_CREATE_FAILED').id;
    }
    const existingMembership = await transaction.query<{ readonly id: string }>(
      `select id from app.memberships where tenant_id=$1 and user_id=$2 order by created_at limit 1`,
      [tenantId, userId],
    );
    let membershipId = existingMembership.rows[0]?.id;
    if (!membershipId) {
      const membership = await transaction.query<{ readonly id: string }>(
        `insert into app.memberships(tenant_id,user_id,status)
         values($1,$2,'active')
         returning id`,
        [tenantId, userId],
      );
      membershipId = requiredRow(membership.rows[0], 'ORGANIZATION_MEMBERSHIP_CREATE_FAILED').id;
    } else {
      await transaction.query(
        `update app.memberships set status='active' where tenant_id=$1 and id=$2`,
        [tenantId, membershipId],
      );
    }
    const role = await transaction.query<{ readonly id: string }>(
      `select id from app.roles where tenant_id=$1 and role_key=$2 limit 1`, [tenantId, roleKey],
    );
    const roleId = requiredRow(role.rows[0], 'ORGANIZATION_ROLE_NOT_PROVISIONED').id;
    await transaction.query(
      `delete from app.role_assignments ra
        using app.roles r
       where ra.tenant_id=$1
         and ra.membership_id=$2
         and r.tenant_id=ra.tenant_id
         and r.id=ra.role_id
         and r.role_key in (
           'tenant_admin','tenant_security_admin','tenant_integration_admin','tenant_archive_admin',
           'department_admin','document_creator','document_sender','approver','auditor','readonly'
         )`,
      [tenantId, membershipId],
    );
    await transaction.query(
      `insert into app.role_assignments(tenant_id,membership_id,role_id)
       values($1,$2,$3)`,
      [tenantId, membershipId, roleId],
    );
    await transaction.query(
      `select audit.append_event($1,'BUSINESS','organization.user_access_granted','platform',$2,'user',$3,$4::jsonb,now())`,
      [tenantId, platformContext.subjectId, userId, JSON.stringify({ userId, membershipId, roleKey, providerSubjectHash: await sha256Hex(providerSubjectId) })],
    );
  });
}

async function setTenantUserEnabled(
  database: SqlDatabase,
  platformContext: PlatformContext,
  tenantId: string,
  providerSubjectId: string,
  enabled: boolean,
): Promise<void> {
  const context: TenantContext = {
    tenantId,
    subjectId: platformContext.subjectId,
    requestId: platformContext.requestId,
    authMethod: 'trusted_service',
    source: 'deployment',
  };
  await withTenantTransaction(database, context, 'trusted_service', async (transaction) => {
    const userResult = await transaction.query<{ readonly id: string }>(
      `update app.users
          set disabled_at=case when $3::boolean then null else now() end
        where tenant_id=$1 and external_subject=$2
        returning id`,
      [tenantId, providerSubjectId, enabled],
    );
    const userId = requiredRow(userResult.rows[0], 'ORGANIZATION_USER_NOT_FOUND').id;
    await transaction.query(
      `update app.memberships
          set status=case when $3::boolean then 'active' else 'disabled' end
        where tenant_id=$1 and user_id=$2`,
      [tenantId, userId, enabled],
    );
    await transaction.query(
      `select audit.append_event($1,'BUSINESS',$2,'platform',$3,'user',$4,$5::jsonb,now())`,
      [tenantId, enabled ? 'organization.user_enabled' : 'organization.user_disabled', platformContext.subjectId, userId,
       JSON.stringify({ userId, providerSubjectHash: await sha256Hex(providerSubjectId) })],
    );
  });
}

async function organizationName(database: SqlDatabase, tenantId: string): Promise<string> {
  const result = await database.transaction(async (transaction) => transaction.query<{ readonly legal_name: string }>(
    `select legal_name from control.platform_tenants where id=$1 limit 1`, [tenantId],
  ));
  return requiredRow(result.rows[0], 'ORGANIZATION_NOT_FOUND').legal_name;
}

async function primaryTenantDestination(database: SqlDatabase, tenantId: string): Promise<ResolvedDestination> {
  const result = await database.transaction(async (transaction) => transaction.query<{ readonly normalized_hostname: string }>(
    `select normalized_hostname from control.tenant_domains
      where tenant_id=$1 and is_primary and status='active' and verification_status='verified' and tls_status='active'
      order by updated_at desc limit 1`, [tenantId],
  ));
  const hostname = result.rows[0]?.normalized_hostname;
  if (!hostname) throw new Error('ORGANIZATION_PRIMARY_DOMAIN_NOT_ACTIVE');
  return { boundary: 'tenant', hostname, tenantId, destinationUrl: `https://${hostname}/` };
}

async function markInvitationAccepted(database: SqlDatabase, tenantId: string | undefined, providerUserId: string): Promise<void> {
  if (!tenantId) return;
  await database.transaction(async (transaction) => {
    const updated = await transaction.query<{ readonly id: string }>(
      `update control.organization_account_invitations
          set status='active',accepted_at=coalesce(accepted_at,now()),updated_at=now()
        where tenant_id=$1 and provider_user_id=$2 and status='invited'
        returning id`,
      [tenantId, providerUserId],
    );
    if (updated.rows[0]) {
      await appendControlAudit(transaction, tenantId, UUID_PATTERN.test(providerUserId) ? providerUserId : null, 'organization.user_activated', {
        invitationId: updated.rows[0].id,
        providerSubjectHash: await sha256Hex(providerUserId),
      });
    }
  });
}

async function invitationView(row: InvitationRow, infrastructure: ProductionInfrastructure): Promise<OrganizationUserView> {
  const email = await infrastructure.sensitiveData.decryptText(row.email_ciphertext, 'organization.account_email');
  return {
    id: row.id, tenantId: row.tenant_id, providerSubjectId: row.provider_user_id,
    displayName: row.display_name, maskedEmail: maskEmail(email), roleKey: row.role_key,
    status: row.status, invitedAt: iso(row.created_at),
  };
}

async function appendControlAudit(transaction: SqlTransaction, tenantId: string | null, actorId: string | null, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await transaction.query(`select pg_advisory_xact_lock(hashtextextended('control-audit-chain',0))`);
  const previous = await transaction.query<{ readonly event_hash: string }>(`select event_hash from control.control_audit_events order by occurred_at desc,id desc limit 1`);
  const previousHash = previous.rows[0]?.event_hash ?? '0'.repeat(64);
  const material = canonicalJson({ tenantId, actorId, eventType, payload, previousHash } as unknown as CanonicalJsonValue);
  const eventHash = await sha256Hex(material);
  await transaction.query(
    `insert into control.control_audit_events(tenant_id,actor_id,event_type,payload,previous_event_hash,event_hash)
     values($1,$2,$3,$4::jsonb,$5,$6)`,
    [tenantId, actorId, eventType, JSON.stringify(payload), previousHash, eventHash],
  );
}


async function enforceAuthRateLimit(
  database: SqlDatabase,
  action: 'login' | 'password_recovery' | 'password_complete',
  metadata: AuthRequestMetadata,
  email: string | undefined,
  maximumAttempts: number,
): Promise<string> {
  const ipAddress = normalizeIp(metadata.ipAddress);
  const userAgent = cleanText(metadata.userAgent || 'unknown', 1, 500);
  const bucketHash = await sha256Hex(`${action}\n${ipAddress}\n${email ?? ''}\n${userAgent.slice(0, 120)}`);
  const result = await database.transaction(async (transaction) => transaction.query<{
    readonly attempts: number | string;
    readonly blocked_until: string | Date | null;
  }>(
    `insert into control.auth_rate_limit_buckets(action,bucket_hash,window_started_at,attempts,blocked_until,updated_at)
     values($1,$2,now(),1,null,now())
     on conflict(action,bucket_hash) do update set
       attempts=case
         when control.auth_rate_limit_buckets.window_started_at < now() - interval '15 minutes' then 1
         else control.auth_rate_limit_buckets.attempts + 1
       end,
       window_started_at=case
         when control.auth_rate_limit_buckets.window_started_at < now() - interval '15 minutes' then now()
         else control.auth_rate_limit_buckets.window_started_at
       end,
       blocked_until=case
         when control.auth_rate_limit_buckets.blocked_until is not null
          and control.auth_rate_limit_buckets.blocked_until > now()
           then control.auth_rate_limit_buckets.blocked_until
         when control.auth_rate_limit_buckets.window_started_at >= now() - interval '15 minutes'
          and control.auth_rate_limit_buckets.attempts + 1 > $3
           then now() + interval '15 minutes'
         else null
       end,
       updated_at=now()
     returning attempts,blocked_until`,
    [action, bucketHash, maximumAttempts],
  ));
  const row = requiredRow(result.rows[0], 'AUTH_RATE_LIMIT_STATE_MISSING');
  if ((row.blocked_until && new Date(row.blocked_until).getTime() > Date.now()) || Number(row.attempts) > maximumAttempts) {
    throw new Error('AUTH_RATE_LIMITED');
  }
  return bucketHash;
}

async function clearAuthRateLimit(
  database: SqlDatabase,
  action: 'login' | 'password_complete',
  bucketHash: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.query(
      `delete from control.auth_rate_limit_buckets where action=$1 and bucket_hash=$2`,
      [action, bucketHash],
    );
  });
}

function normalizeIp(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^::ffff:/, '');
  if (!/^[0-9a-f:.]{3,64}$/.test(normalized)) throw new Error('AUTH_CLIENT_IP_INVALID');
  return normalized;
}
function validateCsrfToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) throw new Error('CSRF_TOKEN_INVALID');
  return token;
}
function requiredTenant(destination: ResolvedDestination): string {
  if (!destination.tenantId) throw new Error('AUTH_TENANT_CONTEXT_MISSING');
  return destination.tenantId;
}
function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('EMAIL_INVALID');
  return normalized;
}
function validateSessionToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._~-]{64,4096}$/.test(token)) throw new Error('AUTH_SESSION_INVALID');
  return token;
}
function cleanText(value: string, minimum: number, maximum: number): string {
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) throw new Error('VALIDATION_ERROR');
  return result;
}
function requireUuid(value: string, code: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(code);
  return value;
}
function requiredRow<T>(value: T | undefined, code: string): T {
  if (!value) throw new Error(code);
  return value;
}
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '•••';
  return `${local.slice(0, 1)}${'•'.repeat(Math.min(6, Math.max(2, local.length - 1)))}@${domain}`;
}
function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

interface SessionRow {
  readonly tenant_id: string | null;
  readonly boundary: 'tenant' | 'platform';
  readonly hostname: string;
  readonly subject_id: string;
  readonly expires_at: string | Date;
}
interface AccountLifecycleRow extends InvitationRow {
  readonly accepted_at: string | Date | null;
}
interface InvitationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly provider_user_id: string;
  readonly display_name: string;
  readonly email_ciphertext: Uint8Array;
  readonly role_key: OrganizationUserInput['roleKey'];
  readonly status: OrganizationUserView['status'];
  readonly created_at: string | Date;
}
