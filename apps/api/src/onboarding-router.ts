import type { PlatformPermission } from '../../../packages/authorization/src/index.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { normalizeEmail, normalizeOrganizationNumber } from '../../../packages/onboarding/src/index.js';
import { validateUploadMetadata } from '../../../packages/uploads/src/index.js';
import type {
  ApiDependencies, ApplicationDocumentInput, ApplicationProfile, CreateApplicationInput,
  DecisionInput, ExternalMessageInput, InformationRequestInput, InformationResponseInput,
  ReviewInput, UpdateApplicationInput,
} from './ports.js';

const MAX_JSON_BODY_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+\/-]{16,200}$/;
const ACCESS_TOKEN_PATTERN = /^[0-9a-f]{64,}$/i;

class OnboardingRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
  }
}

function response(body: unknown, status: number, requestId: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId, ...headers } });
}
function errorResponse(error: OnboardingRequestError, requestId: string): Response {
  return response({ error: { code: error.code, message: error.message, requestId, ...(error.details ? { details: error.details } : {}) } }, error.status, requestId);
}
function requireRepository(dependencies: ApiDependencies) {
  if (!dependencies.onboarding) throw new OnboardingRequestError('ONBOARDING_NOT_CONFIGURED', 'Onboarding runtime is not configured', 503);
  return dependencies.onboarding;
}
function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key');
  if (!value) throw new OnboardingRequestError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', 400);
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw new OnboardingRequestError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key has an invalid format', 400);
  return value;
}
function expectedVersion(request: Request): number | undefined {
  const value = request.headers.get('if-match');
  if (!value) return undefined;
  const parsed = Number(value.replace(/^W\//, '').replace(/^"|"$/g, ''));
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new OnboardingRequestError('IF_MATCH_INVALID', 'If-Match must contain a positive version', 400);
  return parsed;
}
function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new OnboardingRequestError('VALIDATION_ERROR', `${field} must be a UUID`, 422, { field });
  return value;
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OnboardingRequestError('VALIDATION_ERROR', 'JSON payload must be an object', 422);
  return value as Record<string, unknown>;
}
function allowed(value: Record<string, unknown>, keys: readonly string[]): void {
  const unsupported = Object.keys(value).filter((key) => !keys.includes(key));
  if (unsupported.length) throw new OnboardingRequestError('VALIDATION_ERROR', 'JSON payload contains unsupported fields', 422, { fields: unsupported });
}
function string(value: unknown, field: string, minimum = 1, maximum = 500): string {
  if (typeof value !== 'string') throw new OnboardingRequestError('VALIDATION_ERROR', `${field} must be a string`, 422, { field });
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new OnboardingRequestError('VALIDATION_ERROR', `${field} has an invalid length`, 422, { field });
  return normalized;
}
function optionalString(value: unknown, field: string, maximum = 500): string | undefined {
  return value === undefined ? undefined : string(value, field, 1, maximum);
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new OnboardingRequestError('VALIDATION_ERROR', `${field} must be a boolean`, 422, { field });
  return value;
}
async function readJson(request: Request, allowEmpty = false): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 && allowEmpty) return {};
  if (contentType !== 'application/json') throw new OnboardingRequestError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  if (bytes.length === 0) throw new OnboardingRequestError('INVALID_JSON', 'JSON payload is required', 400);
  if (bytes.length > MAX_JSON_BODY_BYTES) throw new OnboardingRequestError('PAYLOAD_TOO_LARGE', 'JSON payload is too large', 413);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new OnboardingRequestError('INVALID_JSON', 'JSON payload is malformed', 400); }
}
function hash(input: unknown): Promise<string> { return sha256Hex(canonicalJson(input as CanonicalJsonValue)); }

