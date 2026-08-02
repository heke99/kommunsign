import { requirePlatformPermission, PLATFORM_ROLES, type PlatformPermission, type PlatformRole } from '../../../packages/authorization/src/index.js';
import type { ApplicantContext, PlatformContext } from '../../../packages/contracts/src/index.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { randomToken } from '../../../packages/crypto/src/tokens.js';
import {
  assertApplicationTransition, assertDistinctApprovers, createEmailVerification,
  formatApplicationReference, verifyEmailToken, type EmailVerificationRecord,
} from '../../../packages/onboarding/src/index.js';
import { evaluateReadiness, type ReadinessCheck, type ReadinessResult } from '../../../packages/readiness/src/index.js';
import type {
  ActivationRequestView, ApplicationCreatedView, ApplicationDocumentInput, ApplicationDocumentView,
  ApplicationView, CreateApplicationInput, DecisionInput, ExternalMessageInput, ExternalMessageView,
  InformationRequestInput, InformationRequestView, InformationResponseInput, OnboardingRepository,
  Page, PageInput, ProvisioningRequestView, ReviewInput, UpdateApplicationInput,
} from './ports.js';

interface StoredAccess { readonly applicationId: string; readonly tokenHash: string; readonly expiresAt: string; readonly subjectId: string; }
interface StoredReview extends ReviewInput { readonly reviewerId: string; readonly createdAt: string; }
interface IdempotencyRecord { readonly payloadHash: string; readonly response: unknown; }

const applications = new Map<string, ApplicationView>();
const accessTokens = new Map<string, StoredAccess>();
const verifications = new Map<string, EmailVerificationRecord>();
const verificationTokens = new Map<string, string>();
const documents = new Map<string, ApplicationDocumentView>();
const messages = new Map<string, ExternalMessageView[]>();
const informationRequests = new Map<string, InformationRequestView>();
const reviews = new Map<string, StoredReview[]>();
const provisioning = new Map<string, ProvisioningRequestView>();
const readiness = new Map<string, ReadinessResult>();
const activation = new Map<string, ActivationRequestView>();
const audit = new Map<string, Readonly<Record<string, unknown>>[]>();
const idempotency = new Map<string, IdempotencyRecord>();
const platformRolesBySubject = new Map<string, readonly PlatformRole[]>();
let referenceSequence = 0;

async function idempotent<T>(scope: string, operation: string, key: string, payloadHash: string, create: () => T | Promise<T>): Promise<T> {
  const storageKey = `${scope}:${operation}:${key}`;
  const existing = idempotency.get(storageKey);
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
    return existing.response as T;
  }
  const response = await create();
  idempotency.set(storageKey, { payloadHash, response });
  return response;
}
function now(): string { return new Date().toISOString(); }
function addAudit(applicationId: string, actorId: string, eventType: string, payload: Readonly<Record<string, unknown>> = {}): void {
  const items = audit.get(applicationId) ?? [];
  items.push({ id: crypto.randomUUID(), applicationId, actorId, eventType, payload, occurredAt: now() });
  audit.set(applicationId, items);
}
function requireApplication(id: string): ApplicationView {
  const value = applications.get(id);
  if (!value) throw new Error('NOT_FOUND');
  return value;
}
function saveApplication(value: ApplicationView): ApplicationView { applications.set(value.id, value); return value; }
function transition(application: ApplicationView, status: ApplicationView['status'], actorId: string): ApplicationView {
  assertApplicationTransition(application.status, status);
  const updated: ApplicationView = {
    ...application, status, statusVersion: application.statusVersion + 1, updatedAt: now(),
    ...(status === 'submitted' ? { submittedAt: now() } : {}),
    ...(['approved','rejected'].includes(status) ? { decidedAt: now() } : {}),
  };
  saveApplication(updated); addAudit(application.id, actorId, `onboarding.application.${status}`, { previousStatus: application.status, statusVersion: updated.statusVersion });
  return updated;
}
function verifyVersion(application: ApplicationView, expectedVersion?: number): void {
  if (expectedVersion !== undefined && expectedVersion !== application.statusVersion) throw new Error('RESOURCE_VERSION_CONFLICT');
}
function paginate<T>(rows: readonly T[], page: PageInput): Page<T> {
  const offset = page.cursor ? Number.parseInt(page.cursor,10) : 0; const safe = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const data = rows.slice(safe,safe+page.limit); const next = safe+data.length;
  return { data, ...(next < rows.length ? { nextCursor: String(next) } : {}) };
}
async function issueVerification(application: ApplicationView): Promise<string> {
  const result = await createEmailVerification({ applicationId: application.id, email: application.primaryEmail, expiresAt: new Date(Date.now()+30*60*1000).toISOString() });
  const prior = verifications.get(application.id);
  if (prior) verifications.set(application.id,{...prior,revokedAt:now()});
  verifications.set(application.id,result.record); verificationTokens.set(application.id,result.token);
  return result.token;
}
function editable(application: ApplicationView): boolean { return ['draft','email_verification_pending','email_verified','additional_information_requested','resubmitted'].includes(application.status); }
function requiredReviewsPassed(applicationId: string): boolean {
  const latest = new Map<string, StoredReview>();
  for (const review of reviews.get(applicationId) ?? []) latest.set(review.reviewType,review);
  return ['commercial','legal','security','technical'].every((type)=>latest.get(type)?.result === 'passed');
}
function maximumRisk(applicationId: string): 'low'|'medium'|'high'|'critical' {
  const order = ['low','medium','high','critical'] as const; let max = 0;
  for (const review of reviews.get(applicationId) ?? []) { const index = review.riskLevel ? order.indexOf(review.riskLevel) : 0; max = Math.max(max,index); }
  return order[max] ?? 'low';
}

