import type { TenantContext } from '../../../../packages/contracts/src/index.js';
import type { DownloadArtifact, UploadGrantInput } from '../ports.js';
import type { ObjectStorageAdapter } from '../production-adapters/postgres/infrastructure.js';

interface SignedUploadResponse {
  readonly url?: string;
  readonly signedURL?: string;
  readonly signedUrl?: string;
}

interface StorageConfiguration {
  readonly baseUrl: string;
  readonly serviceRoleKey: string;
  readonly applicationQuarantineBucket: string;
  readonly documentQuarantineBucket: string;
  readonly canonicalDocumentsBucket: string;
  readonly signedDocumentsBucket: string;
  readonly validationReportsBucket: string;
  readonly evidencePackagesBucket: string;
}

export function createObjectStorageAdapter(
  configuration: Readonly<Record<string, string>>,
): ObjectStorageAdapter {
  const settings: StorageConfiguration = {
    baseUrl: validateBaseUrl(required(configuration, 'SUPABASE_DATA_PROJECT_URL')),
    serviceRoleKey: required(configuration, 'SUPABASE_DATA_SERVICE_ROLE_KEY'),
    applicationQuarantineBucket: value(configuration, 'STORAGE_APPLICATION_QUARANTINE_BUCKET', 'application-quarantine'),
    documentQuarantineBucket: value(configuration, 'STORAGE_DOCUMENT_QUARANTINE_BUCKET', 'document-quarantine'),
    canonicalDocumentsBucket: value(configuration, 'STORAGE_CANONICAL_DOCUMENTS_BUCKET', 'canonical-documents'),
    signedDocumentsBucket: value(configuration, 'STORAGE_SIGNED_DOCUMENTS_BUCKET', 'signed-documents'),
    validationReportsBucket: value(configuration, 'STORAGE_VALIDATION_REPORTS_BUCKET', 'validation-reports'),
    evidencePackagesBucket: value(configuration, 'STORAGE_EVIDENCE_PACKAGES_BUCKET', 'evidence-packages'),
  };

  return {
    async provisionTenantNamespaces(input) {
      if (!/^[0-9a-f-]{36}$/i.test(input.tenantId)) throw new Error('STORAGE_TENANT_ID_INVALID');
      for (const bucket of input.bucketNames) {
        await ensurePrivateBucket(settings, validateBucketName(bucket));
      }
      return { namespaceReference: `supabase-storage://${input.tenantId}` };
    },

    async createUploadGrant(context, input) {
      assertTenantObject(context, input.objectKey);
      const bucket = settings.documentQuarantineBucket;
      await ensurePrivateBucket(settings, bucket);
      const response = await storageJson<SignedUploadResponse>(
        settings,
        'POST',
        `/object/upload/sign/${encodePath(`${bucket}/${input.objectKey}`)}`,
        {},
      );
      const relative = response.url ?? response.signedURL ?? response.signedUrl;
      if (!relative) throw new Error('STORAGE_SIGNED_UPLOAD_URL_MISSING');
      const uploadUrl = /^https?:\/\//i.test(relative)
        ? relative
        : `${settings.baseUrl}/storage/v1${relative.startsWith('/') ? '' : '/'}${relative}`;
      return {
        uploadUrl,
        requiredHeaders: {
          'content-type': input.mimeType,
          'x-upsert': 'false',
        },
      };
    },

    async headObject(context, objectKey) {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      const response = await fetch(
        `${settings.baseUrl}/storage/v1/object/authenticated/${encodePath(`${resolved.bucket}/${resolved.path}`)}`,
        { method: 'HEAD', headers: authorizationHeaders(settings) },
      );
      if (!response.ok) throw await storageError(response, 'STORAGE_HEAD_FAILED');
      const length = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('STORAGE_CONTENT_LENGTH_MISSING');
      const checksum = response.headers.get('x-checksum-sha256') ?? response.headers.get('x-amz-meta-sha256') ?? undefined;
      return { byteSize: length, ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type')! } : {}), ...(checksum && /^[0-9a-f]{64}$/.test(checksum) ? { sha256: checksum } : {}) };
    },

    async downloadObject(context, objectKey, metadata): Promise<DownloadArtifact> {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      const response = await fetch(
        `${settings.baseUrl}/storage/v1/object/authenticated/${encodePath(`${resolved.bucket}/${resolved.path}`)}`,
        { method: 'GET', headers: authorizationHeaders(settings) },
      );
      if (!response.ok) throw await storageError(response, 'STORAGE_DOWNLOAD_FAILED');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        contentType: metadata.contentType,
        fileName: metadata.fileName,
        ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}),
      };
    },

    async putObject(context, objectKey, bytes, contentType, immutable = true) {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      await ensurePrivateBucket(settings, resolved.bucket);
      const response = await fetch(`${settings.baseUrl}/storage/v1/object/${encodePath(`${resolved.bucket}/${resolved.path}`)}`, {
        method: 'POST',
        headers: { ...authorizationHeaders(settings), 'content-type': contentType, 'x-upsert': immutable ? 'false' : 'true' },
        body: bytes,
      });
      if (!response.ok) throw await storageError(response, 'STORAGE_UPLOAD_FAILED');
      return { byteSize: bytes.byteLength };
    },

    async deleteObject(context, objectKey) {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      const response = await fetch(`${settings.baseUrl}/storage/v1/object/${encodePath(`${resolved.bucket}/${resolved.path}`)}`, {
        method: 'DELETE', headers: authorizationHeaders(settings),
      });
      if (!response.ok && response.status !== 404) throw await storageError(response, 'STORAGE_DELETE_FAILED');
    },
  };
}