function parseCreate(value: unknown): CreateApplicationInput {
  const body = plain(value);
  allowed(body, ['organizationName','organizationNumber','organizationType','primaryEmail','primaryContactName','primaryContactTitle']);
  const types = ['municipality','region','municipal_federation','municipal_company','authority','public_supplier','other_public_body'] as const;
  if (typeof body.organizationType !== 'string' || !(types as readonly string[]).includes(body.organizationType)) throw new OnboardingRequestError('VALIDATION_ERROR', 'organizationType is invalid', 422);
  let organizationNumber: string;
  let primaryEmail: string;
  try { organizationNumber = normalizeOrganizationNumber(string(body.organizationNumber, 'organizationNumber', 10, 20)); }
  catch { throw new OnboardingRequestError('VALIDATION_ERROR', 'organizationNumber is invalid', 422); }
  try { primaryEmail = normalizeEmail(string(body.primaryEmail, 'primaryEmail', 3, 254)); }
  catch { throw new OnboardingRequestError('VALIDATION_ERROR', 'primaryEmail is invalid', 422); }
  return {
    organizationName: string(body.organizationName, 'organizationName', 2, 300), organizationNumber,
    organizationType: body.organizationType as CreateApplicationInput['organizationType'], primaryEmail,
    primaryContactName: string(body.primaryContactName, 'primaryContactName', 2, 200),
    primaryContactTitle: string(body.primaryContactTitle, 'primaryContactTitle', 2, 200),
  };
}
function parseProfile(value: unknown): ApplicationProfile {
  const body = plain(value);
  allowed(body, ['website','officialEmailDomain','municipalityOrRegion','postalAddress','billing','procurementReference','technicalContact','legalAndPrivacy','plannedUse','identityAndAccess','deployment']);
  const deployment = body.deployment === undefined ? undefined : plain(body.deployment);
  if (deployment) {
    allowed(deployment, ['mode','region','customDomain','estimatedStorageGb','classification']);
    if (!['shared_saas','dedicated_data_plane','customer_hosted'].includes(String(deployment.mode))) throw new OnboardingRequestError('VALIDATION_ERROR', 'deployment.mode is invalid', 422);
    if (deployment.estimatedStorageGb !== undefined && (!Number.isFinite(deployment.estimatedStorageGb) || Number(deployment.estimatedStorageGb) < 0)) throw new OnboardingRequestError('VALIDATION_ERROR', 'estimatedStorageGb is invalid', 422);
  }
  return body as ApplicationProfile;
}
function parseUpdate(value: unknown): UpdateApplicationInput {
  const body = plain(value); allowed(body, ['organizationName','primaryContactName','primaryContactTitle','profile']);
  const organizationName = optionalString(body.organizationName, 'organizationName', 300);
  const primaryContactName = optionalString(body.primaryContactName, 'primaryContactName', 200);
  const primaryContactTitle = optionalString(body.primaryContactTitle, 'primaryContactTitle', 200);
  const profile = body.profile === undefined ? undefined : parseProfile(body.profile);
  if (!organizationName && !primaryContactName && !primaryContactTitle && !profile) throw new OnboardingRequestError('VALIDATION_ERROR', 'At least one editable field is required', 422);
  return { ...(organizationName ? { organizationName } : {}), ...(primaryContactName ? { primaryContactName } : {}), ...(primaryContactTitle ? { primaryContactTitle } : {}), ...(profile ? { profile } : {}) };
}
function parseDocument(value: unknown): ApplicationDocumentInput {
  const body = plain(value); allowed(body, ['fileName','mimeType','byteSize','sha256','category']);
  try {
    const upload = validateUploadMetadata({ fileName: string(body.fileName,'fileName',1,200), mimeType: string(body.mimeType,'mimeType',1,100), byteSize: Number(body.byteSize), sha256: string(body.sha256,'sha256',64,64) }, { allowedMimeTypes: ['application/pdf'], maximumBytes: 100 * 1024 * 1024 });
    return { ...upload, category: string(body.category,'category',2,80) };
  } catch { throw new OnboardingRequestError('VALIDATION_ERROR', 'Document metadata is invalid', 422); }
}
function parseMessage(value: unknown): ExternalMessageInput {
  const body = plain(value); allowed(body, ['body','attachmentIds']);
  const attachmentIds = body.attachmentIds === undefined ? undefined : parseUuidArray(body.attachmentIds, 'attachmentIds');
  return { body: string(body.body,'body',1,10000), ...(attachmentIds ? { attachmentIds } : {}) };
}
function parseUuidArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) throw new OnboardingRequestError('VALIDATION_ERROR', `${field} is invalid`, 422);
  return value.map((item) => requireUuid(string(item, field, 36, 36), field));
}
function parseInformationRequest(value: unknown): InformationRequestInput {
  const body = plain(value); allowed(body, ['category','question','dueAt','attachmentRequired']);
  const categories = ['commercial','legal','security','technical','organization','other'];
  if (typeof body.category !== 'string' || !categories.includes(body.category)) throw new OnboardingRequestError('VALIDATION_ERROR', 'category is invalid', 422);
  const dueAt = optionalString(body.dueAt, 'dueAt', 40);
  if (dueAt && Number.isNaN(Date.parse(dueAt))) throw new OnboardingRequestError('VALIDATION_ERROR', 'dueAt is invalid', 422);
  return { category: body.category as InformationRequestInput['category'], question: string(body.question,'question',3,5000), attachmentRequired: boolean(body.attachmentRequired,'attachmentRequired'), ...(dueAt ? { dueAt } : {}) };
}
function parseInformationResponse(value: unknown): InformationResponseInput {
  const body = plain(value); allowed(body, ['answer','attachmentIds']);
  const attachmentIds = body.attachmentIds === undefined ? undefined : parseUuidArray(body.attachmentIds, 'attachmentIds');
  return { answer: string(body.answer,'answer',1,10000), ...(attachmentIds ? { attachmentIds } : {}) };
}
function parseReview(value: unknown): ReviewInput {
  const body = plain(value); allowed(body, ['reviewType','result','summary','riskLevel']);
  if (!['commercial','legal','security','technical'].includes(String(body.reviewType))) throw new OnboardingRequestError('VALIDATION_ERROR','reviewType is invalid',422);
  if (!['pending','passed','failed','requires_information'].includes(String(body.result))) throw new OnboardingRequestError('VALIDATION_ERROR','result is invalid',422);
  const riskLevel = optionalString(body.riskLevel,'riskLevel',20);
  if (riskLevel && !['low','medium','high','critical'].includes(riskLevel)) throw new OnboardingRequestError('VALIDATION_ERROR','riskLevel is invalid',422);
  return { reviewType: body.reviewType as ReviewInput['reviewType'], result: body.result as ReviewInput['result'], summary: string(body.summary,'summary',1,5000), ...(riskLevel ? { riskLevel: riskLevel as 'low' | 'medium' | 'high' | 'critical' } : {}) };
}
function parseDecision(value: unknown): DecisionInput {
  const body = plain(value); allowed(body, ['reason','internalReason','conditions','validUntil','secondApproverId']);
  const internalReason = optionalString(body.internalReason,'internalReason',5000);
  const validUntil = optionalString(body.validUntil,'validUntil',40);
  if (validUntil && Number.isNaN(Date.parse(validUntil))) throw new OnboardingRequestError('VALIDATION_ERROR','validUntil is invalid',422);
  const secondApproverId = body.secondApproverId === undefined ? undefined : requireUuid(string(body.secondApproverId,'secondApproverId',36,36),'secondApproverId');
  const conditions = body.conditions === undefined ? undefined : (() => { if (!Array.isArray(body.conditions) || body.conditions.length > 30) throw new OnboardingRequestError('VALIDATION_ERROR','conditions is invalid',422); return body.conditions.map((item) => string(item,'conditions',1,500)); })();
  return { reason: string(body.reason,'reason',2,5000), ...(internalReason ? { internalReason } : {}), ...(conditions ? { conditions } : {}), ...(validUntil ? { validUntil } : {}), ...(secondApproverId ? { secondApproverId } : {}) };
}
function accessToken(request: Request): string {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? request.headers.get('x-kommunsign-application-token');
  if (!token || !ACCESS_TOKEN_PATTERN.test(token)) throw new OnboardingRequestError('APPLICATION_AUTH_REQUIRED', 'A valid applicant access token is required', 401);
  return token;
}
async function platformContext(dependencies: ApiDependencies, request: Request, permission: PlatformPermission) {
  if (!dependencies.resolvePlatformContext || !dependencies.authorizePlatform) throw new OnboardingRequestError('PLATFORM_AUTH_NOT_CONFIGURED','Platform authentication is not configured',503);
  const context = await dependencies.resolvePlatformContext(request);
  try { await dependencies.authorizePlatform(context, permission); }
  catch { throw new OnboardingRequestError('FORBIDDEN','The platform subject is not authorized',403); }
  return context;
}
function known(cause: unknown): OnboardingRequestError {
  if (cause instanceof OnboardingRequestError) return cause;
  const message = cause instanceof Error ? cause.message : '';
  const map: Readonly<Record<string, readonly [number,string]>> = {
    NOT_FOUND:[404,'NOT_FOUND'], APPLICATION_ACCESS_DENIED:[403,'APPLICATION_ACCESS_DENIED'], APPLICATION_TOKEN_EXPIRED:[401,'APPLICATION_TOKEN_EXPIRED'],
    INVALID_APPLICATION_STATE_TRANSITION:[409,'INVALID_APPLICATION_STATE_TRANSITION'], IDEMPOTENCY_CONFLICT:[409,'IDEMPOTENCY_KEY_REUSED'],
    RESOURCE_VERSION_CONFLICT:[412,'RESOURCE_VERSION_CONFLICT'], EMAIL_VERIFICATION_TOKEN_INVALID:[400,'EMAIL_VERIFICATION_TOKEN_INVALID'],
    EMAIL_VERIFICATION_EXPIRED:[410,'EMAIL_VERIFICATION_EXPIRED'], TWO_PERSON_APPROVAL_REQUIRED:[409,'TWO_PERSON_APPROVAL_REQUIRED'],
    TENANT_NOT_READY_FOR_ACTIVATION:[409,'TENANT_NOT_READY_FOR_ACTIVATION'], REQUIRED_REVIEWS_NOT_PASSED:[409,'REQUIRED_REVIEWS_NOT_PASSED'],
    POSSIBLE_DUPLICATE_APPLICATION:[409,'POSSIBLE_DUPLICATE_APPLICATION'],
  };
  const item = map[message];
  return item ? new OnboardingRequestError(item[1], item[1].replace(/_/g,' '), item[0]) : new OnboardingRequestError('INTERNAL_ERROR','The request could not be completed',500);
}

