import { handleOnboardingRequest } from './onboarding-router.js';
import { handleAuthRequest } from './auth-router.js';
import { handleScimRequest } from './scim-router.js';
import {
  DEFAULT_GRANT_LIFETIME_SECONDS, MAXIMUM_GRANT_LIFETIME_SECONDS,
  truncateClientAddress, userAgentFamily,
} from './production-adapters/postgres/delivery-repository.js';
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
  PageInput, RecordPrivacyRequestInput, TemplateInput, UploadGrantInput, WebhookEndpointInput,
} from './ports.js';
import type { IssueScimClientInput } from './production-adapters/postgres/scim-repository.js';

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
  const downloadMatch = /^\/v1\/public\/downloads\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (downloadMatch?.[1] && request.method === 'GET') {
    if (!dependencies.delivery) throw new ApiRequestError('DELIVERY_NOT_CONFIGURED', 'Document delivery is not configured', 503);
    // Both are coarsened before they are stored: a full client address and a
    // full user agent are personal data being retained for a purpose nobody
    // stated. What the trail has to answer is "same office twice" versus "this
    // link is being passed around", and a /24 answers that.
    const network = truncateClientAddress(request.headers.get('x-forwarded-for')?.split(',')[0] ?? null);
    const agent = userAgentFamily(request.headers.get('user-agent'));
    const redeemed = await dependencies.delivery.redeem(downloadMatch[1], new Date(), {
      ...(network ? { network } : {}),
      ...(agent ? { userAgentFamily: agent } : {}),
    });
    // Unknown, expired, revoked and spent are one answer. Distinguishing them
    // would tell a probing caller which links once existed.
    if (!redeemed) throw new ApiRequestError('DOWNLOAD_LINK_INVALID', 'This download link is no longer valid', 404);
    const context = deliveryContext(redeemed.tenantId, requestId);
    const artifact = redeemed.artifact === 'SIGNED_DOCUMENT'
      ? await dependencies.cases.signedDocument(context, redeemed.signatureCaseId)
      : redeemed.artifact === 'VALIDATION_REPORT'
        ? await dependencies.cases.validationReport(context, redeemed.signatureCaseId)
        : await dependencies.cases.evidencePackage(context, redeemed.signatureCaseId);
    return artifactResponse(artifact, requestId);
  }
  if (url.pathname === '/v1/public/verifications/packages/verify' && request.method === 'POST') {
    assertPublicHost(request, 'verify');
    if (!dependencies.publicVerification) throw new ApiRequestError('PUBLIC_VERIFICATION_NOT_CONFIGURED', 'Public verification is not configured', 503);
    const bytes = await readRawBody(request, MAX_EVIDENCE_UPLOAD_BYTES, 'application/zip');
    return publicJson(await dependencies.publicVerification.verifyPackage(bytes), requestId);
  }
  return null;
}

/**
 * The context a redeemed download link runs under.
 *
 * Deliberately minimal and deployment-sourced: the link proves entitlement to
 * exactly one artifact of one case, and the repository call it makes is already
 * scoped to that case. Giving it a membership context would grant far more than
 * the link was issued for.
 */
function deliveryContext(tenantId: string, requestId: string): TenantContext {
  return { tenantId, subjectId: SYSTEM_DELIVERY_ACTOR, requestId, authMethod: 'magic_link', source: 'deployment' };
}
const SYSTEM_DELIVERY_ACTOR = '00000000-0000-0000-0000-000000000000';

const DELIVERY_ARTIFACTS = ['SIGNED_DOCUMENT', 'VALIDATION_REPORT', 'EVIDENCE_PACKAGE'] as const;