export const devOnboardingRepository: OnboardingRepository = {
  async create(input: CreateApplicationInput, key, payloadHash) {
    return idempotent('public','application:create',key,payloadHash,async () => {
      const duplicate = [...applications.values()].some((item)=>item.organizationNumber===input.organizationNumber && !['rejected','withdrawn','archived'].includes(item.status));
      const id = crypto.randomUUID(); const createdAt=now();
      const application: ApplicationView = { id,status:'email_verification_pending',statusVersion:1,organizationName:input.organizationName,organizationNumber:input.organizationNumber,organizationType:input.organizationType,primaryEmail:input.primaryEmail,primaryContactName:input.primaryContactName,primaryContactTitle:input.primaryContactTitle,profile:{},createdAt,updatedAt:createdAt };
      saveApplication(application);
      const accessToken=randomToken(32); const tokenHash=await sha256Hex(accessToken);
      accessTokens.set(id,{applicationId:id,tokenHash,expiresAt:new Date(Date.now()+30*24*60*60*1000).toISOString(),subjectId:`applicant:${id}`});
      addAudit(id,`applicant:${id}`,'onboarding.application.created',{possibleDuplicate:duplicate});
      const developmentVerificationToken=await issueVerification(application);
      const result: ApplicationCreatedView = { application,accessToken,verificationRequired:true,developmentVerificationToken };
      return result;
    });
  },
  async resolveApplicant(applicationId, accessToken, requestId): Promise<ApplicantContext> {
    const record=accessTokens.get(applicationId); if(!record) throw new Error('APPLICATION_ACCESS_DENIED');
    if(Date.now()>=Date.parse(record.expiresAt)) throw new Error('APPLICATION_TOKEN_EXPIRED');
    if(record.tokenHash!==await sha256Hex(accessToken)) throw new Error('APPLICATION_ACCESS_DENIED');
    return {applicationId,subjectId:record.subjectId,requestId};
  },
  async get(context){ return requireApplication(context.applicationId); },
  async update(context,input:UpdateApplicationInput,expectedVersion,key,payloadHash){
    return idempotent(context.applicationId,'application:update',key,payloadHash,()=>{const current=requireApplication(context.applicationId);verifyVersion(current,expectedVersion);if(!editable(current))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');const updated:ApplicationView={...current,...input,profile:input.profile?{...current.profile,...input.profile}:current.profile,statusVersion:current.statusVersion+1,updatedAt:now()};saveApplication(updated);addAudit(current.id,context.subjectId,'onboarding.application.updated',{statusVersion:updated.statusVersion});return updated;});
  },
  async verifyEmail(applicationId,token,key,payloadHash){
    return idempotent(applicationId,'application:verify-email',key,payloadHash,async()=>{const latest=requireApplication(applicationId);const record=verifications.get(applicationId);if(!record)throw new Error('EMAIL_VERIFICATION_TOKEN_INVALID');await verifyEmailToken(record,token,latest.primaryEmail);verifications.set(applicationId,{...record,usedAt:now()});const updated=transition(latest,'email_verified',`applicant:${applicationId}`);return saveApplication({...updated,emailVerifiedAt:now()});});
  },
  async resendVerification(applicationId,key,payloadHash){
    const current=requireApplication(applicationId); if(current.status!=='email_verification_pending')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
    const existing=idempotent(applicationId,'application:resend-verification',key,payloadHash,()=>({accepted:true as const})); const token=await issueVerification(current); return {...existing,developmentVerificationToken:token};
  },
  async addDocument(context,input:ApplicationDocumentInput,key,payloadHash){
    return idempotent(context.applicationId,'application:document',key,payloadHash,()=>{const application=requireApplication(context.applicationId);if(!editable(application))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');const value:ApplicationDocumentView={...input,id:crypto.randomUUID(),applicationId:application.id,status:'quarantined',createdAt:now()};documents.set(value.id,value);addAudit(application.id,context.subjectId,'onboarding.document.quarantined',{documentId:value.id,category:value.category});return value;});
  },
  async submit(context,expectedVersion,key,payloadHash){
    return idempotent(context.applicationId,'application:submit',key,payloadHash,()=>{const current=requireApplication(context.applicationId);verifyVersion(current,expectedVersion);if(current.status!=='email_verified'&&current.status!=='resubmitted')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');referenceSequence+=1;const withReference=current.applicationReference?current:{...current,applicationReference:formatApplicationReference(new Date().getUTCFullYear(),referenceSequence)};saveApplication(withReference);return transition(withReference,'submitted',context.subjectId);});
  },
  async withdraw(context,expectedVersion,key,payloadHash){return idempotent(context.applicationId,'application:withdraw',key,payloadHash,()=>{const current=requireApplication(context.applicationId);verifyVersion(current,expectedVersion);return transition(current,'withdrawn',context.subjectId);});},
  async listMessages(context){return messages.get(context.applicationId)??[];},
  async createMessage(context,input:ExternalMessageInput,key,payloadHash){return idempotent(context.applicationId,'application:message',key,payloadHash,()=>{requireApplication(context.applicationId);const value:ExternalMessageView={...input,id:crypto.randomUUID(),applicationId:context.applicationId,direction:'applicant_to_platform',createdAt:now()};messages.set(context.applicationId,[...(messages.get(context.applicationId)??[]),value]);addAudit(context.applicationId,context.subjectId,'onboarding.message.received',{messageId:value.id});return value;});},
  async listInformationRequests(context){return [...informationRequests.values()].filter((item)=>item.applicationId===context.applicationId);},
  async respondToInformationRequest(context,requestId,input:InformationResponseInput,key,payloadHash){return idempotent(context.applicationId,`information-request:${requestId}:response`,key,payloadHash,()=>{const request=informationRequests.get(requestId);if(!request||request.applicationId!==context.applicationId)throw new Error('NOT_FOUND');if(request.status!=='open')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');const answered={...request,status:'answered' as const};informationRequests.set(requestId,answered);const message:ExternalMessageView={id:crypto.randomUUID(),applicationId:context.applicationId,direction:'applicant_to_platform',body:input.answer,...(input.attachmentIds?{attachmentIds:input.attachmentIds}:{}),createdAt:now()};messages.set(context.applicationId,[...(messages.get(context.applicationId)??[]),message]);const app=requireApplication(context.applicationId);if(app.status==='additional_information_requested')transition(app,'resubmitted',context.subjectId);addAudit(context.applicationId,context.subjectId,'onboarding.information_response.created',{requestId});return answered;});},
  async platformList(_context,page,filters){let rows=[...applications.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));if(filters.status)rows=rows.filter((item)=>item.status===filters.status);if(filters.organizationType)rows=rows.filter((item)=>item.organizationType===filters.organizationType);if(filters.assignedTo)rows=rows.filter((item)=>item.assignedTo===filters.assignedTo);return paginate(rows,page);},
  async platformGet(_context,applicationId){return applications.get(applicationId)??null;},
  async assign(context,applicationId,assigneeId,key,payloadHash){return idempotent(applicationId,'platform:assign',key,payloadHash,()=>{const current=requireApplication(applicationId);const updated=saveApplication({...current,assignedTo:assigneeId,statusVersion:current.statusVersion+1,updatedAt:now()});addAudit(applicationId,context.subjectId,'onboarding.application.assigned',{assigneeId});return updated;});},
  async addReview(context,applicationId,input:ReviewInput,key,payloadHash){return idempotent(applicationId,`platform:review:${input.reviewType}`,key,payloadHash,()=>{let current=requireApplication(applicationId);if(current.status==='submitted')current=transition(current,'under_initial_review',context.subjectId);const review:StoredReview={...input,reviewerId:context.subjectId,createdAt:now()};reviews.set(applicationId,[...(reviews.get(applicationId)??[]),review]);if(input.result==='requires_information'&&current.status!=='additional_information_requested')current=transition(current,'additional_information_requested',context.subjectId);else if(input.result==='passed'){const target=`${input.reviewType}_review` as ApplicationView['status'];if(current.status!==target&&['under_initial_review','resubmitted','commercial_review','legal_review','security_review','technical_review'].includes(current.status)){try{current=transition(current,target,context.subjectId);}catch{}}}addAudit(applicationId,context.subjectId,'onboarding.review.recorded',{reviewType:input.reviewType,result:input.result,riskLevel:input.riskLevel??'low'});return current;});},
  async requestInformation(context,applicationId,input:InformationRequestInput,key,payloadHash){return idempotent(applicationId,'platform:information-request',key,payloadHash,()=>{let app=requireApplication(applicationId);const value:InformationRequestView={...input,id:crypto.randomUUID(),applicationId,status:'open',createdAt:now()};informationRequests.set(value.id,value);if(app.status!=='additional_information_requested')app=transition(app,'additional_information_requested',context.subjectId);const message:ExternalMessageView={id:crypto.randomUUID(),applicationId,direction:'platform_to_applicant',body:input.question,createdAt:now()};messages.set(applicationId,[...(messages.get(applicationId)??[]),message]);addAudit(applicationId,context.subjectId,'onboarding.information_request.created',{requestId:value.id});return value;});},
  async approve(context,applicationId,input:DecisionInput,key,payloadHash){return idempotent(applicationId,'platform:approve',key,payloadHash,()=>{const current=requireApplication(applicationId);if(!requiredReviewsPassed(applicationId))throw new Error('REQUIRED_REVIEWS_NOT_PASSED');const risk=maximumRisk(applicationId);if(risk==='high'||risk==='critical'){if(!input.secondApproverId)throw new Error('TWO_PERSON_APPROVAL_REQUIRED');assertDistinctApprovers(context.subjectId,input.secondApproverId);}const updated=transition(current,'approved',context.subjectId);addAudit(applicationId,context.subjectId,'onboarding.decision.approved',{reason:input.reason,conditions:input.conditions??[],risk,secondApproverId:input.secondApproverId??null});return updated;});},
  async reject(context,applicationId,input:DecisionInput,key,payloadHash){return idempotent(applicationId,'platform:reject',key,payloadHash,()=>{const current=requireApplication(applicationId);const updated=transition(current,'rejected',context.subjectId);addAudit(applicationId,context.subjectId,'onboarding.decision.rejected',{reason:input.reason});return updated;});},
  async provision(context,applicationId,key,payloadHash){return idempotent(applicationId,'platform:provision',key,payloadHash,()=>{let app=requireApplication(applicationId);if(app.status!=='approved'&&app.status!=='provisioning_failed')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');app=transition(app,'provisioning',context.subjectId);const tenantId=app.tenantId??crypto.randomUUID();const updatedApp=transition(saveApplication({...app,tenantId}),'onboarding',context.subjectId);saveApplication(updatedApp);const createdAt=now();const request:ProvisioningRequestView={id:crypto.randomUUID(),applicationId,tenantId,status:'completed',currentStep:'onboarding_checklist_created',attempts:1,createdAt,updatedAt:createdAt};provisioning.set(request.id,request);addAudit(applicationId,context.subjectId,'tenant.provisioning.completed',{requestId:request.id,tenantId});return request;});},
  async audit(_context,applicationId){requireApplication(applicationId);return audit.get(applicationId)??[];},
  async getProvisioning(_context,requestId){return provisioning.get(requestId)??null;},
  async retryProvisioning(context,requestId,key,payloadHash){const current=provisioning.get(requestId);if(!current)throw new Error('NOT_FOUND');return idempotent(current.applicationId,`provisioning:${requestId}:retry`,key,payloadHash,()=>{if(!['failed','partially_completed','retry_scheduled'].includes(current.status))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');const updated={...current,status:'completed' as const,attempts:current.attempts+1,currentStep:'onboarding_checklist_created',updatedAt:now()};provisioning.set(requestId,updated);addAudit(current.applicationId,context.subjectId,'tenant.provisioning.retried',{requestId});return updated;});},
  async runReadiness(_context,tenantId,key,payloadHash){return idempotent(tenantId,'readiness:run',key,payloadHash,()=>{const checkedAt=now();const checks:ReadinessCheck[]=[
    {code:'TENANT_DATABASE_NOT_READY',passed:true,severity:'blocking',checkedAt,evidence:{mode:'development'}},
    {code:'OBJECT_STORAGE_NOT_READY',passed:false,severity:'blocking',checkedAt},
    {code:'OIDC_NOT_CONFIGURED',passed:false,severity:'blocking',checkedAt},
    {code:'SIGN_SERVICE_NOT_CONFIGURED',passed:false,severity:'blocking',checkedAt},
    {code:'VALIDATION_SERVICE_NOT_CONFIGURED',passed:false,severity:'blocking',checkedAt},
    {code:'ACCEPTANCE_TEST_NOT_PASSED',passed:false,severity:'blocking',checkedAt},
  ];const result=evaluateReadiness('production',checks);readiness.set(tenantId,result);return result;});},
  async getReadiness(_context,tenantId){return readiness.get(tenantId)??null;},
  async createActivationRequest(context,tenantId,key,payloadHash){return idempotent(tenantId,'activation:create',key,payloadHash,()=>{const result=readiness.get(tenantId);if(!result?.ready)throw new Error('TENANT_NOT_READY_FOR_ACTIVATION');const createdAt=now();const value:ActivationRequestView={id:crypto.randomUUID(),tenantId,requestedBy:context.subjectId,status:'pending_approval',createdAt};activation.set(value.id,value);return value;});},
  async decideActivation(context,requestId,decision,reason,key,payloadHash){const current=activation.get(requestId);if(!current)throw new Error('NOT_FOUND');return idempotent(current.tenantId,`activation:${requestId}:${decision}`,key,payloadHash,()=>{assertDistinctApprovers(current.requestedBy,context.subjectId);const updated:ActivationRequestView={...current,status:decision==='approve'?'activated':'rejected',decidedAt:now()};activation.set(requestId,updated);const app=[...applications.values()].find((item)=>item.tenantId===current.tenantId);if(app&&decision==='approve'&&app.status==='ready_for_activation')transition(app,'active',context.subjectId);if(app)addAudit(app.id,context.subjectId,`tenant.activation.${decision}`,{requestId,reason});return updated;});},
};

export function resolveDevPlatformContext(request: Request): PlatformContext {
  const subjectId=request.headers.get('x-kommunsign-platform-subject-id')??'99999999-9999-4999-8999-999999999999';
  const requested=request.headers.get('x-kommunsign-platform-roles')?.split(',').map((role)=>role.trim()).filter(Boolean)??['platform_super_admin'];
  const roles=requested.filter((role):role is PlatformRole=>(PLATFORM_ROLES as readonly string[]).includes(role));
  if(!roles.length)throw new Error('NO_VALID_PLATFORM_ROLE');platformRolesBySubject.set(subjectId,roles);
  return {subjectId,requestId:request.headers.get('x-request-id')??crypto.randomUUID()};
}
export function authorizeDevPlatform(context: PlatformContext, permission: PlatformPermission): void { requirePlatformPermission(platformRolesBySubject.get(context.subjectId)??[],permission); }
