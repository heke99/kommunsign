import type { TenantContext } from '../../../../packages/contracts/src/index.js';
import type { DownloadArtifact } from '../ports.js';
import type { ObjectStorageAdapter } from '../production-adapters/postgres/infrastructure.js';

/**
 * Object storage over the S3 API.
 *
 * This exists because the only storage adapter in the repository spoke Supabase
 * Storage, while the compose file has run a MinIO the whole time that nothing
 * could reach. A deployment that is not on Supabase — the self-hosted one a
 * municipality may well require, and the one the local stack actually is — had
 * no object storage path at all, which is where the canonical PDF lives and so
 * where the signing chain begins.
 *
 * Requests are signed with SigV4 built on WebCrypto. The repository carries two
 * npm dependencies in total and no AWS SDK; adding one to compute an HMAC would
 * cost more in supply chain than the code below.
 *
 * Server-side encryption is requested on every write. If the backend does not
 * honour it the object is still stored, so this is a request and not a
 * guarantee — the guarantee for document confidentiality is the private bucket
 * plus the tenant-bound key, both of which are enforced here.
 */

interface S3Configuration {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathStyle: boolean;
  readonly serverSideEncryption: string | null;
  readonly applicationQuarantineBucket: string;
  readonly documentQuarantineBucket: string;
  readonly canonicalDocumentsBucket: string;
  readonly signedDocumentsBucket: string;
  readonly validationReportsBucket: string;
  readonly evidencePackagesBucket: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** Anything longer is not honoured by S3, and an expiry that never lands is not a grant. */
const MAX_GRANT_SECONDS = 7 * 24 * 60 * 60;

export function createObjectStorageAdapter(
  configuration: Readonly<Record<string, string>>,
): ObjectStorageAdapter {
  const settings: S3Configuration = {
    endpoint: validateEndpoint(required(configuration, 'S3_ENDPOINT')),
    region: required(configuration, 'S3_REGION'),
    accessKeyId: required(configuration, 'S3_ACCESS_KEY_ID'),
    secretAccessKey: required(configuration, 'S3_SECRET_ACCESS_KEY'),
    // Path style is the default because it is what MinIO and most S3-compatible
    // backends serve without wildcard DNS. AWS itself accepts both.
    pathStyle: (configuration['S3_FORCE_PATH_STYLE'] ?? 'true').trim() !== 'false',
    serverSideEncryption: configuration['S3_SERVER_SIDE_ENCRYPTION']?.trim() || null,
    applicationQuarantineBucket: bucketSetting(configuration, 'STORAGE_APPLICATION_QUARANTINE_BUCKET', 'application-quarantine'),
    documentQuarantineBucket: bucketSetting(configuration, 'STORAGE_DOCUMENT_QUARANTINE_BUCKET', 'document-quarantine'),
    canonicalDocumentsBucket: bucketSetting(configuration, 'STORAGE_CANONICAL_DOCUMENTS_BUCKET', 'canonical-documents'),
    signedDocumentsBucket: bucketSetting(configuration, 'STORAGE_SIGNED_DOCUMENTS_BUCKET', 'signed-documents'),
    validationReportsBucket: bucketSetting(configuration, 'STORAGE_VALIDATION_REPORTS_BUCKET', 'validation-reports'),
    evidencePackagesBucket: bucketSetting(configuration, 'STORAGE_EVIDENCE_PACKAGES_BUCKET', 'evidence-packages'),
  };

  return {
    async provisionTenantNamespaces(input) {
      if (!/^[0-9a-f-]{36}$/i.test(input.tenantId)) throw new Error('STORAGE_TENANT_ID_INVALID');
      for (const bucket of input.bucketNames) {
        await ensurePrivateBucket(settings, validateBucketName(bucket));
      }
      return { namespaceReference: `s3://${settings.endpoint.replace(/^https?:\/\//, '')}/${input.tenantId}` };
    },

    async createUploadGrant(context, input) {
      assertTenantObject(context, input.objectKey);
      const bucket = settings.documentQuarantineBucket;
      await ensurePrivateBucket(settings, bucket);
      return {
        uploadUrl: await presignPut(settings, bucket, input.objectKey, input.expiresAt),
        requiredHeaders: { 'content-type': input.mimeType },
      };
    },

    async headObject(context, objectKey) {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      const response = await signedRequest(settings, 'HEAD', resolved.bucket, resolved.path);
      if (!response.ok) throw await storageError(response, 'STORAGE_HEAD_FAILED');
      const length = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('STORAGE_CONTENT_LENGTH_MISSING');
      const contentType = response.headers.get('content-type');
      const checksum = base64ChecksumToHex(response.headers.get('x-amz-checksum-sha256'))
        ?? response.headers.get('x-amz-meta-sha256');
      return {
        byteSize: length,
        ...(contentType ? { contentType } : {}),
        ...(checksum && /^[0-9a-f]{64}$/.test(checksum) ? { sha256: checksum } : {}),
      };
    },

    async downloadObject(context, objectKey, metadata): Promise<DownloadArtifact> {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      const response = await signedRequest(settings, 'GET', resolved.bucket, resolved.path);
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
      const digest = await sha256Hex(bytes);
      const response = await signedRequest(settings, 'PUT', resolved.bucket, resolved.path, {
        body: bytes,
        payloadSha256: digest,
        headers: {
          'content-type': contentType,
          'x-amz-meta-sha256': digest,
          ...(settings.serverSideEncryption ? { 'x-amz-server-side-encryption': settings.serverSideEncryption } : {}),
          // A signed document is written once. Letting a retry or a second
          // worker overwrite it would destroy the only copy of a signature.
          ...(immutable ? { 'if-none-match': '*' } : {}),
        },
      });
      // 412 is the backend telling us the object was already there. For an
      // immutable write that is the guarantee working, not a fault, but the
      // caller must not be told the bytes it holds are what is stored.
      if (response.status === 412) throw new Error('STORAGE_OBJECT_ALREADY_EXISTS');
      if (!response.ok) throw await storageError(response, 'STORAGE_UPLOAD_FAILED');
      return { byteSize: bytes.byteLength, sha256: digest };
    },

    async deleteObject(context, objectKey) {
      assertTenantObject(context, objectKey);
      const resolved = resolveBucket(settings, objectKey);
      const response = await signedRequest(settings, 'DELETE', resolved.bucket, resolved.path);
      if (!response.ok && response.status !== 404) throw await storageError(response, 'STORAGE_DELETE_FAILED');
    },
  };
}

async function ensurePrivateBucket(settings: S3Configuration, bucket: string): Promise<void> {
  const existing = await signedRequest(settings, 'HEAD', bucket, '');
  if (existing.ok) return;
  if (existing.status !== 404) throw await storageError(existing, 'STORAGE_BUCKET_LOOKUP_FAILED');
  // No ACL header at all: the bucket is private by default on every
  // S3-compatible backend, and asking for private explicitly fails on the
  // ones that have disabled ACLs entirely.
  const created = await signedRequest(settings, 'PUT', bucket, '');
  // 409 covers both BucketAlreadyExists and BucketAlreadyOwnedByYou; either
  // way the bucket the caller asked for is there.
  if (!created.ok && created.status !== 409) throw await storageError(created, 'STORAGE_BUCKET_CREATE_FAILED');
}

async function signedRequest(
  settings: S3Configuration,
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  bucket: string,
  objectPath: string,
  options: {
    readonly body?: Uint8Array;
    readonly payloadSha256?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<Response> {
  const target = requestTarget(settings, bucket, objectPath);
  const amzDate = formatAmzDate(new Date());
  const payloadHash = options.payloadSha256 ?? EMPTY_SHA256;

  const headers: Record<string, string> = {
    ...lowercaseKeys(options.headers ?? {}),
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${collapseWhitespace(headers[name] ?? '')}` + String.fromCharCode(10))
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = join([method, target.canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash]);

  const scope = `${amzDate.slice(0, 8)}/${settings.region}/${SERVICE}/aws4_request`;
  const stringToSign = join([ALGORITHM, amzDate, scope, await sha256Hex(encodeText(canonicalRequest))]);
  const signature = toHex(await hmac(await signingKey(settings, amzDate.slice(0, 8)), stringToSign));

  headers['authorization'] =
    `${ALGORITHM} Credential=${settings.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return await fetch(target.url, {
    method,
    headers,
    ...(options.body ? { body: options.body as unknown as BodyInit } : {}),
  });
}

async function presignPut(
  settings: S3Configuration,
  bucket: string,
  objectKey: string,
  expiresAt: string,
): Promise<string> {
  const target = requestTarget(settings, bucket, objectKey);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) throw new Error('STORAGE_UPLOAD_GRANT_EXPIRY_INVALID');
  const seconds = Math.floor((deadline - now.getTime()) / 1000);
  if (seconds < 1) throw new Error('STORAGE_UPLOAD_GRANT_ALREADY_EXPIRED');
  if (seconds > MAX_GRANT_SECONDS) throw new Error('STORAGE_UPLOAD_GRANT_EXPIRY_TOO_DISTANT');

  const scope = `${amzDate.slice(0, 8)}/${settings.region}/${SERVICE}/aws4_request`;
  // Only host is signed. A presigned URL enforces exactly the headers it signed,
  // and signing content-type would make the grant unusable by any client that
  // spells the media type differently from the row in the database.
  const parameters: ReadonlyArray<readonly [string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${settings.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(seconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = parameters
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = join([
    'PUT',
    target.canonicalUri,
    canonicalQuery,
    `host:${target.host}` + String.fromCharCode(10),
    'host',
    UNSIGNED_PAYLOAD,
  ]);
  const stringToSign = join([ALGORITHM, amzDate, scope, await sha256Hex(encodeText(canonicalRequest))]);
  const signature = toHex(await hmac(await signingKey(settings, amzDate.slice(0, 8)), stringToSign));
  return `${target.url}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function requestTarget(
  settings: S3Configuration,
  bucket: string,
  objectPath: string,
): { readonly url: string; readonly host: string; readonly canonicalUri: string } {
  const base = new URL(settings.endpoint);
  const encodedPath = objectPath === '' ? '' : encodeObjectPath(objectPath);
  if (settings.pathStyle) {
    // A bucket-level request addresses the bucket itself, so no trailing
    // slash: some backends read `/bucket/` as an object whose key is empty.
    const canonicalUri = encodedPath ? `/${bucket}/${encodedPath}` : `/${bucket}`;
    return { url: `${settings.endpoint}${canonicalUri}`, host: base.host, canonicalUri };
  }
  const host = `${bucket}.${base.host}`;
  const canonicalUri = `/${encodedPath}`;
  return { url: `${base.protocol}//${host}${canonicalUri}`, host, canonicalUri };
}

/** Each segment is encoded, the separators are not: S3 signs the path this way. */
function encodeObjectPath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

/**
 * RFC 3986 unreserved only.
 *
 * encodeURIComponent leaves !'()* alone, and S3 rejects a signature computed
 * over a path that still contains them literally.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function signingKey(settings: S3Configuration, dateStamp: string): Promise<Uint8Array> {
  const initial = encodeText(`AWS4${settings.secretAccessKey}`);
  const kDate = await hmac(initial, dateStamp);
  const kRegion = await hmac(kDate, settings.region);
  const kService = await hmac(kRegion, SERVICE);
  return await hmac(kService, 'aws4_request');
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encodeText(data) as unknown as ArrayBuffer));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function join(parts: readonly string[]): string {
  return parts.join(String.fromCharCode(10));
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function base64ChecksumToHex(value: string | null): string | null {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const binary = atob(value);
  let result = '';
  for (let index = 0; index < binary.length; index += 1) {
    result += binary.charCodeAt(index).toString(16).padStart(2, '0');
  }
  return result;
}

function formatAmzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function lowercaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value;
  return result;
}

function resolveBucket(
  settings: S3Configuration,
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
  if (objectKey.includes('..') || objectKey.includes('\\') || /[\u0000-\u001f\u007f ]/.test(objectKey)) {
    throw new Error('STORAGE_OBJECT_KEY_INVALID');
  }
}

async function storageError(response: Response, code: string): Promise<Error> {
  const requestId = response.headers.get('x-amz-request-id');
  const detail = (await response.text()).replace(/[^ -~]/g, '').slice(0, 300);
  return new Error(`${code}:${response.status}${requestId ? `:${requestId}` : ''}${detail ? `:${detail}` : ''}`);
}

function validateBucketName(bucket: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('STORAGE_BUCKET_NAME_INVALID');
  return bucket;
}

function validateEndpoint(raw: string): string {
  const parsed = new URL(raw);
  const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === 'minio';
  if (parsed.protocol !== 'https:' && !local) throw new Error('S3_ENDPOINT_HTTPS_REQUIRED');
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('S3_ENDPOINT_PATH_NOT_SUPPORTED');
  return `${parsed.protocol}//${parsed.host}`;
}

function required(configuration: Readonly<Record<string, string>>, name: string): string {
  const result = configuration[name]?.trim();
  if (!result) throw new Error(`${name}_MISSING`);
  return result;
}

function bucketSetting(configuration: Readonly<Record<string, string>>, name: string, fallback: string): string {
  return validateBucketName(configuration[name]?.trim() || fallback);
}
