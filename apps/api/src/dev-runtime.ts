import { authorizeDevPlatform, devOnboardingRepository, resolveDevPlatformContext } from './dev-onboarding.js';
import { requirePermission, TENANT_ROLES, type TenantRole } from '../../../packages/authorization/src/index.js';
import type { DomainEvent, TenantContext } from '../../../packages/contracts/src/index.js';
import { createApiHandler } from './router.js';
import type {
  AddDocumentInput, AddSignerInput, CaseRepository, CreateCaseInput, DocumentView, EventRepository,
  Page, PageInput, SignatureCaseView, SignerView, TemplateInput, TemplateRepository, TemplateView,
  UploadGrantInput, UploadGrantView, UploadRepository, WebhookEndpointInput, WebhookEndpointView, WebhookRepository,
} from './ports.js';

const DEFAULT_TENANT = '11111111-1111-4111-8111-111111111111';
const DEFAULT_SUBJECT = '22222222-2222-4222-8222-222222222222';

interface IdempotencyRecord<T> { readonly payloadHash: string; readonly response: T; }
const idempotency = new Map<string, IdempotencyRecord<unknown>>();
const cases = new Map<string, SignatureCaseView>();
const documents = new Map<string, DocumentView>();
const signers = new Map<string, SignerView>();
const uploads = new Map<string, UploadGrantView>();
const endpoints = new Map<string, WebhookEndpointView>();
const templates = new Map<string, TemplateView>();
const events: DomainEvent[] = [];
const rolesBySubject = new Map<string, readonly TenantRole[]>();

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
function updateCase(context: TenantContext, id: string, status: SignatureCaseView['status'], expectedVersion?: number): SignatureCaseView {
  const current = requireCase(context, id);
  const version = current.statusVersion ?? 1;
  if (expectedVersion !== undefined && expectedVersion !== version) throw new Error('RESOURCE_VERSION_CONFLICT');
  const updated = { ...current, status, statusVersion: version + 1 };
  cases.set(tenantKey(context.tenantId, id), updated);
  addEvent(context.tenantId, `signature_case.${status}`, { signatureCaseId: id, statusVersion: updated.statusVersion ?? 1 });
  return updated;
}

const caseRepository: CaseRepository = {
  async create(context, input: CreateCaseInput, key, payloadHash) {
    return idempotent(context.tenantId, 'case:create', key, payloadHash, () => {
      const value: SignatureCaseView = {
        id: crypto.randomUUID(), tenantId: context.tenantId, status: 'draft', statusVersion: 1,
        decisionMode: input.decisionMode, title: input.title, createdAt: new Date().toISOString(),
        ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      };
      cases.set(tenantKey(context.tenantId, value.id), value);
      addEvent(context.tenantId, 'signature_case.created', { signatureCaseId: value.id });
      return value;
    });
  },
  async get(context, id) { return cases.get(tenantKey(context.tenantId, id)) ?? null; },
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
        id: crypto.randomUUID(), signatureCaseId: id, recipientReference: input.recipientReference,
        status: 'pending', required: input.required,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.signingOrder ? { signingOrder: input.signingOrder } : {}),
      };
      signers.set(tenantKey(context.tenantId, value.id), value);
      addEvent(context.tenantId, 'signer.added', { signatureCaseId: id, signerId: value.id });
      return value;
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
