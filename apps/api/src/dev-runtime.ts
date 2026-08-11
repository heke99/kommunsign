import { authorizeDevPlatform, devOnboardingRepository, resolveDevPlatformContext } from './dev-onboarding.js';
import { requirePermission, TENANT_ROLES, type TenantRole } from '../../../packages/authorization/src/index.js';
import type { DomainEvent, TenantContext } from '../../../packages/contracts/src/index.js';
import { createApiHandler } from './router.js';
import type {
  AddDocumentInput, AddSignerInput, CaseRepository, CreateCaseInput, DocumentView, EventRepository,
  Page, PageInput, SignatureCaseView, SignaturePolicyView, SignerView, TemplateInput, TemplateRepository, TemplateView,
  UploadGrantInput, UploadGrantView, UploadRepository, WebhookEndpointInput, WebhookEndpointView, WebhookRepository,
} from './ports.js';

const DEFAULT_TENANT = '11111111-1111-4111-8111-111111111111';
const DEFAULT_SUBJECT = '22222222-2222-4222-8222-222222222222';

interface IdempotencyRecord<T> { readonly payloadHash: string; readonly response: T; }
interface DevCaseMetadata { readonly policyId: string; readonly createdBy: string; readonly updatedAt: string; }
const idempotency = new Map<string, IdempotencyRecord<unknown>>();
const cases = new Map<string, SignatureCaseView>();
const caseMetadata = new Map<string, DevCaseMetadata>();
const documents = new Map<string, DocumentView>();
const signers = new Map<string, SignerView>();
const uploads = new Map<string, UploadGrantView>();
const endpoints = new Map<string, WebhookEndpointView>();
const templates = new Map<string, TemplateView>();
const events: DomainEvent[] = [];
const rolesBySubject = new Map<string, readonly TenantRole[]>();
const signaturePolicies: readonly SignaturePolicyView[] = [
  { id: '33333333-3333-4333-8333-333333333333', version: 1, name: 'Elektronisk underskrift', decisionMode: 'ELECTRONIC_SIGNATURE', active: true },
  { id: '44444444-4444-4444-8444-444444444444', version: 1, name: 'Digitalt godkännande', decisionMode: 'DIGITAL_APPROVAL', active: true },
];

