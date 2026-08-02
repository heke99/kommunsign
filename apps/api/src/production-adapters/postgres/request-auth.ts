import { verifyHmacSha256Hex } from '../../../../../packages/crypto/src/hmac.js';
import type { AuthMethod, PlatformContext, TenantContext } from '../../../../../packages/contracts/src/index.js';
import { PLATFORM_ROLES, type PlatformRole } from '../../../../../packages/authorization/src/index.js';
import { createTenantContextFromDomain, type TenantHostnameResolver } from '../../../../../packages/tenant-gateway/src/index.js';
import type { SqlDatabase } from '../../../../../packages/database/src/index.js';

export interface GatewayRequestAuthenticatorConfiguration {
  readonly hmacKey: string;
  readonly maximumClockSkewSeconds?: number;
  readonly now?: () => Date;
}

export class GatewayRequestAuthenticator {
  private readonly now: () => Date;
  private readonly maximumClockSkewSeconds: number;

  constructor(private readonly hostnameResolver: TenantHostnameResolver, private readonly controlDatabase: SqlDatabase, private readonly configuration: GatewayRequestAuthenticatorConfiguration) {
    if (configuration.hmacKey.length < 32) throw new Error('INTERNAL_GATEWAY_HMAC_KEY_TOO_SHORT');
    this.now = configuration.now ?? (() => new Date());
    this.maximumClockSkewSeconds = configuration.maximumClockSkewSeconds ?? 60;
  }

  async resolveTenantContext(request: Request): Promise<TenantContext> {
    const identity = await this.verifyGatewayIdentity(request, 'tenant');
    const domain = await this.hostnameResolver.resolve(request, identity.requestId);
    return createTenantContextFromDomain({ domain, subjectId: identity.subjectId, requestId: identity.requestId, authMethod: identity.authMethod });
  }

  async resolvePlatformContext(request: Request): Promise<PlatformContext> {
    const identity = await this.verifyGatewayIdentity(request, 'platform');
    const active = await this.controlDatabase.transaction(async (transaction) => transaction.query<{ readonly id: string }>(
      `select id from control.platform_subjects where id = $1 and status = 'active' limit 1`, [identity.subjectId],
    ));
    if (!active.rows[0]) throw new Error('PLATFORM_SUBJECT_NOT_PROVISIONED');
    return { subjectId: identity.subjectId, requestId: identity.requestId };
  }

  async platformRoles(context: PlatformContext): Promise<readonly PlatformRole[]> {
    const result = await this.controlDatabase.transaction(async (transaction) => transaction.query<{ readonly role_key: string }>(
      `select role_key from control.platform_role_assignments
        where platform_subject_id = $1 and revoked_at is null`, [context.subjectId],
    ));
    const allowed = new Set<string>(PLATFORM_ROLES);
    return result.rows.map((row) => row.role_key).filter((role): role is PlatformRole => allowed.has(role));
  }

  private async verifyGatewayIdentity(request: Request, audience: 'tenant' | 'platform'): Promise<{ readonly subjectId: string; readonly requestId: string; readonly authMethod: AuthMethod }> {
    const subjectId = requiredHeader(request, 'x-kommunsign-subject-id');
    const requestId = requiredHeader(request, 'x-request-id');
    const timestamp = requiredHeader(request, 'x-kommunsign-gateway-timestamp');
    const signature = requiredHeader(request, 'x-kommunsign-gateway-signature');
    const authMethod = requiredHeader(request, 'x-kommunsign-auth-method') as AuthMethod;
    const allowedMethods: readonly AuthMethod[] = ['oidc','saml','oauth2_client_credentials','mtls','session','magic_link','worker','trusted_service'];
    if (!allowedMethods.includes(authMethod)) throw new Error('GATEWAY_AUTH_METHOD_INVALID');
    if (!/^[0-9a-f-]{36}$/i.test(subjectId) || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('GATEWAY_IDENTITY_FORMAT_INVALID');
    const timestampNumber = Number(timestamp);
    if (!Number.isInteger(timestampNumber)) throw new Error('GATEWAY_TIMESTAMP_INVALID');
    const skew = Math.abs(Math.floor(this.now().getTime() / 1000) - timestampNumber);
    if (skew > this.maximumClockSkewSeconds) throw new Error('GATEWAY_SIGNATURE_EXPIRED');
    const url = new URL(request.url);
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? request.headers.get('host') ?? url.host;
    const payload = [audience, request.method.toUpperCase(), url.pathname, host.toLowerCase(), subjectId, requestId, authMethod, timestamp].join('\n');
    if (!(await verifyHmacSha256Hex(this.configuration.hmacKey, payload, signature))) throw new Error('GATEWAY_SIGNATURE_INVALID');
    return { subjectId, requestId, authMethod };
  }
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`GATEWAY_HEADER_MISSING:${name}`);
  return value;
}