function parseDownloadLinkInput(value: unknown): {
  readonly artifact: 'SIGNED_DOCUMENT' | 'VALIDATION_REPORT' | 'EVIDENCE_PACKAGE';
  readonly lifetimeSeconds: number;
  readonly maximumUses: number;
  readonly signerId?: string;
} {
  assertPlainObject(value);
  assertAllowedKeys(value, ['artifact', 'lifetimeSeconds', 'maximumUses', 'signerId']);
  const artifact = value.artifact ?? 'SIGNED_DOCUMENT';
  if (typeof artifact !== 'string' || !DELIVERY_ARTIFACTS.includes(artifact as never)) {
    throw new ApiRequestError('VALIDATION_ERROR', 'artifact is invalid', 422, { field: 'artifact' });
  }
  const lifetimeSeconds = value.lifetimeSeconds === undefined ? DEFAULT_GRANT_LIFETIME_SECONDS : value.lifetimeSeconds;
  if (typeof lifetimeSeconds !== 'number' || !Number.isSafeInteger(lifetimeSeconds)
      || lifetimeSeconds < 60 || lifetimeSeconds > MAXIMUM_GRANT_LIFETIME_SECONDS) {
    throw new ApiRequestError('DOWNLOAD_GRANT_LIFETIME_INVALID', 'lifetimeSeconds is outside the permitted range', 422);
  }
  const maximumUses = value.maximumUses === undefined ? 5 : value.maximumUses;
  if (typeof maximumUses !== 'number' || !Number.isSafeInteger(maximumUses) || maximumUses < 1 || maximumUses > 50) {
    throw new ApiRequestError('VALIDATION_ERROR', 'maximumUses must be between 1 and 50', 422, { field: 'maximumUses' });
  }
  const signerId = value.signerId === undefined || value.signerId === null
    ? undefined : requireUuid(requireString(value.signerId, 'signerId', 36, 36), 'signerId');
  return {
    artifact: artifact as 'SIGNED_DOCUMENT' | 'VALIDATION_REPORT' | 'EVIDENCE_PACKAGE',
    lifetimeSeconds, maximumUses, ...(signerId ? { signerId } : {}),
  };
}

function parseScimClientInput(value: unknown): IssueScimClientInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['displayName', 'assignableRoles', 'groupToRole']);
  const displayName = requireString(value.displayName, 'displayName', 1, 120);
  if (!Array.isArray(value.assignableRoles) || value.assignableRoles.length === 0) {
    throw new ApiRequestError('VALIDATION_ERROR', 'assignableRoles must list at least one role', 422, { field: 'assignableRoles' });
  }
  const assignableRoles = value.assignableRoles.map((role, index) => requireString(role, `assignableRoles[${index}]`, 1, 64));
  const groupToRole: Record<string, string> = {};
  if (value.groupToRole !== undefined) {
    assertPlainObject(value.groupToRole);
    for (const [group, role] of Object.entries(value.groupToRole)) {
      // Group values are compared verbatim against what the directory sends,
      // so they are length-checked but never normalised: case-folding a
      // distinguished name can collide two genuinely distinct groups.
      if (group.length < 1 || group.length > 512) {
        throw new ApiRequestError('VALIDATION_ERROR', 'A group value is out of range', 422, { field: 'groupToRole' });
      }
      groupToRole[group] = requireString(role, 'groupToRole', 1, 64);
    }
  }
  return { displayName, assignableRoles, groupToRole };
}

const DATA_SUBJECT_RIGHTS = ['ACCESS', 'RECTIFICATION', 'RESTRICTION', 'ERASURE', 'PORTABILITY'] as const;
const IDENTITY_ASSURANCE_LEVELS = ['LOW', 'SUBSTANTIAL', 'HIGH'] as const;

