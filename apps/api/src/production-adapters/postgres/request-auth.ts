import { verifyHmacSha256Hex } from '../../../../../packages/crypto/src/hmac.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import type { AuthMethod, PlatformContext, TenantContext } from '../../../../../packages/contracts/src/index.js';
import { PLATFORM_ROLES, type PlatformRole } from '../../../../../packages/authorization/src/index.js';
import { createTenantContextFromDomain, type TenantHostnameResolver } from '../../../../../packages/tenant-gateway/src/index.js';
import { canonicalHostname } from '../../../../../packages/custom-domains/src/index.js';
import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import { sessionTokenFromRequest } from './authentication-repository.js';

export interface GatewayRequestAuthenticatorConfiguration {
  readonly hmacKey: string;
  readonly maximumClockSkewSeconds?: number;
  readonly now?: () => Date;
}

interface BrowserSessionIdentity {
  readonly subjectId: string;
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly boundary: 'tenant' | 'platform';
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
    const browser = await this.browserSession(request, 'tenant');
    if (browser) {
      if (!browser.tenantId) throw new Error('AUTH_TENANT_CONTEXT_MISSING');
      return { tenantId: browser.tenantId, subjectId: browser.subjectId, requestId: browser.requestId, authMethod: 'session', source: 'membership' };
    }
    const identity = await this.verifyGatewayIdentity(request, 'tenant');
    const domain = await this.hostnameResolver.resolve(request, identity.requestId);
    return createTenantContextFromDomain({ domain, subjectId: identity.subjectId, requestId: identity.requestId, authMethod: identity.authMethod });
  }

  async resolvePlatformContext(request: Request): Promise<PlatformContext> {
    const browser = await this.browserSession(request, 'platform');
    const identity = browser ?? await this.verifyGatewayIdentity(request, 'platform');
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

  private async browserSession(request: Request, boundary: 'tenant' | 'platform'): Promise<BrowserSessionIdentity | null> {
    const token = sessionTokenFromRequest(request);
    if (!token) return null;
    const origin = request.headers.get('origin');
    if (!origin) throw new Error('AUTH_ORIGIN_REQUIRED');
    let originHostname: string;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error('invalid');
      originHostname = canonicalHostname(parsed.hostname, { allowPlatformNamespace: true });
    } catch {
      throw new Error('AUTH_ORIGIN_INVALID');
    }
    const requestId = request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
    const tokenHash = await sha256Hex(token);
    const mutating = ['POST','PATCH','PUT','DELETE'].includes(request.method.toUpperCase());
    const csrf = request.headers.get('x-csrf-token')?.trim();
    const csrfHash = csrf ? await sha256Hex(csrf) : null;
    const result = await this.controlDatabase.transaction(async (transaction) => transaction.query<{
      readonly tenant_id: string | null;
      readonly boundary: 'tenant' | 'platform';
      readonly hostname: string;
      readonly subject_id: string;
    }>(
      // Validating a session used to be an UPDATE, so every authenticated request wrote a row:
      // WAL, a dead tuple and vacuum pressure per request, and no possibility of ever serving these
      // reads from a replica. The matched CTE carries exactly the predicates the UPDATE had -- token,
      // boundary, hostname, revocation, expiry and the CSRF check on mutating requests -- so the
      // authentication decision is byte for byte the one it made before. Only the last_seen_at write
      // changed: it now happens at most once a minute per session rather than on every request.
      `with matched as (
         select token_hash,tenant_id,boundary,hostname,subject_id,last_seen_at
           from control.host_bound_sessions
          where token_hash=decode($1,'hex')
            and boundary=$2
            and hostname=$3
            and revoked_at is null
            and expires_at>now()
            and ($4::boolean=false or ($5::text is not null and csrf_token_hash=decode($5,'hex')))
       ), touched as (
         update control.host_bound_sessions s
            set last_seen_at=now()
           from matched m
          where s.token_hash=m.token_hash
            and (m.last_seen_at is null or m.last_seen_at < now() - interval '60 seconds')
       )
       select tenant_id,boundary,hostname,subject_id from matched`,
      [tokenHash, boundary, originHostname, mutating, csrfHash],
    ));
    const row = result.rows[0];
    if (!row) throw new Error(mutating && !csrf ? 'CSRF_TOKEN_REQUIRED' : 'AUTH_SESSION_INVALID');
    return { subjectId: row.subject_id, requestId, tenantId: row.tenant_id, boundary: row.boundary };
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
