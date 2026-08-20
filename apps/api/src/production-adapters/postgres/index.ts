declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
import { requirePermission, requirePlatformPermission, type TenantRole } from '../../../../../packages/authorization/src/index.js';
import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { TenantHostnameResolver } from '../../../../../packages/tenant-gateway/src/index.js';
import type { ApiDependencies, MetricsEndpoint } from '../../ports.js';
import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { ProductionRuntimeConfiguration } from '../../production-runtime.js';
import { createDataRepositories } from './data-database.js';
import { createRetentionRepository } from './retention-repository.js';
import { createPrivacyRepository } from './privacy-repository.js';
import { createScimRepository } from './scim-repository.js';
import { createFederationRepository } from './federation-repository.js';
import { createMetricsRepository } from './metrics-repository.js';
import { createDeliveryRepository } from './delivery-repository.js';
import { renderPrometheus } from '../../../../../packages/observability/src/prometheus.js';
import { ValidationServiceClient } from '../../../../../packages/validation-client/src/index.js';
import { withKeysetListRepositories } from './keyset-repositories.js';
import { createDomainRepository } from './domain-repository.js';
import { loadProductionInfrastructure } from './infrastructure.js';
import { createOnboardingRepository } from './onboarding-repository.js';
import { createPublicRepositories } from './public-signing-repository.js';
import { GatewayRequestAuthenticator } from './request-auth.js';
import { createPostgresDatabase } from './sql-database.js';
import { createTenantRepository } from './tenant-repository.js';
import { createAuthenticationRepository } from './authentication-repository.js';
import { productionAuthTimingSink, TimedSupabaseAuthProvider, withAuthenticationOperationTiming, withAuthenticationSqlTiming } from './authentication-observability.js';
import { createSigningSourceUploadRepository } from './signing-source-upload-repository.js';

// authorize() resolves the subject's roles with a four-table join inside its own tenant
// transaction. A route that checks two permissions (add-signer, then the personnummer exemption)
// therefore paid for that join twice, and the second answer is identical to the first.
//
// The memo is keyed on requestId, which is unique per request, so a later request never sees a
// cached answer and role revocation takes effect immediately — unlike a TTL cache. Entries are
// evicted in insertion order past a fixed ceiling, so a long-lived process cannot grow this map.
const MAXIMUM_MEMOISED_REQUESTS = 512;
export function createRoleMemo(
  load: (context: TenantContext) => Promise<readonly TenantRole[]>,
): (context: TenantContext) => Promise<readonly TenantRole[]> {
  const byRequest = new Map<string, Promise<readonly TenantRole[]>>();
  return (context) => {
    const key = `${context.requestId}\u0000${context.tenantId}\u0000${context.subjectId}`;
    const memoised = byRequest.get(key);
    if (memoised) return memoised;
    const roles = load(context);
    byRequest.set(key, roles);
    if (byRequest.size > MAXIMUM_MEMOISED_REQUESTS) {
      const oldest = byRequest.keys().next();
      if (!oldest.done) byRequest.delete(oldest.value);
    }
    // A failed lookup must not be remembered as a decision.
    void roles.catch(() => { byRequest.delete(key); });
    return roles;
  };
}

