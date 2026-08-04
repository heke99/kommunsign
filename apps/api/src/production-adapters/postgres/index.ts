declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
import { requirePermission, requirePlatformPermission } from '../../../../../packages/authorization/src/index.js';
import { TenantHostnameResolver } from '../../../../../packages/tenant-gateway/src/index.js';
import type { ApiDependencies } from '../../ports.js';
import type { ProductionRuntimeConfiguration } from '../../production-runtime.js';
import { createDataRepositories } from './data-database.js';
import { createDomainRepository } from './domain-repository.js';
import { loadProductionInfrastructure } from './infrastructure.js';
import { createOnboardingRepository } from './onboarding-repository.js';
import { createPublicRepositories } from './public-signing-repository.js';
import { GatewayRequestAuthenticator } from './request-auth.js';
import { createPostgresDatabase } from './sql-database.js';
import { createTenantRepository } from './tenant-repository.js';
import { createAuthenticationRepository } from './authentication-repository.js';
import { SupabaseAuthProvider } from '../../../../../packages/provider-adapters/src/supabase-auth.js';

export async function createProductionDependencies(configuration: ProductionRuntimeConfiguration): Promise<ApiDependencies> {
  const controlDatabase = await createPostgresDatabase(configuration.controlDatabaseUrl, 'kommunsign-control-api');
  const dataDatabase = await createPostgresDatabase(configuration.dataDatabaseUrl, 'kommunsign-data-api');
  try {
    const infrastructure = await loadProductionInfrastructure(process.env);
    const data = createDataRepositories(dataDatabase, infrastructure);
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
    const authentication = createAuthenticationRepository(
      controlDatabase,
      dataDatabase,
      infrastructure,
      new SupabaseAuthProvider({
        projectUrl: requiredEnvironment('SUPABASE_AUTH_PROJECT_URL'),
        anonKey: requiredEnvironment('SUPABASE_AUTH_ANON_KEY'),
        serviceRoleKey: requiredEnvironment('SUPABASE_AUTH_SERVICE_ROLE_KEY'),
        requestTimeoutMs: integerEnvironment('SUPABASE_AUTH_REQUEST_TIMEOUT_MS', 10_000, 1_000, 60_000),
      }),
      {
        rootDomain: requiredEnvironment('KOMMUNSIGN_ROOT_DOMAIN'),
        platformAdminHostname: new URL(requiredEnvironment('PLATFORM_ADMIN_URL')).hostname,
        tenantDiscoveryHostname: new URL(requiredEnvironment('TENANT_DISCOVERY_URL')).hostname,
        authPortalUrl: requiredEnvironment('AUTH_BROKER_URL'),
        sessionLifetimeSeconds: integerEnvironment('SESSION_COOKIE_MAX_AGE_SECONDS', 28_800, 900, 86_400),
      },
    );
    return {
      ...data,
      ...publicRepositories,
      onboarding: createOnboardingRepository(controlDatabase, infrastructure),
      authentication,
      resolveContext: (request) => authenticator.resolveTenantContext(request),
      authorize: async (context, permission) => requirePermission(await tenants.rolesForSubject(context), permission),
      resolvePlatformContext: (request) => authenticator.resolvePlatformContext(request),
      authorizePlatform: async (context, permission) => requirePlatformPermission(await authenticator.platformRoles(context), permission),
      reportError(cause, requestId) {
        const name = cause instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(cause.name) ? cause.name : 'UnknownError';
        const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/.test(cause.message) ? cause.message : 'INTERNAL_REQUEST_FAILURE';
        console.error(JSON.stringify({ level: 'error', service: 'kommunsign-api', requestId, name, code }));
      },
    };
  } catch (cause) {
    await Promise.allSettled([controlDatabase.close(), dataDatabase.close()]);
    throw cause;
  }
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
