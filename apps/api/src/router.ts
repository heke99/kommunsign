import { handleOnboardingRequest } from './onboarding-router.js';
import { handleAuthRequest } from './auth-router.js';
import type { Permission } from '../../../packages/authorization/src/index.js';
import type { ApiErrorBody, TenantContext } from '../../../packages/contracts/src/index.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { SIGNING_SOURCE_MAX_BYTES, SIGNING_SOURCE_MIME_TYPES, validateUploadMetadata } from '../../../packages/uploads/src/index.js';
import { assertSafeWebhookUrl } from '../../../packages/webhooks/src/index.js';
import { normalizeSwedishPersonalNumber, IDENTIFIER_BINDING_EXCEPTION_CODES } from '../../../packages/personal-number/src/index.js';
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

import type {
  AddDocumentInput, AddSignerInput, ApiDependencies, CreateCaseInput, DownloadArtifact,
  PageInput, TemplateInput, UploadGrantInput, WebhookEndpointInput,
} from './ports.js';

const MAX_JSON_BODY_BYTES = 128 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_UPLOAD_BYTES = 250 * 1024 * 1024;
const PUBLIC_SECURITY_HEADERS: Readonly<Record<string,string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-site',
};
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
async function readRawBody(request: Request, maximumBytes: number, requiredContentType?: string): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > maximumBytes) throw new ApiRequestError('PAYLOAD_TOO_LARGE', 'Request payload is too large', 413);
  if (requiredContentType) {
    const actual = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (actual !== requiredContentType) throw new ApiRequestError('UNSUPPORTED_MEDIA_TYPE', `Content-Type must be ${requiredContentType}`, 415);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new ApiRequestError('PAYLOAD_TOO_LARGE', 'Request payload is too large', 413);
  return bytes;
}
function publicJson(body: unknown, requestId: string, status = 200): Response {
  return json(body, status, { ...PUBLIC_SECURITY_HEADERS, 'x-request-id': requestId });
}
function normalizedHeaders(request: Request): Readonly<Record<string,string|undefined>> {
  const headers: Record<string,string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}