async function ensurePrivateBucket(settings: StorageConfiguration, bucket: string): Promise<void> {
  const existing = await fetch(`${settings.baseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
    method: 'GET',
    headers: authorizationHeaders(settings),
  });
  if (existing.ok) return;
  if (existing.status !== 400 && existing.status !== 404) {
    throw await storageError(existing, 'STORAGE_BUCKET_LOOKUP_FAILED');
  }
  const created = await fetch(`${settings.baseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authorizationHeaders(settings), 'content-type': 'application/json' },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  if (!created.ok && created.status !== 409) throw await storageError(created, 'STORAGE_BUCKET_CREATE_FAILED');
}

async function storageJson<T>(
  settings: StorageConfiguration,
  method: 'POST' | 'PUT' | 'GET',
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<T> {
  const response = await fetch(`${settings.baseUrl}/storage/v1${path}`, {
    method,
    headers: {
      ...authorizationHeaders(settings),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw await storageError(response, 'STORAGE_API_REQUEST_FAILED');
  return await response.json() as T;
}

function resolveBucket(
  settings: StorageConfiguration,
  objectKey: string,
): { readonly bucket: string; readonly path: string } {
  const explicit = /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9]):\/\/(.+)$/.exec(objectKey);
  if (explicit?.[1] && explicit[2]) return { bucket: validateBucketName(explicit[1]), path: explicit[2] };
  if (objectKey.includes('/signed/')) return { bucket: settings.signedDocumentsBucket, path: objectKey };
  if (objectKey.includes('/validation/')) return { bucket: settings.validationReportsBucket, path: objectKey };
  if (objectKey.includes('/evidence/')) return { bucket: settings.evidencePackagesBucket, path: objectKey };
  if (objectKey.includes('/canonical/')) return { bucket: settings.canonicalDocumentsBucket, path: objectKey };
  if (objectKey.includes('/application-quarantine/')) return { bucket: settings.applicationQuarantineBucket, path: objectKey };
  return { bucket: settings.documentQuarantineBucket, path: objectKey };
}

function assertTenantObject(context: TenantContext, objectKey: string): void {
  if (!objectKey.startsWith(`${context.tenantId}/`) && !objectKey.includes(`://${context.tenantId}/`)) {
    throw new Error('STORAGE_OBJECT_TENANT_MISMATCH');
  }
  if (objectKey.includes('..') || objectKey.includes('\\') || objectKey.includes('\u0000')) {
    throw new Error('STORAGE_OBJECT_KEY_INVALID');
  }
}

function authorizationHeaders(settings: StorageConfiguration): Readonly<Record<string, string>> {
  return {
    apikey: settings.serviceRoleKey,
    authorization: `Bearer ${settings.serviceRoleKey}`,
  };
}

async function storageError(response: Response, code: string): Promise<Error> {
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('sb-request-id');
  const detail = (await response.text()).replace(/[^\x20-\x7E]/g, '').slice(0, 300);
  return new Error(`${code}:${response.status}${requestId ? `:${requestId}` : ''}${detail ? `:${detail}` : ''}`);
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function validateBucketName(bucket: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('STORAGE_BUCKET_NAME_INVALID');
  return bucket;
}

function validateBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('SUPABASE_DATA_PROJECT_URL_HTTPS_REQUIRED');
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function required(configuration: Readonly<Record<string, string>>, name: string): string {
  const result = configuration[name]?.trim();
  if (!result) throw new Error(`${name}_MISSING`);
  return result;
}

function value(configuration: Readonly<Record<string, string>>, name: string, fallback: string): string {
  return validateBucketName(configuration[name]?.trim() || fallback);
}
