declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
import { createApiHandler } from './router.js';
import type { ApiDependencies } from './ports.js';

export interface ProductionRuntimeConfiguration {
  readonly controlDatabaseUrl: string;
  readonly dataDatabaseUrl: string;
  readonly objectStorageEndpoint?: string;
  readonly queueEndpoint?: string;
  readonly environment: 'production';
}

interface ProductionAdapterModule {
  readonly createProductionDependencies?: (configuration: ProductionRuntimeConfiguration) => Promise<ApiDependencies> | ApiDependencies;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function assertProductionDependencies(dependencies: ApiDependencies): void {
  if (!dependencies.onboarding) throw new Error('PRODUCTION_ONBOARDING_REPOSITORY_MISSING');
  if (!dependencies.resolvePlatformContext || !dependencies.authorizePlatform) throw new Error('PRODUCTION_PLATFORM_AUTH_MISSING');
  if (!dependencies.resolveContext || !dependencies.authorize) throw new Error('PRODUCTION_TENANT_AUTH_MISSING');
  for (const key of ['cases','uploads','webhooks','events','templates'] as const) {
    if (!dependencies[key]) throw new Error(`PRODUCTION_${key.toUpperCase()}_REPOSITORY_MISSING`);
  }
}

export async function createHandler(): Promise<(request: Request) => Promise<Response>> {
  if (process.env.APP_ENV !== 'production') throw new Error('PRODUCTION_RUNTIME_REQUIRES_PRODUCTION_ENV');
  const moduleName = process.env.KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE?.trim() || './production-adapters/postgres/index.js';
  if (moduleName.includes('dev-runtime') || moduleName.includes('dev-onboarding')) throw new Error('DEVELOPMENT_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  const configuration: ProductionRuntimeConfiguration = {
    controlDatabaseUrl: requiredEnvironment('CONTROL_DATABASE_URL'),
    dataDatabaseUrl: requiredEnvironment('DATA_DATABASE_URL'),
    ...(process.env.OBJECT_STORAGE_ENDPOINT?.trim() ? { objectStorageEndpoint: process.env.OBJECT_STORAGE_ENDPOINT.trim() } : {}),
    ...(process.env.QUEUE_ENDPOINT?.trim() ? { queueEndpoint: process.env.QUEUE_ENDPOINT.trim() } : {}),
    environment: 'production',
  };
  const adapter = await import(moduleName) as ProductionAdapterModule;
  if (typeof adapter.createProductionDependencies !== 'function') throw new Error('PRODUCTION_ADAPTER_EXPORT_MISSING');
  const dependencies = await adapter.createProductionDependencies(configuration);
  assertProductionDependencies(dependencies);
  return createApiHandler(dependencies);
}