function requirePublicToken(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{43,512}$/.test(value)) throw new ApiRequestError('INVITATION_INVALID', 'Signing invitation is invalid', 404);
  return value;
}
function requirePublicSessionId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,256}$/.test(value)) throw new ApiRequestError('TIC_SESSION_NOT_FOUND', 'BankID session was not found', 404);
  return value;
}
function assertPublicHost(request: Request, category: 'sign'|'hooks'|'verify'): void {
  if (process.env.APP_ENV !== 'production') return;
  const hostname = new URL(request.url).hostname.toLowerCase();
  const candidates = category === 'hooks'
    ? [process.env.WEBHOOK_BASE_URL]
    : category === 'verify'
      ? [process.env.API_BASE_URL, process.env.VERIFICATION_PORTAL_URL]
      : [process.env.API_BASE_URL, process.env.SIGNER_FALLBACK_URL];
  const allowed = new Set(candidates.filter(Boolean).map((value) => new URL(value as string).hostname.toLowerCase()));
  if (!allowed.has(hostname)) throw new ApiRequestError('HOST_NOT_ALLOWED', 'Host is not allowed for this endpoint', 421);
}
async function handlePublicRequest(dependencies: ApiDependencies, request: Request, requestId: string): Promise<Response | null> {
  const url = new URL(request.url);
  const invitationMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)$/);
  if (invitationMatch?.[1]) {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    const token = requirePublicToken(invitationMatch[1]);
    if (request.method === 'GET') return publicJson(await dependencies.publicSigning.getInvitation(token), requestId);
  }
  const openedMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)\/opened$/);
  if (openedMatch?.[1] && request.method === 'POST') {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    await readJson(request, true);
    return publicJson(await dependencies.publicSigning.markOpened(requirePublicToken(openedMatch[1])), requestId);
  }
  const documentMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)\/documents\/([^/]+)$/);
  if (documentMatch?.[1] && documentMatch[2] && request.method === 'GET') {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    const artifact = await dependencies.publicSigning.document(requirePublicToken(documentMatch[1]), requireUuid(documentMatch[2], 'documentId'));
    return artifactResponse(artifact, requestId);
  }
  const startMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)\/bankid\/start$/);
  if (startMatch?.[1] && request.method === 'POST') {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    const body = await readJson(request); assertPlainObject(body); assertAllowedKeys(body, ['reviewAcknowledged']);
    if (body.reviewAcknowledged !== true) throw new ApiRequestError('DOCUMENT_REVIEW_REQUIRED', 'Documents must be reviewed before BankID starts', 422);
    const endUserIp = request.headers.get('x-kommunsign-end-user-ip');
    if (!endUserIp) throw new ApiRequestError('TRUSTED_CLIENT_IP_REQUIRED', 'Trusted client IP is unavailable', 503);
    const userAgent = request.headers.get('user-agent')?.slice(0, 512) || 'unknown';
    return publicJson(await dependencies.publicSigning.startBankId(requirePublicToken(startMatch[1]), { reviewAcknowledged: true, endUserIp, userAgent }), requestId, 201);
  }
  const sessionMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)\/bankid\/sessions\/([^/]+)$/);
  if (sessionMatch?.[1] && sessionMatch[2]) {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    const token = requirePublicToken(sessionMatch[1]); const sessionId = requirePublicSessionId(sessionMatch[2]);
    if (request.method === 'GET') return publicJson(await dependencies.publicSigning.bankIdStatus(token, sessionId), requestId);
    if (request.method === 'DELETE') return publicJson(await dependencies.publicSigning.cancelBankId(token, sessionId), requestId);
  }
  const extendMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)\/bankid\/sessions\/([^/]+)\/extend$/);
  if (extendMatch?.[1] && extendMatch[2] && request.method === 'POST') {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    await readJson(request, true);
    return publicJson(await dependencies.publicSigning.extendBankId(requirePublicToken(extendMatch[1]), requirePublicSessionId(extendMatch[2])), requestId);
  }
  const declineMatch = url.pathname.match(/^\/v1\/public\/signing-invitations\/([^/]+)\/decline$/);
  if (declineMatch?.[1] && request.method === 'POST') {
    assertPublicHost(request, 'sign');
    if (!dependencies.publicSigning) throw new ApiRequestError('PUBLIC_SIGNING_NOT_CONFIGURED', 'Public signing is not configured', 503);
    const body = await readJson(request, true); assertPlainObject(body); assertAllowedKeys(body, ['reason']);
    const reason = body.reason === undefined ? undefined : requireString(body.reason, 'reason', 1, 1_000);
    return publicJson(await dependencies.publicSigning.decline(requirePublicToken(declineMatch[1]), reason), requestId);
  }
  if (url.pathname === '/v1/provider-webhooks/tic/bankid' && request.method === 'POST') {
    assertPublicHost(request, 'hooks');
    if (!dependencies.providerWebhooks) throw new ApiRequestError('PROVIDER_WEBHOOKS_NOT_CONFIGURED', 'Provider webhooks are not configured', 503);
    const rawBody = await readRawBody(request, MAX_WEBHOOK_BODY_BYTES, 'application/json');
    return publicJson(await dependencies.providerWebhooks.tic({ rawBody, headers: normalizedHeaders(request), receivedAt: new Date().toISOString() }), requestId, 202);
  }
  if (url.pathname === '/v1/provider-webhooks/resend' && request.method === 'POST') {
    assertPublicHost(request, 'hooks');
    if (!dependencies.providerWebhooks) throw new ApiRequestError('PROVIDER_WEBHOOKS_NOT_CONFIGURED', 'Provider webhooks are not configured', 503);
    const rawBody = await readRawBody(request, MAX_WEBHOOK_BODY_BYTES, 'application/json');
    return publicJson(await dependencies.providerWebhooks.resend({ rawBody, headers: normalizedHeaders(request), receivedAt: new Date().toISOString() }), requestId, 202);
  }
  const verificationMatch = url.pathname.match(/^\/v1\/public\/verifications\/([^/]+)$/);
  if (verificationMatch?.[1] && request.method === 'GET') {
    assertPublicHost(request, 'verify');
    if (!dependencies.publicVerification) throw new ApiRequestError('PUBLIC_VERIFICATION_NOT_CONFIGURED', 'Public verification is not configured', 503);
    const result = await dependencies.publicVerification.get(verificationMatch[1]);
    return result ? publicJson(result, requestId) : publicJson({ error: { code: 'NOT_FOUND', message: 'Verification was not found', requestId } }, requestId, 404);
  }
  if (url.pathname === '/v1/public/verifications/packages/verify' && request.method === 'POST') {
    assertPublicHost(request, 'verify');
    if (!dependencies.publicVerification) throw new ApiRequestError('PUBLIC_VERIFICATION_NOT_CONFIGURED', 'Public verification is not configured', 503);
    const bytes = await readRawBody(request, MAX_EVIDENCE_UPLOAD_BYTES, 'application/zip');
    return publicJson(await dependencies.publicVerification.verifyPackage(bytes), requestId);
  }
  return null;
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
  assertAllowedKeys(value, ['displayName', 'email', 'personalNumber', 'requirePersonalNumberMatch', 'personalNumberException', 'required', 'signingOrder']);
  const displayName = requireString(value.displayName, 'displayName', 1, 200);
  const email = requireString(value.email, 'email', 3, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiRequestError('VALIDATION_ERROR', 'email is invalid', 422, { field: 'email' });
  const requirePersonalNumberMatch = requireBoolean(value.requirePersonalNumberMatch, 'requirePersonalNumberMatch');
  let personalNumber: string | null = null;
  if (value.personalNumber !== null && value.personalNumber !== undefined) {
    try { personalNumber = normalizeSwedishPersonalNumber(requireString(value.personalNumber, 'personalNumber', 10, 14)); }
    catch { throw new ApiRequestError('PERSONAL_NUMBER_INVALID', 'Personal number is invalid', 422, { field: 'personalNumber' }); }
  }
  let personalNumberException: AddSignerInput['personalNumberException'] = null;
  if (value.personalNumberException !== null && value.personalNumberException !== undefined) {
    assertPlainObject(value.personalNumberException);
    assertAllowedKeys(value.personalNumberException, ['code', 'reason']);
    if (typeof value.personalNumberException.code !== 'string' || !IDENTIFIER_BINDING_EXCEPTION_CODES.includes(value.personalNumberException.code as never)) {
      throw new ApiRequestError('PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED', 'Personal number exception code is invalid', 422);
    }
    const reason = value.personalNumberException.reason === null || value.personalNumberException.reason === undefined
      ? undefined : requireString(value.personalNumberException.reason, 'reason', 1, 2_000);
    personalNumberException = { code: value.personalNumberException.code as NonNullable<AddSignerInput['personalNumberException']>['code'], ...(reason ? { reason } : {}) };
  }
  if (personalNumber && (!requirePersonalNumberMatch || personalNumberException)) throw new ApiRequestError('PERSONAL_NUMBER_INVALID', 'Strict binding cannot include an exception', 422);
  if (!personalNumber && (requirePersonalNumberMatch || !personalNumberException)) throw new ApiRequestError('PERSONAL_NUMBER_REQUIRED', 'A valid personal number or authorized exception is required', 422);
  if (personalNumberException?.code === 'OTHER' && !personalNumberException.reason) throw new ApiRequestError('PERSONAL_NUMBER_EXCEPTION_REASON_REQUIRED', 'A reason is required for OTHER', 422);
  return {
    displayName, email, personalNumber, requirePersonalNumberMatch, personalNumberException,
    required: requireBoolean(value.required, 'required'), signingOrder: optionalPositiveInteger(value.signingOrder, 'signingOrder') ?? 1,
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
    }, { allowedMimeTypes: SIGNING_SOURCE_MIME_TYPES, maximumBytes: SIGNING_SOURCE_MAX_BYTES });
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
    PERSONAL_NUMBER_REQUIRED: [422, 'PERSONAL_NUMBER_REQUIRED'],
    PERSONAL_NUMBER_INVALID: [422, 'PERSONAL_NUMBER_INVALID'],
    PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED: [403, 'PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED'],
    PERSONAL_NUMBER_EXCEPTION_REASON_REQUIRED: [422, 'PERSONAL_NUMBER_EXCEPTION_REASON_REQUIRED'],
    DOCUMENT_NOT_READY: [409, 'DOCUMENT_NOT_READY'],
    CASE_SEND_EVIDENCE_INCOMPLETE: [409, 'CASE_SEND_EVIDENCE_INCOMPLETE'],
    UPLOAD_NOT_CONFIRMED: [409, 'UPLOAD_NOT_CONFIRMED'],
    UPLOAD_OBJECT_MISMATCH: [422, 'UPLOAD_OBJECT_MISMATCH'],
    INVITATION_INVALID: [404, 'INVITATION_INVALID'],
    INVITATION_EXPIRED: [410, 'INVITATION_EXPIRED'],
    INVITATION_REVOKED: [410, 'INVITATION_REVOKED'],
    DOCUMENT_REVIEW_REQUIRED: [422, 'DOCUMENT_REVIEW_REQUIRED'],
    SIGNING_ORDER_BLOCKED: [409, 'SIGNING_ORDER_BLOCKED'],
    SIGNING_INTENT_NOT_READY: [409, 'SIGNING_INTENT_NOT_READY'],
    TIC_NOT_CONFIGURED: [503, 'TIC_NOT_CONFIGURED'],
    TIC_SESSION_NOT_FOUND: [404, 'TIC_SESSION_NOT_FOUND'],
    TIC_SESSION_EXTENSION_ALREADY_USED: [409, 'TIC_SESSION_EXTENSION_ALREADY_USED'],
    TIC_WEBHOOK_SIGNATURE_INVALID: [401, 'TIC_WEBHOOK_SIGNATURE_INVALID'],
    TIC_WEBHOOK_EVENT_UNSUPPORTED: [422, 'TIC_WEBHOOK_EVENT_UNSUPPORTED'],
    TIC_WEBHOOK_TRANSACTION_NOT_FOUND: [404, 'TIC_WEBHOOK_TRANSACTION_NOT_FOUND'],
    EMAIL_PROVIDER_NOT_CONFIGURED: [503, 'EMAIL_PROVIDER_NOT_CONFIGURED'],
    EMAIL_MESSAGE_NOT_FOUND: [404, 'EMAIL_MESSAGE_NOT_FOUND'],
    HOST_NOT_ALLOWED: [421, 'HOST_NOT_ALLOWED'],
    SIGNATURE_POLICY_NOT_FOUND: [404, 'SIGNATURE_POLICY_NOT_FOUND'],
    SIGNATURE_POLICY_DECISION_MODE_MISMATCH: [422, 'SIGNATURE_POLICY_DECISION_MODE_MISMATCH'],
  };
  const mapped = mappings[cause.message];
  return mapped ? new ApiRequestError(mapped[1], mapped[1].replace(/_/g, ' '), mapped[0]) : null;
}