export async function handleOnboardingRequest(dependencies: ApiDependencies, request: Request, requestId: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/onboarding/') && !url.pathname.startsWith('/v1/platform/onboarding/') && !url.pathname.startsWith('/v1/platform/provisioning/') && !url.pathname.startsWith('/v1/platform/tenants/') && !url.pathname.startsWith('/v1/platform/activation-requests/')) return null;
  try {
    const repository = requireRepository(dependencies);
    if (request.method === 'POST' && url.pathname === '/v1/onboarding/applications') {
      const key = requireIdempotencyKey(request); const input = parseCreate(await readJson(request));
      return response(await repository.create(input,key,await hash(input)),201,requestId);
    }
    const verifyMatch = url.pathname.match(/^\/v1\/onboarding\/applications\/([^/]+)\/verify-email$/);
    if (request.method === 'POST' && verifyMatch) {
      const applicationId = requireUuid(verifyMatch[1] ?? '','applicationId'); const key = requireIdempotencyKey(request); const body = plain(await readJson(request)); allowed(body,['token']); const token = string(body.token,'token',64,200);
      return response(await repository.verifyEmail(applicationId,token,key,await hash({ applicationId,token })),200,requestId);
    }
    const resendMatch = url.pathname.match(/^\/v1\/onboarding\/applications\/([^/]+)\/resend-verification$/);
    if (request.method === 'POST' && resendMatch) {
      const applicationId = requireUuid(resendMatch[1] ?? '','applicationId'); const key = requireIdempotencyKey(request);
      return response(await repository.resendVerification(applicationId,key,await hash({ applicationId,operation:'resend' })),202,requestId);
    }
    const responseMatch = url.pathname.match(/^\/v1\/onboarding\/information-requests\/([^/]+)\/responses$/);
    if (request.method === 'POST' && responseMatch) {
      const body = plain(await readJson(request)); allowed(body,['applicationId','answer','attachmentIds']);
      const applicationId = requireUuid(string(body.applicationId,'applicationId',36,36),'applicationId');
      const context = await repository.resolveApplicant(applicationId,accessToken(request),requestId); const input = parseInformationResponse({ answer: body.answer, attachmentIds: body.attachmentIds }); const key = requireIdempotencyKey(request);
      return response(await repository.respondToInformationRequest(context,requireUuid(responseMatch[1] ?? '','requestId'),input,key,await hash(input)),201,requestId);
    }
    const applicantMatch = url.pathname.match(/^\/v1\/onboarding\/applications\/([^/]+)(?:\/(documents|submit|withdraw|messages|information-requests))?$/);
    if (applicantMatch) {
      const applicationId = requireUuid(applicantMatch[1] ?? '','applicationId'); const action = applicantMatch[2];
      const context = await repository.resolveApplicant(applicationId,accessToken(request),requestId);
      if (request.method === 'GET' && !action) return response(await repository.get(context),200,requestId);
      if (request.method === 'PATCH' && !action) { const key=requireIdempotencyKey(request); const input=parseUpdate(await readJson(request)); const result=await repository.update(context,input,expectedVersion(request),key,await hash(input)); return response(result,200,requestId,{etag:`"${result.statusVersion}"`}); }
      if (request.method === 'POST' && action === 'documents') { const key=requireIdempotencyKey(request); const input=parseDocument(await readJson(request)); return response(await repository.addDocument(context,input,key,await hash(input)),201,requestId); }
      if (request.method === 'POST' && action === 'submit') { const key=requireIdempotencyKey(request); const result=await repository.submit(context,expectedVersion(request),key,await hash({applicationId,operation:'submit'})); return response(result,200,requestId,{etag:`"${result.statusVersion}"`}); }
      if (request.method === 'POST' && action === 'withdraw') { const key=requireIdempotencyKey(request); const result=await repository.withdraw(context,expectedVersion(request),key,await hash({applicationId,operation:'withdraw'})); return response(result,200,requestId,{etag:`"${result.statusVersion}"`}); }
      if (request.method === 'GET' && action === 'messages') return response(await repository.listMessages(context),200,requestId);
      if (request.method === 'POST' && action === 'messages') { const key=requireIdempotencyKey(request); const input=parseMessage(await readJson(request)); return response(await repository.createMessage(context,input,key,await hash(input)),201,requestId); }
      if (request.method === 'GET' && action === 'information-requests') return response(await repository.listInformationRequests(context),200,requestId);
    }
    if (request.method === 'GET' && url.pathname === '/v1/platform/onboarding/applications') {
      const context=await platformContext(dependencies,request,'onboarding:read'); const filters=Object.fromEntries([...url.searchParams].filter(([key])=>!['limit','cursor'].includes(key)));
      const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit')??50))); const cursor=url.searchParams.get('cursor')??undefined;
      return response(await repository.platformList(context,{limit,...(cursor?{cursor}:{})},filters),200,requestId);
    }
    const platformApp = url.pathname.match(/^\/v1\/platform\/onboarding\/applications\/([^/]+)(?:\/(assign|reviews|information-requests|approve|reject|provision|audit))?$/);
    if (platformApp) {
      const applicationId=requireUuid(platformApp[1]??'','applicationId'); const action=platformApp[2];
      if (request.method==='GET' && !action) { const context=await platformContext(dependencies,request,'onboarding:read'); const result=await repository.platformGet(context,applicationId); return result?response(result,200,requestId):response({error:{code:'NOT_FOUND',message:'Application not found',requestId}},404,requestId); }
      if (request.method==='GET' && action==='audit') { const context=await platformContext(dependencies,request,'platform:audit_read'); return response(await repository.audit(context,applicationId),200,requestId); }
      const key=requireIdempotencyKey(request);
      if (request.method==='POST' && action==='assign') { const context=await platformContext(dependencies,request,'onboarding:assign'); const body=plain(await readJson(request)); allowed(body,['assigneeId']); const assigneeId=requireUuid(string(body.assigneeId,'assigneeId',36,36),'assigneeId'); return response(await repository.assign(context,applicationId,assigneeId,key,await hash(body)),200,requestId); }
      if (request.method==='POST' && action==='reviews') { const context=await platformContext(dependencies,request,'onboarding:review'); const input=parseReview(await readJson(request)); return response(await repository.addReview(context,applicationId,input,key,await hash(input)),201,requestId); }
      if (request.method==='POST' && action==='information-requests') { const context=await platformContext(dependencies,request,'onboarding:request_information'); const input=parseInformationRequest(await readJson(request)); return response(await repository.requestInformation(context,applicationId,input,key,await hash(input)),201,requestId); }
      if (request.method==='POST' && action==='approve') { const context=await platformContext(dependencies,request,'onboarding:decide'); const input=parseDecision(await readJson(request)); return response(await repository.approve(context,applicationId,input,key,await hash(input)),200,requestId); }
      if (request.method==='POST' && action==='reject') { const context=await platformContext(dependencies,request,'onboarding:decide'); const input=parseDecision(await readJson(request)); return response(await repository.reject(context,applicationId,input,key,await hash(input)),200,requestId); }
      if (request.method==='POST' && action==='provision') { const context=await platformContext(dependencies,request,'onboarding:provision'); return response(await repository.provision(context,applicationId,key,await hash({applicationId,operation:'provision'})),202,requestId); }
    }
    const provisioning=url.pathname.match(/^\/v1\/platform\/provisioning\/requests\/([^/]+)(?:\/(retry))?$/);
    if (provisioning) { const context=await platformContext(dependencies,request,'onboarding:provision'); const id=requireUuid(provisioning[1]??'','requestId'); if(request.method==='GET'&&!provisioning[2]){const result=await repository.getProvisioning(context,id);return result?response(result,200,requestId):response({error:{code:'NOT_FOUND',message:'Provisioning request not found',requestId}},404,requestId);} if(request.method==='POST'&&provisioning[2]==='retry'){const key=requireIdempotencyKey(request);return response(await repository.retryProvisioning(context,id,key,await hash({id,operation:'retry'})),202,requestId);} }
    const readiness=url.pathname.match(/^\/v1\/platform\/tenants\/([^/]+)\/readiness(?:\/(run))?$/);
    if(readiness){const context=await platformContext(dependencies,request,'tenant:readiness');const tenantId=requireUuid(readiness[1]??'','tenantId');if(request.method==='GET'&&!readiness[2]){const result=await repository.getReadiness(context,tenantId);return result?response(result,200,requestId):response({error:{code:'NOT_FOUND',message:'Readiness result not found',requestId}},404,requestId);}if(request.method==='POST'&&readiness[2]==='run'){const key=requireIdempotencyKey(request);return response(await repository.runReadiness(context,tenantId,key,await hash({tenantId,operation:'readiness'})),200,requestId);} }
    const activationCreate=url.pathname.match(/^\/v1\/platform\/tenants\/([^/]+)\/activation-requests$/);
    if(request.method==='POST'&&activationCreate){const context=await platformContext(dependencies,request,'tenant:activation_request');const tenantId=requireUuid(activationCreate[1]??'','tenantId');const key=requireIdempotencyKey(request);return response(await repository.createActivationRequest(context,tenantId,key,await hash({tenantId,operation:'activation-request'})),202,requestId);}
    const activationDecision=url.pathname.match(/^\/v1\/platform\/activation-requests\/([^/]+)\/(approve|reject)$/);
    if(request.method==='POST'&&activationDecision){const context=await platformContext(dependencies,request,'tenant:activation_approve');const id=requireUuid(activationDecision[1]??'','requestId');const body=plain(await readJson(request));allowed(body,['reason']);const reason=string(body.reason,'reason',2,5000);const key=requireIdempotencyKey(request);return response(await repository.decideActivation(context,id,activationDecision[2] as 'approve'|'reject',reason,key,await hash({reason,decision:activationDecision[2]})),200,requestId);}
    return response({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId } },404,requestId);
  } catch (cause) {
    const mapped=known(cause); if(mapped.status===500) dependencies.reportError?.(cause,requestId); return errorResponse(mapped,requestId);
  }
}
