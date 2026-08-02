import { handleOnboardingRequest } from './onboarding-router.js';
import type { Permission } from '../../../packages/authorization/src/index.js';
import type { ApiErrorBody, TenantContext } from '../../../packages/contracts/src/index.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { validateUploadMetadata } from '../../../packages/uploads/src/index.js';
import { assertSafeWebhookUrl } from '../../../packages/webhooks/src/index.js';
import type {
  AddDocumentInput, AddSignerInput, ApiDependencies, CreateCaseInput, DownloadArtifact,
  PageInput, TemplateInput, UploadGrantInput, WebhookEndpointInput,
} from './ports.js';

const MAX_JSON_BODY_BYTES = 128 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+\/-]{16,200}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_.:-]{2,100}$/;

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function error(code: string, message: string, requestId: string, status: number, details?: Readonly<Record<string, unknown>>): Response {
  const body: ApiErrorBody = { error: { code, message, requestId, ...(details ? { details } : {}) } };
  return json(body, status, { 'x-request-id': requestId });
}
function artifactResponse(artifact: DownloadArtifact, requestId: string): Response {
  const headers: Record<string, string> = {
    'content-type': artifact.contentType,
    'content-disposition': `attachment; filename="${artifact.fileName.replace(/["\\\r\n]/g, '_')}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
  };
  if (artifact.sha256) headers['digest'] = `sha-256=${artifact.sha256}`;
  return new Response(artifact.bytes, { status: 200, headers });
}
function idFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/signature-cases\/([^/]+)(?:\/.*)?$/);
  return match?.[1] ?? null;
}
function requestIdFrom(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}
function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new ApiRequestError('VALIDATION_ERROR', `${field} must be a UUID`, 422, { field });
  return value;
}
function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key');
  if (!value) throw new ApiRequestError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', 400);
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw new ApiRequestError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key has an invalid format', 400);
  return value;
}
function expectedVersion(request: Request): number | undefined {
  const value = request.headers.get('if-match');
  if (!value) return undefined;
  const normalized = value.replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ApiRequestError('IF_MATCH_INVALID', 'If-Match must contain a positive status version', 400);
  return parsed;
}
function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiRequestError('VALIDATION_ERROR', 'JSON payload must be an object', 422);
}
function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new ApiRequestError('VALIDATION_ERROR', 'JSON payload contains unsupported fields', 422, { fields: unexpected });
}
function requireString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new ApiRequestError('VALIDATION_ERROR', `${field} must be a string`, 422, { field });
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ApiRequestError('VALIDATION_ERROR', `${field} has an invalid length`, 422, { field, minimum, maximum });
  }
  return normalized;
}
function optionalString(value: unknown, field: string, minimum: number, maximum: number): string | undefined {
  return value === undefined ? undefined : requireString(value, field, minimum, maximum);
}
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ApiRequestError('VALIDATION_ERROR', `${field} must be a boolean`, 422, { field });
  return value;
}
function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ApiRequestError('VALIDATION_ERROR', `${field} must be a positive integer`, 422, { field });
  return Number(value);
}
async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_JSON_BODY_BYTES) throw new ApiRequestError('PAYLOAD_TOO_LARGE', 'JSON payload is too large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 && allowEmpty) return {};
  if (contentType !== 'application/json') throw new ApiRequestError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  if (bytes.byteLength === 0) throw new ApiRequestError('INVALID_JSON', 'JSON payload is required', 400);
  if (bytes.byteLength > MAX_JSON_BODY_BYTES) throw new ApiRequestError('PAYLOAD_TOO_LARGE', 'JSON payload is too large', 413);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ApiRequestError('INVALID_JSON', 'JSON payload must be valid UTF-8', 400); }
  try { return JSON.parse(text); }
  catch { throw new ApiRequestError('INVALID_JSON', 'JSON payload is malformed', 400); }
}
function parseCreateCaseInput(value: unknown): CreateCaseInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['externalReference', 'title', 'decisionMode', 'signaturePolicyId']);
  const title = requireString(value.title, 'title', 1, 300);
  const signaturePolicyId = requireUuid(requireString(value.signaturePolicyId, 'signaturePolicyId', 36, 36), 'signaturePolicyId');
  if (value.decisionMode !== 'DIGITAL_APPROVAL' && value.decisionMode !== 'ELECTRONIC_SIGNATURE') {
    throw new ApiRequestError('VALIDATION_ERROR', 'decisionMode is invalid', 422, { field: 'decisionMode' });
  }
  const externalReference = optionalString(value.externalReference, 'externalReference', 1, 200);
  return { title, signaturePolicyId, decisionMode: value.decisionMode, ...(externalReference ? { externalReference } : {}) };
}
function parseAddDocumentInput(value: unknown): AddDocumentInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['uploadId', 'displayName']);
  return {
    uploadId: requireUuid(requireString(value.uploadId, 'uploadId', 36, 36), 'uploadId'),
    displayName: requireString(value.displayName, 'displayName', 1, 200),
  };
}
function parseAddSignerInput(value: unknown): AddSignerInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['displayName', 'recipientReference', 'identifierType', 'required', 'signingOrder']);
  const displayName = optionalString(value.displayName, 'displayName', 1, 200);
  const signingOrder = optionalPositiveInteger(value.signingOrder, 'signingOrder');
  const allowedIdentifierTypes = ['SSN', 'UPI', 'EMAIL', 'PHONE', 'INFERRED'];
  if (value.identifierType !== undefined && (typeof value.identifierType !== 'string' || !allowedIdentifierTypes.includes(value.identifierType))) {
    throw new ApiRequestError('VALIDATION_ERROR', 'identifierType is invalid', 422, { field: 'identifierType' });
  }
  const identifierType = value.identifierType as 'SSN' | 'UPI' | 'EMAIL' | 'PHONE' | 'INFERRED' | undefined;
  return {
    recipientReference: requireString(value.recipientReference, 'recipientReference', 16, 300),
    required: requireBoolean(value.required, 'required'),
    ...(displayName ? { displayName } : {}),
    ...(identifierType ? { identifierType } : {}),
    ...(signingOrder ? { signingOrder } : {}),
  };
}
function parseUploadInput(value: unknown): UploadGrantInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['fileName', 'mimeType', 'byteSize', 'sha256']);
  try {
    return validateUploadMetadata({
      fileName: requireString(value.fileName, 'fileName', 1, 200),
      mimeType: requireString(value.mimeType, 'mimeType', 1, 100),
      byteSize: Number(value.byteSize),
      sha256: requireString(value.sha256, 'sha256', 64, 64),
    }, { allowedMimeTypes: ['application/pdf'], maximumBytes: 100 * 1024 * 1024 });
  } catch {
    throw new ApiRequestError('VALIDATION_ERROR', 'Upload metadata is invalid or forbidden by policy', 422);
  }
}
function parseWebhookInput(value: unknown): WebhookEndpointInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['url', 'subscribedEvents']);
  if (!Array.isArray(value.subscribedEvents) || value.subscribedEvents.length < 1 || value.subscribedEvents.length > 50) {
    throw new ApiRequestError('VALIDATION_ERROR', 'subscribedEvents must contain 1-50 events', 422, { field: 'subscribedEvents' });
  }
  const events = value.subscribedEvents.map((event) => requireString(event, 'subscribedEvents', 3, 100));
  if (events.some((event) => !EVENT_PATTERN.test(event))) throw new ApiRequestError('VALIDATION_ERROR', 'subscribedEvents contains an invalid event name', 422);
  let url: string;
  try { url = assertSafeWebhookUrl(requireString(value.url, 'url', 8, 2048)).toString(); }
  catch { throw new ApiRequestError('VALIDATION_ERROR', 'Webhook URL is invalid or targets a forbidden network location', 422); }
  return { url, subscribedEvents: [...new Set(events)] };
}
function parseTemplateInput(value: unknown): TemplateInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['templateKey', 'locale', 'subjectTemplate', 'bodyTemplate']);
  const templateKey = requireString(value.templateKey, 'templateKey', 3, 100);
  if (!/^[a-z][a-z0-9_.-]+$/.test(templateKey)) throw new ApiRequestError('VALIDATION_ERROR', 'templateKey is invalid', 422);
  const locale = requireString(value.locale, 'locale', 2, 20);
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) throw new ApiRequestError('VALIDATION_ERROR', 'locale is invalid', 422);
  return {
    templateKey,
    locale,
    subjectTemplate: requireString(value.subjectTemplate, 'subjectTemplate', 1, 200),
    bodyTemplate: requireString(value.bodyTemplate, 'bodyTemplate', 1, 20_000),
  };
}
function pageInput(url: URL): PageInput {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApiRequestError('VALIDATION_ERROR', 'limit must be between 1 and 200', 422);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor && !/^[A-Za-z0-9._~-]{1,300}$/.test(cursor)) throw new ApiRequestError('VALIDATION_ERROR', 'cursor is invalid', 422);
  return { limit, ...(cursor ? { cursor } : {}) };
}
async function authorize(dependencies: ApiDependencies, context: TenantContext, permission: Permission): Promise<void> {
  try { await dependencies.authorize(context, permission); }
  catch { throw new ApiRequestError('FORBIDDEN', 'The authenticated subject is not authorized for this operation', 403); }
}
function canonicalPayloadHash(input: unknown): Promise<string> {
  return sha256Hex(canonicalJson(input as CanonicalJsonValue));
}
function mapKnownError(cause: unknown): ApiRequestError | null {
  if (!(cause instanceof Error)) return null;
  const mappings: Readonly<Record<string, readonly [number, string]>> = {
    IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_KEY_REUSED'],
    RESOURCE_VERSION_CONFLICT: [412, 'RESOURCE_VERSION_CONFLICT'],
    SIGN_SERVICE_NOT_CONFIGURED: [503, 'SIGN_SERVICE_NOT_CONFIGURED'],
    VALIDATION_SERVICE_NOT_CONFIGURED: [503, 'VALIDATION_SERVICE_NOT_CONFIGURED'],
    EVIDENCE_PACKAGE_NOT_READY: [409, 'EVIDENCE_PACKAGE_NOT_READY'],
    NOT_FOUND: [404, 'NOT_FOUND'],
  };
  const mapped = mappings[cause.message];
  return mapped ? new ApiRequestError(mapped[1], mapped[1].replace(/_/g, ' '), mapped[0]) : null;
}

export function createApiHandler(dependencies: ApiDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = requestIdFrom(request);
    try {
      const onboardingResponse = await handleOnboardingRequest(dependencies, request, requestId);
      if (onboardingResponse) return onboardingResponse;
      const context = await dependencies.resolveContext(request);
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/signature-cases') {
        await authorize(dependencies, context, 'case:create');
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parseCreateCaseInput(await readJson(request));
        const result = await dependencies.cases.create(context, input, idempotencyKey, await canonicalPayloadHash(input));
        return json(result, 201, { 'x-request-id': requestId, etag: `"${result.statusVersion ?? 1}"` });
      }
      if (request.method === 'GET' && url.pathname === '/v1/signature-cases') {
        await authorize(dependencies, context, 'case:read');
        return json(await dependencies.cases.list(context, pageInput(url)), 200, { 'x-request-id': requestId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/uploads') {
        await authorize(dependencies, context, 'upload:create');
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parseUploadInput(await readJson(request));
        return json(await dependencies.uploads.create(context, input, idempotencyKey, await canonicalPayloadHash(input)), 201, { 'x-request-id': requestId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/webhook-endpoints') {
        await authorize(dependencies, context, 'webhook:manage');
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parseWebhookInput(await readJson(request));
        return json(await dependencies.webhooks.createEndpoint(context, input, idempotencyKey, await canonicalPayloadHash(input)), 201, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        await authorize(dependencies, context, 'event:read');
        return json(await dependencies.events.list(context, pageInput(url)), 200, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/templates') {
        await authorize(dependencies, context, 'template:read');
        return json(await dependencies.templates.list(context, pageInput(url)), 200, { 'x-request-id': requestId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/templates') {
        await authorize(dependencies, context, 'template:manage');
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parseTemplateInput(await readJson(request));
        return json(await dependencies.templates.create(context, input, idempotencyKey, await canonicalPayloadHash(input)), 201, { 'x-request-id': requestId });
      }
      const rawId = idFromPath(url.pathname);
      const id = rawId ? requireUuid(rawId, 'id') : null;
      if (id && request.method === 'GET' && url.pathname === `/v1/signature-cases/${id}`) {
        await authorize(dependencies, context, 'case:read');
        const result = await dependencies.cases.get(context, id);
        return result ? json(result, 200, { 'x-request-id': requestId, etag: `"${result.statusVersion ?? 1}"` }) : error('NOT_FOUND', 'Signature case not found', requestId, 404);
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/documents`) {
        await authorize(dependencies, context, 'document:add');
        const key = requireIdempotencyKey(request);
        const input = parseAddDocumentInput(await readJson(request));
        return json(await dependencies.cases.addDocument(context, id, input, key, await canonicalPayloadHash(input)), 202, { 'x-request-id': requestId });
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/signers`) {
        await authorize(dependencies, context, 'signer:add');
        const key = requireIdempotencyKey(request);
        const input = parseAddSignerInput(await readJson(request));
        return json(await dependencies.cases.addSigner(context, id, input, key, await canonicalPayloadHash(input)), 201, { 'x-request-id': requestId });
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/send`) {
        await authorize(dependencies, context, 'case:send');
        const key = requireIdempotencyKey(request);
        const hash = await canonicalPayloadHash({ operation: 'send', signatureCaseId: id });
        const result = await dependencies.cases.send(context, id, key, hash, expectedVersion(request));
        return json(result, 200, { 'x-request-id': requestId, etag: `"${result.statusVersion ?? 1}"` });
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/cancel`) {
        await authorize(dependencies, context, 'case:cancel');
        const key = requireIdempotencyKey(request);
        const hash = await canonicalPayloadHash({ operation: 'cancel', signatureCaseId: id });
        const result = await dependencies.cases.cancel(context, id, key, hash, expectedVersion(request));
        return json(result, 200, { 'x-request-id': requestId, etag: `"${result.statusVersion ?? 1}"` });
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/remind`) {
        await authorize(dependencies, context, 'case:remind');
        const key = requireIdempotencyKey(request);
        const hash = await canonicalPayloadHash({ operation: 'remind', signatureCaseId: id });
        return json(await dependencies.cases.remind(context, id, key, hash), 202, { 'x-request-id': requestId });
      }
      if (id && request.method === 'GET' && url.pathname === `/v1/signature-cases/${id}/signed-document`) {
        await authorize(dependencies, context, 'document:download');
        return artifactResponse(await dependencies.cases.signedDocument(context, id), requestId);
      }
      if (id && request.method === 'GET' && url.pathname === `/v1/signature-cases/${id}/validation-report`) {
        await authorize(dependencies, context, 'validation:read');
        return artifactResponse(await dependencies.cases.validationReport(context, id), requestId);
      }
      if (id && request.method === 'GET' && url.pathname === `/v1/signature-cases/${id}/evidence-package`) {
        await authorize(dependencies, context, 'evidence:download');
        return artifactResponse(await dependencies.cases.evidencePackage(context, id), requestId);
      }
      return error('NOT_FOUND', 'Route not found', requestId, 404);
    } catch (cause) {
      const apiError = cause instanceof ApiRequestError ? cause : mapKnownError(cause);
      if (apiError) return error(apiError.code, apiError.message, requestId, apiError.status, apiError.details);
      dependencies.reportError?.(cause, requestId);
      return error('INTERNAL_ERROR', 'An unexpected internal error occurred', requestId, 500);
    }
  };
}