export function createApiHandler(dependencies: ApiDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = requestIdFrom(request);
    try {
      const publicResponse = await handlePublicRequest(dependencies, request, requestId);
      if (publicResponse) return publicResponse;
      const authResponse = await handleAuthRequest(dependencies, request, requestId);
      if (authResponse) return authResponse;
      const onboardingResponse = await handleOnboardingRequest(dependencies, request, requestId);
      if (onboardingResponse) return onboardingResponse;
      const context = await dependencies.resolveContext(request);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/signature-policies') {
        await authorize(dependencies, context, 'case:create');
        return json(await dependencies.cases.listPolicies(context), 200, { 'x-request-id': requestId });
      }
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
      const uploadCompleteMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/complete$/);
      if (request.method === 'POST' && uploadCompleteMatch?.[1]) {
        await authorize(dependencies, context, 'upload:create');
        const uploadId = requireUuid(uploadCompleteMatch[1], 'uploadId');
        const idempotencyKey = requireIdempotencyKey(request);
        const payload = { operation: 'complete', uploadId };
        return json(await dependencies.uploads.complete(context, uploadId, idempotencyKey, await canonicalPayloadHash(payload)), 200, { 'x-request-id': requestId });
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
        const parsed = parseAddSignerInput(await readJson(request));
        const input = parsed.personalNumberException
          ? (await authorize(dependencies, context, 'signer:personnummer-binding-exempt'), { ...parsed, exceptionPermissionGranted: true as const })
          : parsed;
        return json(await dependencies.cases.addSigner(context, id, input, key, await canonicalPayloadHash(parsed)), 201, { 'x-request-id': requestId });
      }
      const signerPatchMatch = id ? url.pathname.match(new RegExp(`^/v1/signature-cases/${id}/signers/([^/]+)$`)) : null;
      if (id && request.method === 'PATCH' && signerPatchMatch?.[1]) {
        await authorize(dependencies, context, 'signer:add');
        const signerId = requireUuid(signerPatchMatch[1], 'signerId');
        const key = requireIdempotencyKey(request);
        const parsed = parseAddSignerInput(await readJson(request));
        const input = parsed.personalNumberException
          ? (await authorize(dependencies, context, 'signer:personnummer-binding-exempt'), { ...parsed, exceptionPermissionGranted: true as const })
          : parsed;
        return json(await dependencies.cases.updateSigner(context, id, signerId, input, key, await canonicalPayloadHash(parsed), expectedVersion(request)), 200, { 'x-request-id': requestId });
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