function tenantKey(tenantId: string, id: string): string { return `${tenantId}:${id}`; }
function idempotent<T>(tenantId: string, operation: string, key: string, payloadHash: string, create: () => T): T {
  const storageKey = `${tenantId}:${operation}:${key}`;
  const existing = idempotency.get(storageKey);
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
    return existing.response as T;
  }
  const response = create();
  idempotency.set(storageKey, { payloadHash, response });
  return response;
}
function addEvent(tenantId: string, type: string, data: Readonly<Record<string, unknown>>): void {
  events.push({ id: crypto.randomUUID(), tenantId, type, occurredAt: new Date().toISOString(), apiVersion: '2026-08-01', data });
}
function paginate<T>(rows: readonly T[], page: PageInput): Page<T> {
  const offset = page.cursor ? Number.parseInt(page.cursor, 10) : 0;
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const data = rows.slice(safeOffset, safeOffset + page.limit);
  const next = safeOffset + data.length;
  return { data, ...(next < rows.length ? { nextCursor: String(next) } : {}) };
}
function requireCase(context: TenantContext, id: string): SignatureCaseView {
  const value = cases.get(tenantKey(context.tenantId, id));
  if (!value) throw new Error('NOT_FOUND');
  return value;
}
function caseEventMatches(event: DomainEvent, tenantId: string, caseId: string): boolean {
  return event.tenantId === tenantId && (event.data as Readonly<Record<string, unknown>>).signatureCaseId === caseId;
}
function getCaseDetail(context: TenantContext, id: string): SignatureCaseView | null {
  const storageKey = tenantKey(context.tenantId, id);
  const value = cases.get(storageKey);
  if (!value) return null;
  const metadata = caseMetadata.get(storageKey);
  const policy = metadata ? signaturePolicies.find((item) => item.id === metadata.policyId) : undefined;
  const caseDocuments = [...documents.entries()]
    .filter(([keyName, item]) => keyName.startsWith(`${context.tenantId}:`) && item.signatureCaseId === id)
    .map(([, item], index) => ({ ...item, version: 1, role: 'SIGNABLE', ordinal: index + 1, pdfProfile: null, scanResult: null, processingResult: null }));
  const caseSigners = [...signers.entries()]
    .filter(([keyName, item]) => keyName.startsWith(`${context.tenantId}:`) && item.signatureCaseId === id)
    .map(([, item]) => item);
  const caseEvents = events.filter((event) => caseEventMatches(event, context.tenantId, id)).map((event) => ({
    id: event.id, type: event.type, occurredAt: event.occurredAt,
  }));
  return {
    ...value,
    ...(policy ? { policy: { id: policy.id, version: policy.version, snapshot: { decisionMode: policy.decisionMode } } } : {}),
    ...(metadata ? { createdBy: metadata.createdBy, updatedAt: metadata.updatedAt } : { updatedAt: value.createdAt }),
    documents: caseDocuments,
    signers: caseSigners,
    events: caseEvents,
    evidenceAvailable: false,
    archiveCompleted: false,
  } as SignatureCaseView;
}
function updateCase(context: TenantContext, id: string, status: SignatureCaseView['status'], expectedVersion?: number): SignatureCaseView {
  const current = requireCase(context, id);
  const version = current.statusVersion ?? 1;
  if (expectedVersion !== undefined && expectedVersion !== version) throw new Error('RESOURCE_VERSION_CONFLICT');
  const updated = { ...current, status, statusVersion: version + 1 };
  const storageKey = tenantKey(context.tenantId, id);
  cases.set(storageKey, updated);
  const metadata = caseMetadata.get(storageKey);
  if (metadata) caseMetadata.set(storageKey, { ...metadata, updatedAt: new Date().toISOString() });
  addEvent(context.tenantId, `signature_case.${status}`, { signatureCaseId: id, statusVersion: updated.statusVersion ?? 1 });
  return updated;
}

