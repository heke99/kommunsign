import type { Permission } from '../../../packages/authorization/src/index.js';
import type { ApiErrorBody, TenantContext } from '../../../packages/contracts/src/index.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import type { ApiDependencies, CreateCaseInput } from './ports.js';

const MAX_JSON_BODY_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+\/-]{16,200}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiRequestError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key has an invalid format', 400);
  }
  return value;
}
function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiRequestError('VALIDATION_ERROR', 'JSON payload must be an object', 422);
  }
}
function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ApiRequestError('VALIDATION_ERROR', 'JSON payload contains unsupported fields', 422, { fields: unexpected });
  }
}
function requireString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new ApiRequestError('VALIDATION_ERROR', `${field} must be a string`, 422, { field });
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ApiRequestError('VALIDATION_ERROR', `${field} has an invalid length`, 422, { field, minimum, maximum });
  }
  return normalized;
}
async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ApiRequestError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_JSON_BODY_BYTES) {
    throw new ApiRequestError('PAYLOAD_TOO_LARGE', 'JSON payload is too large', 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new ApiRequestError('INVALID_JSON', 'JSON payload is required', 400);
  if (bytes.byteLength > MAX_JSON_BODY_BYTES) throw new ApiRequestError('PAYLOAD_TOO_LARGE', 'JSON payload is too large', 413);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiRequestError('INVALID_JSON', 'JSON payload must be valid UTF-8', 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiRequestError('INVALID_JSON', 'JSON payload is malformed', 400);
  }
}
function parseCreateCaseInput(value: unknown): CreateCaseInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['externalReference', 'title', 'decisionMode', 'signaturePolicyId']);
  const title = requireString(value.title, 'title', 1, 300);
  const signaturePolicyId = requireUuid(requireString(value.signaturePolicyId, 'signaturePolicyId', 36, 36), 'signaturePolicyId');
  if (value.decisionMode !== 'DIGITAL_APPROVAL' && value.decisionMode !== 'ELECTRONIC_SIGNATURE') {
    throw new ApiRequestError('VALIDATION_ERROR', 'decisionMode is invalid', 422, { field: 'decisionMode' });
  }
  const externalReference = value.externalReference === undefined
    ? undefined
    : requireString(value.externalReference, 'externalReference', 1, 200);
  return {
    title,
    signaturePolicyId,
    decisionMode: value.decisionMode,
    ...(externalReference ? { externalReference } : {}),
  };
}
async function authorize(dependencies: ApiDependencies, context: TenantContext, permission: Permission): Promise<void> {
  try {
    await dependencies.authorize(context, permission);
  } catch {
    throw new ApiRequestError('FORBIDDEN', 'The authenticated subject is not authorized for this operation', 403);
  }
}
function canonicalPayloadHash(input: CreateCaseInput): Promise<string> {
  return sha256Hex(canonicalJson(input as unknown as CanonicalJsonValue));
}

export function createApiHandler(dependencies: ApiDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = requestIdFrom(request);
    try {
      const context = await dependencies.resolveContext(request);
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/signature-cases') {
        await authorize(dependencies, context, 'case:create');
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parseCreateCaseInput(await readJson(request));
        const result = await dependencies.cases.create(context, input, idempotencyKey, await canonicalPayloadHash(input));
        return json(result, 201, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/signature-cases') {
        await authorize(dependencies, context, 'case:read');
        return json({ data: await dependencies.cases.list(context) }, 200, { 'x-request-id': requestId });
      }
      const rawId = idFromPath(url.pathname);
      const id = rawId ? requireUuid(rawId, 'id') : null;
      if (id && request.method === 'GET' && url.pathname === `/v1/signature-cases/${id}`) {
        await authorize(dependencies, context, 'case:read');
        const result = await dependencies.cases.get(context, id);
        return result ? json(result, 200, { 'x-request-id': requestId }) : error('NOT_FOUND', 'Signature case not found', requestId, 404);
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/send`) {
        await authorize(dependencies, context, 'case:send');
        const idempotencyKey = requireIdempotencyKey(request);
        const payloadHash = await sha256Hex(canonicalJson({ operation: 'send', signatureCaseId: id }));
        return json(await dependencies.cases.send(context, id, idempotencyKey, payloadHash), 200, { 'x-request-id': requestId });
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/cancel`) {
        await authorize(dependencies, context, 'case:cancel');
        const idempotencyKey = requireIdempotencyKey(request);
        const payloadHash = await sha256Hex(canonicalJson({ operation: 'cancel', signatureCaseId: id }));
        return json(await dependencies.cases.cancel(context, id, idempotencyKey, payloadHash), 200, { 'x-request-id': requestId });
      }
      return error('NOT_FOUND', 'Route not found', requestId, 404);
    } catch (cause) {
      if (cause instanceof ApiRequestError) return error(cause.code, cause.message, requestId, cause.status, cause.details);
      dependencies.reportError?.(cause, requestId);
      return error('INTERNAL_ERROR', 'The request could not be completed', requestId, 500);
    }
  };
}
