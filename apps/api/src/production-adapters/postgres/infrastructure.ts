import type { DownloadArtifact, UploadGrantInput } from '../../ports.js';
import type { TenantContext } from '../../../../../packages/contracts/src/index.js';

export interface ObjectStorageAdapter {
  provisionTenantNamespaces(input: { readonly tenantId: string; readonly bucketNames: readonly string[]; readonly idempotencyKey: string }): Promise<{ readonly namespaceReference: string }>;
  createUploadGrant(context: TenantContext, input: UploadGrantInput & { readonly objectKey: string; readonly expiresAt: string }): Promise<{ readonly uploadUrl: string; readonly requiredHeaders: Readonly<Record<string, string>> }>;
  headObject(context: TenantContext, objectKey: string): Promise<{ readonly byteSize: number; readonly contentType?: string; readonly sha256?: string }>;
  downloadObject(context: TenantContext, objectKey: string, metadata: { readonly contentType: string; readonly fileName: string; readonly sha256?: string }): Promise<DownloadArtifact>;
  putObject?(context: TenantContext, objectKey: string, bytes: Uint8Array, contentType: string, immutable?: boolean): Promise<{ readonly byteSize: number; readonly sha256?: string }>;
  deleteObject?(context: TenantContext, objectKey: string): Promise<void>;
}
export interface SensitiveDataAdapter {
  encryptText(value: string, purpose: string): Promise<Uint8Array>;
  decryptText(value: Uint8Array, purpose: string): Promise<string>;
  blindIndex(value: string, purpose: string): Promise<Uint8Array>;
}
export interface QueueAdapter {
  enqueue(input: { readonly tenantId: string; readonly jobType: string; readonly idempotencyKey: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<{ readonly jobId: string }>;
}

export interface ProductionInfrastructure { readonly objectStorage: ObjectStorageAdapter; readonly queue: QueueAdapter; readonly sensitiveData: SensitiveDataAdapter; }

interface InfrastructureModule { readonly createObjectStorageAdapter?: (configuration: Readonly<Record<string, string>>) => Promise<ObjectStorageAdapter> | ObjectStorageAdapter; readonly createQueueAdapter?: (configuration: Readonly<Record<string, string>>) => Promise<QueueAdapter> | QueueAdapter; readonly createSensitiveDataAdapter?: (configuration: Readonly<Record<string, string>>) => Promise<SensitiveDataAdapter> | SensitiveDataAdapter; }

export async function loadProductionInfrastructure(environment: Readonly<Record<string, string | undefined>>): Promise<ProductionInfrastructure> {
  const storageModule = required(environment, 'KOMMUNSIGN_OBJECT_STORAGE_ADAPTER_MODULE');
  const queueModule = required(environment, 'KOMMUNSIGN_QUEUE_ADAPTER_MODULE');
  const sensitiveDataModule = required(environment, 'KOMMUNSIGN_SENSITIVE_DATA_ADAPTER_MODULE');
  const [storage, queue, sensitiveData] = await Promise.all([load(storageModule), load(queueModule), load(sensitiveDataModule)]);
  if (typeof storage.createObjectStorageAdapter !== 'function') throw new Error('OBJECT_STORAGE_ADAPTER_EXPORT_MISSING');
  if (typeof queue.createQueueAdapter !== 'function') throw new Error('QUEUE_ADAPTER_EXPORT_MISSING');
  if (typeof sensitiveData.createSensitiveDataAdapter !== 'function') throw new Error('SENSITIVE_DATA_ADAPTER_EXPORT_MISSING');
  const configuration = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { objectStorage: await storage.createObjectStorageAdapter(configuration), queue: await queue.createQueueAdapter(configuration), sensitiveData: await sensitiveData.createSensitiveDataAdapter(configuration) };
}

async function load(moduleName: string): Promise<InfrastructureModule> {
  if (moduleName.includes('dev') || moduleName.includes('memory')) throw new Error('DEVELOPMENT_INFRASTRUCTURE_FORBIDDEN_IN_PRODUCTION');
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<InfrastructureModule>;
  return dynamicImport(moduleName);
}
function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