function parsePrivacyRequestInput(value: unknown): RecordPrivacyRequestInput {
  assertPlainObject(value);
  assertAllowedKeys(value, ['right', 'subjectIdentifier', 'identityMethod', 'identityAssurance']);
  if (typeof value.right !== 'string' || !DATA_SUBJECT_RIGHTS.includes(value.right as never)) {
    throw new ApiRequestError('VALIDATION_ERROR', 'right is invalid', 422, { field: 'right' });
  }
  if (typeof value.identityAssurance !== 'string' || !IDENTITY_ASSURANCE_LEVELS.includes(value.identityAssurance as never)) {
    throw new ApiRequestError('VALIDATION_ERROR', 'identityAssurance is invalid', 422, { field: 'identityAssurance' });
  }
  // The strong-identity rights are rejected here as well as in the database.
  // Releasing a register extract to an address someone happens to control is a
  // personal data breach in itself, so the caller learns it at the edge rather
  // than after the request is already on file.
  if (['ACCESS', 'ERASURE', 'PORTABILITY', 'RECTIFICATION'].includes(value.right) && value.identityAssurance !== 'HIGH') {
    throw new ApiRequestError('PRIVACY_IDENTITY_ASSURANCE_TOO_LOW', 'This right requires a strongly verified identity', 422);
  }
  return {
    right: value.right as RecordPrivacyRequestInput['right'],
    subjectIdentifier: requireString(value.subjectIdentifier, 'subjectIdentifier', 1, 320),
    identityMethod: requireString(value.identityMethod, 'identityMethod', 1, 120),
    identityAssurance: value.identityAssurance as RecordPrivacyRequestInput['identityAssurance'],
  };
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

/**
 * Validates a gallring request.
 *
 * The case list is bounded because gallring is irreversible and a single
 * request that named tens of thousands of cases would be impossible for the
 * approver to meaningfully review before authorising it.
 */
function parseGallringInput(body: unknown): { readonly policyKey: string; readonly caseIds: readonly string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiRequestError('RETENTION_REQUEST_INVALID', 'A gallring request object is required', 400);
  const record = body as Record<string, unknown>;
  const policyKey = record.policyKey;
  if (typeof policyKey !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(policyKey)) {
    throw new ApiRequestError('RETENTION_POLICY_KEY_INVALID', 'A policyKey is required', 400);
  }
  const caseIds = record.caseIds;
  if (!Array.isArray(caseIds) || caseIds.length === 0 || caseIds.length > 500) {
    throw new ApiRequestError('RETENTION_CASE_LIST_INVALID', 'Between 1 and 500 caseIds are required', 400);
  }
  const parsed = caseIds.map((value, index) => requireUuid(typeof value === 'string' ? value : '', `caseIds[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new ApiRequestError('RETENTION_CASE_LIST_INVALID', 'caseIds must be unique', 400);
  return { policyKey, caseIds: parsed };
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
    DOWNLOAD_GRANT_NOT_FOUND: [404, 'DOWNLOAD_GRANT_NOT_FOUND'],
    DOWNLOAD_GRANT_LIFETIME_INVALID: [422, 'DOWNLOAD_GRANT_LIFETIME_INVALID'],
    DOWNLOAD_GRANT_CASE_NOT_COMPLETED: [409, 'DOWNLOAD_GRANT_CASE_NOT_COMPLETED'],
    PRIVACY_REQUEST_NOT_FOUND: [404, 'PRIVACY_REQUEST_NOT_FOUND'],
    PRIVACY_REQUEST_CLOSED: [409, 'PRIVACY_REQUEST_CLOSED'],
    PRIVACY_REQUEST_CONFLICT: [409, 'PRIVACY_REQUEST_CONFLICT'],
  };
  const mapped = mappings[cause.message];
  return mapped ? new ApiRequestError(mapped[1], mapped[1].replace(/_/g, ' '), mapped[0]) : null;
}

/**
 * The scrape endpoint.
 *
 * Internal, never public. It exposes cross-tenant operational state — queue
 * depths, certificate expiries, per-tenant series — which is exactly what an
 * operator needs and exactly what a customer must not see. Access is a bearer
 * token held by the monitoring system; without one configured the endpoint does
 * not exist at all, which is the right default for something whose accidental
 * exposure is silent.
 */
async function handleMetricsRequest(
  dependencies: ApiDependencies,
  request: Request,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/metrics') return null;
  if (!dependencies.metrics) return null;
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'Only GET is supported', requestId, 405);

  // Constant-time comparison over digests, so a wrong token cannot be
  // distinguished from a nearly-right one by how long the rejection took.
  const presented = /^Bearer\s+(.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const expected = dependencies.metrics.scrapeToken;
  const [presentedDigest, expectedDigest] = await Promise.all([
    sha256Hex(new TextEncoder().encode(presented)),
    sha256Hex(new TextEncoder().encode(expected)),
  ]);
  if (presentedDigest !== expectedDigest) {
    return error('UNAUTHORIZED', 'A scrape credential is required', requestId, 401);
  }

  const body = await dependencies.metrics.render(new Date());
  return new Response(body, {
    status: 200,
    headers: {
      // The version suffix is what tells Prometheus this is the text exposition
      // format rather than something it should try to parse as OpenMetrics.
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  });
}

export function createApiHandler(dependencies: ApiDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = requestIdFrom(request);
    try {
      const metricsResponse = await handleMetricsRequest(dependencies, request, requestId);
      if (metricsResponse) return metricsResponse;
      const publicResponse = await handlePublicRequest(dependencies, request, requestId);
      if (publicResponse) return publicResponse;
      const authResponse = await handleAuthRequest(dependencies, request, requestId);
      if (authResponse) return authResponse;
      // Before resolveContext: a directory pushing users has no session, and
      // SCIM authenticates with its own tenant-scoped provisioning credential.
      const scimResponse = await handleScimRequest(dependencies, request, requestId);
      if (scimResponse) return scimResponse;
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
      const rotateMatch = /^\/v1\/webhook-endpoints\/([^/]+)\/rotate-secret$/.exec(url.pathname);
      if (request.method === 'POST' && rotateMatch) {
        await authorize(dependencies, context, 'webhook:manage');
        const endpointId = requireUuid(rotateMatch[1] ?? '', 'webhookEndpointId');
        const body = await readJson(request).catch(() => ({}));
        // The overlap window keeps the previous secret valid so a rotation does
        // not reject deliveries already in flight. Default is generous because
        // the alternative failure — a subscriber silently dropping events — is
        // much harder for them to notice than a key they rotated on purpose.
        const overlapSeconds = typeof (body as { overlapSeconds?: unknown }).overlapSeconds === 'number'
          ? Number((body as { overlapSeconds: number }).overlapSeconds) : 3600;
        if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 86_400) {
          throw new ApiRequestError('WEBHOOK_ROTATION_OVERLAP_INVALID', 'overlapSeconds must be between 0 and 86400', 400);
        }
        return json(await dependencies.webhooks.rotateSecret(context, endpointId, overlapSeconds), 200, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/webhook-deliveries') {
        await authorize(dependencies, context, 'webhook:manage');
        const status = url.searchParams.get('status') ?? undefined;
        if (status !== undefined && !['pending','delivering','delivered','failed','dead_letter'].includes(status)) {
          throw new ApiRequestError('WEBHOOK_DELIVERY_STATUS_INVALID', 'Unknown delivery status', 400);
        }
        return json(await dependencies.webhooks.listDeliveries(context, pageInput(url), status), 200, { 'x-request-id': requestId });
      }
      const replayMatch = /^\/v1\/webhook-deliveries\/([^/]+)\/replay$/.exec(url.pathname);
      if (request.method === 'POST' && replayMatch) {
        await authorize(dependencies, context, 'webhook:manage');
        const deliveryId = requireUuid(replayMatch[1] ?? '', 'webhookDeliveryId');
        return json(await dependencies.webhooks.replayDelivery(context, deliveryId), 202, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/retention/preview') {
        await authorize(dependencies, context, 'retention:manage');
        if (!dependencies.retention) throw new ApiRequestError('RETENTION_NOT_CONFIGURED', 'Retention is not configured', 503);
        const policyKey = url.searchParams.get('policyKey');
        if (!policyKey || !/^[a-z][a-z0-9_.-]{1,63}$/.test(policyKey)) {
          throw new ApiRequestError('RETENTION_POLICY_KEY_INVALID', 'A policyKey is required', 400);
        }
        // Preview is deliberately a read. Gallring is irreversible, so the step
        // that shows what would be destroyed must never destroy anything itself.
        return json(await dependencies.retention.preview(context, policyKey), 200, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/retention/jobs') {
        await authorize(dependencies, context, 'retention:manage');
        if (!dependencies.retention) throw new ApiRequestError('RETENTION_NOT_CONFIGURED', 'Retention is not configured', 503);
        return json(await dependencies.retention.list(context, pageInput(url)), 200, { 'x-request-id': requestId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/retention/jobs') {
        await authorize(dependencies, context, 'retention:manage');
        if (!dependencies.retention) throw new ApiRequestError('RETENTION_NOT_CONFIGURED', 'Retention is not configured', 503);
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parseGallringInput(await readJson(request));
        return json(
          await dependencies.retention.queue(context, input.policyKey, input.caseIds, idempotencyKey, await canonicalPayloadHash(input)),
          201, { 'x-request-id': requestId },
        );
      }
      const gallringGetMatch = /^\/v1\/retention\/jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && gallringGetMatch) {
        await authorize(dependencies, context, 'retention:manage');
        if (!dependencies.retention) throw new ApiRequestError('RETENTION_NOT_CONFIGURED', 'Retention is not configured', 503);
        return json(await dependencies.retention.get(context, requireUuid(gallringGetMatch[1] ?? '', 'gallringJobId')), 200, { 'x-request-id': requestId });
      }
      const gallringApproveMatch = /^\/v1\/retention\/jobs\/([^/]+)\/approve$/.exec(url.pathname);
      if (request.method === 'POST' && gallringApproveMatch) {
        // A separate permission from retention:manage, so the person who plans a
        // gallring and the person who authorises it can be different by role and
        // not only by intent.
        await authorize(dependencies, context, 'retention:execute');
        if (!dependencies.retention) throw new ApiRequestError('RETENTION_NOT_CONFIGURED', 'Retention is not configured', 503);
        return json(
          await dependencies.retention.approve(context, requireUuid(gallringApproveMatch[1] ?? '', 'gallringJobId')),
          202, { 'x-request-id': requestId },
        );
      }
      const grantMatch = /^\/v1\/signature-cases\/([^/]+)\/download-links$/.exec(url.pathname);
      if (request.method === 'POST' && grantMatch) {
        // The same grant that lets someone download the finished document, so
        // the same permission. Issuing a shareable link is a disclosure.
        await authorize(dependencies, context, 'document:download');
        if (!dependencies.delivery) throw new ApiRequestError('DELIVERY_NOT_CONFIGURED', 'Document delivery is not configured', 503);
        const input = parseDownloadLinkInput(await readJson(request).catch(() => ({})));
        return json(
          await dependencies.delivery.issue(context, {
            signatureCaseId: requireUuid(grantMatch[1] ?? '', 'signatureCaseId'),
            ...input,
          }),
          201, { 'x-request-id': requestId },
        );
      }
      const revokeGrantMatch = /^\/v1\/download-links\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'DELETE' && revokeGrantMatch) {
        await authorize(dependencies, context, 'document:download');
        if (!dependencies.delivery) throw new ApiRequestError('DELIVERY_NOT_CONFIGURED', 'Document delivery is not configured', 503);
        await dependencies.delivery.revoke(context, requireUuid(revokeGrantMatch[1] ?? '', 'grantId'));
        return new Response(null, { status: 204, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } });
      }
      if (request.method === 'POST' && url.pathname === '/v1/scim/clients') {
        await authorize(dependencies, context, 'integration:manage');
        if (!dependencies.scim) throw new ApiRequestError('SCIM_NOT_CONFIGURED', 'SCIM provisioning is not configured', 503);
        const input = parseScimClientInput(await readJson(request));
        // The token is in this response and nowhere else, ever again. It is
        // stored only as a hash, so there is nothing to show later — which is
        // the point: a token we could re-display is one we are still holding.
        return json(await dependencies.scim.issueClient(context, input), 201, { 'x-request-id': requestId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/privacy/requests') {
        await authorize(dependencies, context, 'privacy:manage');
        if (!dependencies.privacy) throw new ApiRequestError('PRIVACY_NOT_CONFIGURED', 'Rights requests are not configured', 503);
        const idempotencyKey = requireIdempotencyKey(request);
        const input = parsePrivacyRequestInput(await readJson(request));
        return json(
          await dependencies.privacy.record(context, input, idempotencyKey, await canonicalPayloadHash(input)),
          201, { 'x-request-id': requestId },
        );
      }
      if (request.method === 'GET' && url.pathname === '/v1/privacy/requests') {
        await authorize(dependencies, context, 'privacy:manage');
        if (!dependencies.privacy) throw new ApiRequestError('PRIVACY_NOT_CONFIGURED', 'Rights requests are not configured', 503);
        return json(await dependencies.privacy.list(context, pageInput(url)), 200, { 'x-request-id': requestId });
      }
      const privacyGetMatch = /^\/v1\/privacy\/requests\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && privacyGetMatch) {
        await authorize(dependencies, context, 'privacy:manage');
        if (!dependencies.privacy) throw new ApiRequestError('PRIVACY_NOT_CONFIGURED', 'Rights requests are not configured', 503);
        return json(
          await dependencies.privacy.get(context, requireUuid(privacyGetMatch[1] ?? '', 'privacyRequestId')),
          200, { 'x-request-id': requestId },
        );
      }
      const privacyExecuteMatch = /^\/v1\/privacy\/requests\/([^/]+)\/execute$/.exec(url.pathname);
      if (request.method === 'POST' && privacyExecuteMatch) {
        // A separate grant from recording. Searching and erasing someone's data
        // is a different act from noting that they asked for it, and the person
        // who logs a request should not thereby be able to destroy the record.
        await authorize(dependencies, context, 'privacy:execute');
        if (!dependencies.privacy) throw new ApiRequestError('PRIVACY_NOT_CONFIGURED', 'Rights requests are not configured', 503);
        return json(
          await dependencies.privacy.execute(context, requireUuid(privacyExecuteMatch[1] ?? '', 'privacyRequestId')),
          202, { 'x-request-id': requestId },
        );
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