const caseRepository: CaseRepository = {
  async listPolicies() { return signaturePolicies; },
  async create(context, input: CreateCaseInput, key, payloadHash) {
    return idempotent(context.tenantId, 'case:create', key, payloadHash, () => {
      const policy=signaturePolicies.find((item)=>item.id===input.signaturePolicyId&&item.active);
      if(!policy)throw new Error('SIGNATURE_POLICY_NOT_FOUND');
      if(policy.decisionMode!==input.decisionMode)throw new Error('SIGNATURE_POLICY_DECISION_MODE_MISMATCH');
      const value: SignatureCaseView = {
        id: crypto.randomUUID(), tenantId: context.tenantId, status: 'draft', statusVersion: 1,
        decisionMode: input.decisionMode, title: input.title, createdAt: new Date().toISOString(),
        ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      };
      const storageKey = tenantKey(context.tenantId, value.id);
      cases.set(storageKey, value);
      caseMetadata.set(storageKey, { policyId: policy.id, createdBy: context.subjectId, updatedAt: value.createdAt });
      addEvent(context.tenantId, 'signature_case.created', { signatureCaseId: value.id });
      return value;
    });
  },
  async get(context, id) { return getCaseDetail(context, id); },
  async list(context, page) { return paginate([...cases.values()].filter((item) => item.tenantId === context.tenantId), page); },
  async addDocument(context, id, input: AddDocumentInput, key, payloadHash) {
    requireCase(context, id);
    const upload = uploads.get(tenantKey(context.tenantId, input.uploadId));
    if (!upload) throw new Error('NOT_FOUND');
    return idempotent(context.tenantId, `case:${id}:document`, key, payloadHash, () => {
      const value: DocumentView = {
        id: crypto.randomUUID(), signatureCaseId: id, displayName: input.displayName, status: 'quarantined',
        sha256: upload.sha256, byteSize: upload.byteSize, mimeType: upload.mimeType,
      };
      documents.set(tenantKey(context.tenantId, value.id), value);
      addEvent(context.tenantId, 'document.quarantined', { signatureCaseId: id, documentId: value.id });
      return value;
    });
  },
  async addSigner(context, id, input: AddSignerInput, key, payloadHash) {
    requireCase(context, id);
    return idempotent(context.tenantId, `case:${id}:signer`, key, payloadHash, () => {
      const value: SignerView = {
        id: crypto.randomUUID(), signatureCaseId: id, displayName: input.displayName,
        maskedEmail: input.email.replace(/^(.).*@/, '$1•••@'),
        identifierBindingMode: input.personalNumber ? 'STRICT_PREBOUND' : 'BANKID_DISCOVERED',
        ...(input.personalNumber ? { maskedPersonalNumber: `${input.personalNumber.slice(0,4)}••••-${input.personalNumber.slice(8)}` } : {}),
        ...(input.personalNumberException ? { identifierBindingExceptionCode: input.personalNumberException.code } : {}),
        status: 'pending', required: input.required, signingOrder: input.signingOrder,
      };
      signers.set(tenantKey(context.tenantId, value.id), value);
      addEvent(context.tenantId, 'signer.added', { signatureCaseId: id, signerId: value.id });
      return value;
    });
  },
  async updateSigner(context, id, signerId, input, key, payloadHash) {
    requireCase(context,id);
    return idempotent(context.tenantId, `case:${id}:signer:${signerId}:update`, key, payloadHash, () => {
      const current=signers.get(tenantKey(context.tenantId,signerId)); if(!current||current.signatureCaseId!==id) throw new Error('NOT_FOUND');
      const value: SignerView={id:current.id,signatureCaseId:id,displayName:input.displayName,maskedEmail:input.email.replace(/^(.).*@/,'$1•••@'),identifierBindingMode:input.personalNumber?'STRICT_PREBOUND':'BANKID_DISCOVERED',status:current.status,required:input.required,signingOrder:input.signingOrder,...(input.personalNumber?{maskedPersonalNumber:`${input.personalNumber.slice(0,4)}••••-${input.personalNumber.slice(8)}`}:{ }),...(input.personalNumberException?{identifierBindingExceptionCode:input.personalNumberException.code}:{ })};
      signers.set(tenantKey(context.tenantId,signerId),value); return value;
    });
  },
  async send(context, id, key, payloadHash, expectedVersion) {
    return idempotent(context.tenantId, `case:${id}:send`, key, payloadHash, () => {
      const current = requireCase(context, id);
      if (current.status !== 'draft' && current.status !== 'ready') throw new Error('RESOURCE_VERSION_CONFLICT');
      const hasDocument = [...documents.entries()].some(([keyName, item]) => keyName.startsWith(`${context.tenantId}:`) && item.signatureCaseId === id);
      const hasSigner = [...signers.entries()].some(([keyName, item]) => keyName.startsWith(`${context.tenantId}:`) && item.signatureCaseId === id && item.required);
      if (!hasDocument || !hasSigner) throw new Error('RESOURCE_VERSION_CONFLICT');
      return updateCase(context, id, 'sent', expectedVersion);
    });
  },
  async cancel(context, id, key, payloadHash, expectedVersion) {
    return idempotent(context.tenantId, `case:${id}:cancel`, key, payloadHash, () => updateCase(context, id, 'cancelled', expectedVersion));
  },
  async remind(context, id, key, payloadHash) {
    requireCase(context, id);
    return idempotent(context.tenantId, `case:${id}:remind`, key, payloadHash, () => {
      const jobId = crypto.randomUUID();
      addEvent(context.tenantId, 'reminder.queued', { signatureCaseId: id, jobId });
      return { jobId, status: 'queued' as const };
    });
  },
  async signedDocument(context, id) { requireCase(context, id); throw new Error('SIGN_SERVICE_NOT_CONFIGURED'); },
  async validationReport(context, id) { requireCase(context, id); throw new Error('VALIDATION_SERVICE_NOT_CONFIGURED'); },
  async evidencePackage(context, id) { requireCase(context, id); throw new Error('EVIDENCE_PACKAGE_NOT_READY'); },
};