export async function createProductionDependencies(configuration: ProductionRuntimeConfiguration): Promise<ApiDependencies> {
  const controlDatabase = await createPostgresDatabase(configuration.controlDatabaseUrl, 'kommunsign-control-api');
  const dataDatabase = await createPostgresDatabase(configuration.dataDatabaseUrl, 'kommunsign-data-api');
  try {
    const infrastructure = await loadProductionInfrastructure(process.env);
    const data = withKeysetListRepositories(dataDatabase, createDataRepositories(dataDatabase, infrastructure));
    const signingSourceUploads = createSigningSourceUploadRepository(dataDatabase, infrastructure);
    const publicRepositories = createPublicRepositories(dataDatabase, infrastructure, process.env);
    const domains = createDomainRepository(controlDatabase);
    const resolver = new TenantHostnameResolver(domains, {
      trustProxy: booleanEnvironment('TRUST_PROXY', true),
      trustedProxyProvider: proxyProvider(),
      requireVerifiedForwardedHost: booleanEnvironment('REQUIRE_VERIFIED_FORWARDED_HOST', true),
      cacheTtlMs: integerEnvironment('DOMAIN_RESOLUTION_CACHE_TTL_MS', 30_000, 1_000, 300_000),
    });
    const authenticator = new GatewayRequestAuthenticator(resolver, controlDatabase, {
      hmacKey: requiredEnvironment('INTERNAL_GATEWAY_HMAC_KEY'),
      maximumClockSkewSeconds: integerEnvironment('INTERNAL_GATEWAY_MAX_CLOCK_SKEW_SECONDS', 60, 5, 300),
    });
    const tenants = createTenantRepository(dataDatabase);
    const rolesForRequest = createRoleMemo((context) => tenants.rolesForSubject(context));
    const authTiming = productionAuthTimingSink();
    const authentication = withAuthenticationOperationTiming(createAuthenticationRepository(
      withAuthenticationSqlTiming(controlDatabase, authTiming, 'control'),
      withAuthenticationSqlTiming(dataDatabase, authTiming, 'data'),
      infrastructure,
      new TimedSupabaseAuthProvider({
        projectUrl: requiredEnvironment('SUPABASE_AUTH_PROJECT_URL'),
        anonKey: requiredEnvironment('SUPABASE_AUTH_ANON_KEY'),
        serviceRoleKey: requiredEnvironment('SUPABASE_AUTH_SERVICE_ROLE_KEY'),
        requestTimeoutMs: integerEnvironment('SUPABASE_AUTH_REQUEST_TIMEOUT_MS', 10_000, 1_000, 60_000),
      }, authTiming),
      {
        rootDomain: requiredEnvironment('KOMMUNSIGN_ROOT_DOMAIN'),
        platformAdminHostname: new URL(requiredEnvironment('PLATFORM_ADMIN_URL')).hostname,
        tenantDiscoveryHostname: new URL(requiredEnvironment('TENANT_DISCOVERY_URL')).hostname,
        authPortalUrl: requiredEnvironment('AUTH_BROKER_URL'),
        sessionLifetimeSeconds: integerEnvironment('SESSION_COOKIE_MAX_AGE_SECONDS', 28_800, 900, 86_400),
      },
    ), authTiming);
    return {
      ...data,
      retention: createRetentionRepository(dataDatabase),
      privacy: createPrivacyRepository(dataDatabase, infrastructure.sensitiveData),
      scim: createScimRepository(dataDatabase, infrastructure.sensitiveData),
      federation: createFederationRepository(controlDatabase),
      ...federationVerification(controlDatabase),
      delivery: createDeliveryRepository(dataDatabase),
      ...metricsEndpoint(controlDatabase, dataDatabase),
      uploads: signingSourceUploads,
      ...publicRepositories,
      onboarding: createOnboardingRepository(controlDatabase, infrastructure),
      authentication,
      resolveContext: (request) => authenticator.resolveTenantContext(request),
      authorize: async (context, permission) => requirePermission(await rolesForRequest(context), permission),
      resolvePlatformContext: (request) => authenticator.resolvePlatformContext(request),
      authorizePlatform: async (context, permission) => requirePlatformPermission(await authenticator.platformRoles(context), permission),
      databaseTiming: postgresTimingSnapshot,
      reportError(cause, requestId) {
        const name = cause instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(cause.name) ? cause.name : 'UnknownError';
        const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/.test(cause.message) ? cause.message : 'INTERNAL_REQUEST_FAILURE';
        console.error(JSON.stringify({ level: 'error', service: 'kommunsign-api', requestId, name, code, ...safePostgresMetadata(cause) }));
      },
    };
  } catch (cause) {
    await Promise.allSettled([controlDatabase.close(), dataDatabase.close()]);
    throw cause;
  }
}

function safePostgresMetadata(cause: unknown): Readonly<Record<string, string>> {
  if (!cause || typeof cause !== 'object') return {};
  const source = cause as Readonly<Record<string, unknown>>;
  const fields: readonly (readonly [string, string])[] = [
    ['code', 'sqlState'], ['schema_name', 'databaseSchema'], ['table_name', 'databaseTable'],
    ['column_name', 'databaseColumn'], ['constraint_name', 'databaseConstraint'], ['routine', 'databaseRoutine'],
  ];
  const result: Record<string, string> = {};
  for (const [sourceKey, targetKey] of fields) {
    const value = source[sourceKey];
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value)) result[targetKey] = value;
  }
  return result;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name}_INVALID`);
}
function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name]?.trim();
  const parsed = value ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}_INVALID`);
  return parsed;
}
function proxyProvider(): 'vercel' | 'cloudflare' | 'railway' | 'none' {
  const value = (process.env.TRUSTED_PROXY_PROVIDER ?? 'vercel').trim().toLowerCase();
  if (value === 'vercel' || value === 'cloudflare' || value === 'railway' || value === 'none') return value;
  throw new Error('TRUSTED_PROXY_PROVIDER_INVALID');
}