const uploadRepository: UploadRepository = {
  async create(context, input: UploadGrantInput, key, payloadHash) {
    return idempotent(context.tenantId, 'upload:create', key, payloadHash, () => {
      const id = crypto.randomUUID();
      const value: UploadGrantView = {
        ...input, id, uploadUrl: `http://127.0.0.1:9000/kommunsign-quarantine/${context.tenantId}/${id}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        requiredHeaders: { 'content-type': input.mimeType, 'x-amz-checksum-sha256': input.sha256 },
      };
      uploads.set(tenantKey(context.tenantId, id), value);
      addEvent(context.tenantId, 'upload.grant_created', { uploadId: id });
      return value;
    });
  },
  async complete(context, uploadId, key, payloadHash) {
    return idempotent(context.tenantId, `upload:${uploadId}:complete`, key, payloadHash, () => {
      const upload=uploads.get(tenantKey(context.tenantId,uploadId)); if(!upload) throw new Error('NOT_FOUND');
      return { id:uploadId,status:'uploaded' as const,sha256:upload.sha256,byteSize:upload.byteSize };
    });
  },
};
const webhookRepository: WebhookRepository = {
  async createEndpoint(context, input: WebhookEndpointInput, key, payloadHash) {
    return idempotent(context.tenantId, 'webhook:create', key, payloadHash, () => {
      const value: WebhookEndpointView = { ...input, id: crypto.randomUUID(), active: true, createdAt: new Date().toISOString() };
      endpoints.set(tenantKey(context.tenantId, value.id), value);
      addEvent(context.tenantId, 'webhook.endpoint_created', { webhookEndpointId: value.id });
      return value;
    });
  },
};
const eventRepository: EventRepository = {
  async list(context, page) { return paginate(events.filter((event) => event.tenantId === context.tenantId), page); },
};
const templateRepository: TemplateRepository = {
  async list(context, page) { return paginate([...templates.entries()].filter(([keyName]) => keyName.startsWith(`${context.tenantId}:`)).map(([, item]) => item), page); },
  async create(context, input: TemplateInput, key, payloadHash) {
    return idempotent(context.tenantId, 'template:create', key, payloadHash, () => {
      const rawId = crypto.randomUUID();
      const value: TemplateView = { ...input, id: rawId, version: 1, active: false };
      templates.set(tenantKey(context.tenantId, rawId), value);
      addEvent(context.tenantId, 'notification_template.created', { templateId: rawId, templateKey: input.templateKey });
      return value;
    });
  },
};

function parseRoles(request: Request, subjectId: string): readonly TenantRole[] {
  const requested = request.headers.get('x-kommunsign-roles')?.split(',').map((role) => role.trim()).filter(Boolean) ?? ['tenant_admin'];
  const roles = requested.filter((role): role is TenantRole => (TENANT_ROLES as readonly string[]).includes(role));
  if (roles.length === 0) throw new Error('NO_VALID_ROLE');
  rolesBySubject.set(subjectId, roles);
  return roles;
}

if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.APP_ENV === 'production') {
  throw new Error('DEVELOPMENT_RUNTIME_FORBIDDEN_IN_PRODUCTION');
}

export function createHandler() {
  return createApiHandler({
    cases: caseRepository, uploads: uploadRepository, webhooks: webhookRepository, events: eventRepository, templates: templateRepository,
    onboarding: devOnboardingRepository,
    resolvePlatformContext: async (request) => resolveDevPlatformContext(request),
    authorizePlatform: authorizeDevPlatform,
    resolveContext: async (request) => {
      const tenantId = request.headers.get('x-kommunsign-tenant-id') ?? DEFAULT_TENANT;
      const subjectId = request.headers.get('x-kommunsign-subject-id') ?? DEFAULT_SUBJECT;
      parseRoles(request, subjectId);
      return { tenantId, subjectId, source: 'api-client', requestId: request.headers.get('x-request-id') ?? crypto.randomUUID(), authMethod: 'development' };
    },
    authorize: (context, permission) => requirePermission(rolesBySubject.get(context.subjectId) ?? [], permission),
    reportError: (cause, requestId) => console.error(JSON.stringify({ level: 'error', code: 'API_INTERNAL_ERROR', requestId, cause: cause instanceof Error ? cause.name : typeof cause })),
  });
}