export { createPostgresDatabase, type PostgresDatabase } from './sql-database.js';
import { postgresTimingSnapshot } from './sql-database.js';
export { createDomainRepository } from './domain-repository.js';
export { createDomainManagementRepository } from './domain-management-repository.js';
export { createTenantRepository } from './tenant-repository.js';
export { createAuthenticationRepository } from './authentication-repository.js';
export { createOnboardingRepository } from './onboarding-repository.js';
export { createProvisioningRepository } from './provisioning-repository.js';
export { createApplicationSessionRepository } from './application-session-repository.js';
export { createIdentityProviderRepository } from './identity-provider-repository.js';
export { createSignatureCaseRepository } from './signature-case-repository.js';
export { createDocumentRepository } from './document-repository.js';
export { createEventRepository } from './event-repository.js';
export { createWebhookRepository } from './webhook-repository.js';
export { createReadinessRepository } from './readiness-repository.js';
export { createActivationRepository } from './activation-repository.js';
export { createPublicRepositories } from './public-signing-repository.js';


/**
 * The scrape endpoint, when a credential is configured.
 *
 * Absent rather than open by default: an accidentally public /metrics leaks
 * cross-tenant operational state, and nothing about the deployment looks wrong
 * while it does.
 */
export function createScrapeMemo(
  render: (now: Date) => Promise<string>,
  ttlMilliseconds: number,
  clock: () => number = Date.now,
): (now: Date) => Promise<string> {
  let cached: { readonly renderedAt: number; readonly body: Promise<string> } | null = null;
  return (now) => {
    if (cached && clock() - cached.renderedAt < ttlMilliseconds) return cached.body;
    const body = render(now);
    cached = { renderedAt: clock(), body };
    // A failed scrape must not be served for the rest of the window.
    void body.catch(() => { cached = null; });
    return body;
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('METRICS_CACHE_TTL_MS_INVALID');
  return parsed;
}

function metricsEndpoint(controlDatabase: SqlDatabase, dataDatabase: SqlDatabase): { readonly metrics?: MetricsEndpoint } {
  const scrapeToken = process.env.METRICS_SCRAPE_TOKEN ?? '';
  if (scrapeToken.length < 32) return {};
  const repository = createMetricsRepository(controlDatabase, dataDatabase);
  // Reporting a backup needs its own credential, and a deployment that has not
  // set one simply has no ingest route rather than an unauthenticated one.
  const ingestToken = process.env.BACKUP_SIGNAL_TOKEN ?? '';
  // collect() runs eleven separate transactions, several of them unbounded aggregates over
  // append-only tables, and it ran in full on every scrape. Prometheus scrapes on a fixed interval
  // and its alert rules compare against time(), so a gauge that is a few seconds old changes no
  // alerting decision -- but re-deriving it on every scrape costs the databases a scan apiece,
  // forever, growing with total platform history.
  //
  // The memo also collapses concurrent scrapes: an HA Prometheus pair, or a scrape arriving while
  // the previous one is still running, now shares a single collect instead of doubling the load.
  const scrape = createScrapeMemo(
    async (now: Date) => {
      const { counters, gauges } = await repository.collect(now);
      return renderPrometheus(counters, gauges);
    },
    boundedInteger(process.env.METRICS_CACHE_TTL_MS, 10_000, 0, 60_000),
  );
  return {
    metrics: {
      scrapeToken,
      async render(now: Date) {
        return scrape(now);
      },
      ...(ingestToken.length >= 32 ? {
        ingestToken,
        recordBackupCompletion: (input) => repository.recordBackupCompletion(input),
      } : {}),
    },
  };
}


/**
 * Signature verification and trust material for federated login.
 *
 * Both are absent unless configured, and the router fails closed on either
 * being missing. That is the right default: a federation endpoint that accepts
 * an assertion it cannot verify against a known certificate is an
 * authentication bypass, and it looks like a working login while it is one.
 */
function federationVerification(controlDatabase: SqlDatabase): {
  readonly federationValidation?: NonNullable<ApiDependencies['federationValidation']>;
  readonly federationTrust?: NonNullable<ApiDependencies['federationTrust']>;
} {
  const baseUrl = process.env.VALIDATION_SERVICE_URL ?? '';
  const serviceToken = process.env.VALIDATION_SERVICE_TOKEN ?? '';
  if (!baseUrl || !serviceToken) return {};
  const client = new ValidationServiceClient(baseUrl, serviceToken);

  return {
    federationValidation: {
      validateSaml: (input) => client.validateSaml(input),
      validateOidc: (input) => client.validateOidc(input),
    },
    async federationTrust(_config, tenantId) {
      // Read at use rather than cached: rotating an IdP certificate must take
      // effect on the next login, not on the next deploy.
      const result = await controlDatabase.transaction(async (tx) => tx.query<{ readonly certificate_base64: string | null }>(
        `select public_configuration->>'signingCertificateBase64' certificate_base64
           from control.tenant_identity_providers
          where tenant_id=$1 and enabled=true
          order by environment limit 1`,
        [tenantId],
      ));
      return result.rows[0]?.certificate_base64 ?? null;
    },
  };
}
