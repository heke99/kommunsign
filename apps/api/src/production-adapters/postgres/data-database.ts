import type { TenantContext, DomainEvent, SignatureCaseStatus } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { assertSafeWebhookUrl } from '../../../../../packages/webhooks/src/index.js';
import type {
  AddDocumentInput, AddSignerInput, CaseRepository, CreateCaseInput, DocumentView, EventRepository,
  Page, PageInput, SignatureCaseView, SignerView, TemplateInput, TemplateRepository, TemplateView,
  UploadGrantInput, UploadGrantView, UploadRepository, WebhookEndpointInput, WebhookEndpointView, WebhookRepository,
  DownloadArtifact,
} from '../../ports.js';
import type { ProductionInfrastructure } from './infrastructure.js';

export interface DataRepositories {
  readonly cases: CaseRepository;
  readonly uploads: UploadRepository;
  readonly webhooks: WebhookRepository;
  readonly events: EventRepository;
  readonly templates: TemplateRepository;
}

export function createDataRepositories(database: SqlDatabase, infrastructure: ProductionInfrastructure): DataRepositories {
  const cases = createCaseRepository(database, infrastructure);
  return {
    cases,
    uploads: createUploadRepository(database, infrastructure),
    webhooks: createWebhookRepository(database),
    events: createEventRepository(database),
    templates: createTemplateRepository(database),
  };
}

export function createCaseRepository(database: SqlDatabase, infrastructure: ProductionInfrastructure): CaseRepository {
  return {
    async create(context, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, 'case:create', key, payloadHash, async () => {
        const userId = await requireUserId(transaction, context);
        const policy = await transaction.query<{ readonly id: string; readonly version: number; readonly decision_mode: CreateCaseInput['decisionMode']; readonly policy: Readonly<Record<string, unknown>> }>(
          `select id, version, decision_mode::text as decision_mode, policy
             from app.signature_policies
            where tenant_id = $1 and id = $2 and active = true
            order by version desc limit 1`,
          [context.tenantId, input.signaturePolicyId],
        );
        const policyRow = policy.rows[0];
        if (!policyRow) throw new Error('SIGNATURE_POLICY_NOT_FOUND');
        if (policyRow.decision_mode !== input.decisionMode) throw new Error('SIGNATURE_POLICY_DECISION_MODE_MISMATCH');
        const inserted = await transaction.query<CaseRow>(
          `insert into app.signature_cases
             (tenant_id, created_by, external_reference, title, decision_mode, policy_id, policy_version, policy_snapshot)
           values ($1, $2, $3, $4, $5::app.decision_mode, $6, $7, $8::jsonb)
           returning id, tenant_id, status::text as status, status_version, decision_mode::text as decision_mode,
                     title, external_reference, created_at`,
          [context.tenantId, userId, input.externalReference ?? null, cleanText(input.title, 1, 300), input.decisionMode, policyRow.id, policyRow.version, JSON.stringify(policyRow.policy)],
        );
        const view = caseView(requireRow(inserted.rows[0], 'CASE_INSERT_FAILED'));
        await appendOutbox(transaction, context.tenantId, 'signature_case', view.id, 'signature_case.created', { signatureCaseId: view.id });
        return view;
      }));
    },
    async get(context, id) {
      return tenantTx(database, context, async (transaction) => {
        const result = await transaction.query<CaseRow>(`${caseSelect} where tenant_id = $1 and id = $2`, [context.tenantId, id]);
        return result.rows[0] ? caseView(result.rows[0]) : null;
      });
    },
    async list(context, page) {
      return tenantTx(database, context, async (transaction) => {
        const { offset, limit } = pageBounds(page);
        const result = await transaction.query<CaseRow>(`${caseSelect} where tenant_id = $1 order by created_at desc, id desc offset $2 limit $3`, [context.tenantId, offset, limit + 1]);
        return pageResult(result.rows.map(caseView), offset, limit);
      });
    },
    async addDocument(context, id, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:document`, key, payloadHash, async () => {
        await requireCase(transaction, context.tenantId, id, ['draft','preparing','ready']);
        const upload = await transaction.query<UploadRow>(
          `select id, object_key, file_name, mime_type, byte_size, expected_sha256, status
             from app.upload_grants where tenant_id = $1 and id = $2 for update`, [context.tenantId, input.uploadId],
        );
        const grant = upload.rows[0];
        if (!grant) throw new Error('UPLOAD_GRANT_NOT_FOUND');
        if (grant.status !== 'uploaded') throw new Error('UPLOAD_NOT_CONFIRMED');
        const document = await transaction.query<{ readonly id: string }>(
          `insert into app.documents(tenant_id, signature_case_id, display_name) values ($1,$2,$3) returning id`,
          [context.tenantId, id, cleanText(input.displayName, 1, 300)],
        );
        const documentId = requireRow(document.rows[0], 'DOCUMENT_INSERT_FAILED').id;
        const version = await transaction.query<DocumentRow>(
          `insert into app.document_versions
             (tenant_id, document_id, version, status, source_object_key, mime_type, byte_size, sha256)
           values ($1,$2,1,'quarantined',$3,$4,$5,$6)
           returning id, document_id, status::text as status, sha256, byte_size, mime_type`,
          [context.tenantId, documentId, grant.object_key, grant.mime_type, grant.byte_size, grant.expected_sha256],
        );
        await transaction.query(`update app.upload_grants set status = 'consumed', consumed_at = now() where tenant_id = $1 and id = $2`, [context.tenantId, input.uploadId]);
        const row = requireRow(version.rows[0], 'DOCUMENT_VERSION_INSERT_FAILED');
        const view: DocumentView = { id: documentId, signatureCaseId: id, displayName: input.displayName, status: normalizeDocumentStatus(row.status), sha256: row.sha256, byteSize: Number(row.byte_size), mimeType: row.mime_type };
        await appendOutbox(transaction, context.tenantId, 'document', documentId, 'document.quarantined', { signatureCaseId: id, documentId, documentVersionId: row.id });
        return view;
      }));
    },
    async addSigner(context, id, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:signer`, key, payloadHash, async () => {
        await requireCase(transaction, context.tenantId, id, ['draft','preparing','ready']);
        const inserted = await transaction.query<SignerRow>(
          `insert into app.signers
             (tenant_id, signature_case_id, display_name, recipient_reference, expected_identifier_type, status, signing_order, required)
           values ($1,$2,$3,$4,$5,'pending',$6,$7)
           returning id, signature_case_id, display_name, recipient_reference, status::text as status, signing_order, required`,
          [context.tenantId, id, input.displayName ? cleanText(input.displayName, 1, 200) : null, cleanText(input.recipientReference, 8, 512), input.identifierType ?? null, input.signingOrder ?? null, input.required],
        );
        const view = signerView(requireRow(inserted.rows[0], 'SIGNER_INSERT_FAILED'));
        await appendOutbox(transaction, context.tenantId, 'signer', view.id, 'signer.added', { signatureCaseId: id, signerId: view.id });
        return view;
      }));
    },
    async send(context, id, key, payloadHash, expectedVersion) {
      return transitionCase(database, context, id, 'sent', key, payloadHash, expectedVersion, async (transaction, current) => {
        if (!['draft','ready'].includes(current.status)) throw new Error('CASE_NOT_SENDABLE');
        const evidence = await transaction.query<{ readonly documents_ready: boolean; readonly signer_ready: boolean }>(
          `select
             exists(select 1 from app.documents d join app.document_versions v on v.tenant_id=d.tenant_id and v.document_id=d.id
                     where d.tenant_id=$1 and d.signature_case_id=$2 and v.status='ready') as documents_ready,
             exists(select 1 from app.signers s where s.tenant_id=$1 and s.signature_case_id=$2 and s.required) as signer_ready`,
          [context.tenantId, id],
        );
        const row = requireRow(evidence.rows[0], 'CASE_SEND_EVIDENCE_FAILED');
        if (!row.documents_ready || !row.signer_ready) throw new Error('CASE_SEND_EVIDENCE_INCOMPLETE');
      });
    },
    async cancel(context, id, key, payloadHash, expectedVersion) {
      return transitionCase(database, context, id, 'cancelled', key, payloadHash, expectedVersion);
    },
    async remind(context, id, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:remind`, key, payloadHash, async () => {
        await requireCase(transaction, context.tenantId, id, ['sent','in_progress','partially_signed']);
        const queued = await infrastructure.queue.enqueue({ tenantId: context.tenantId, jobType: 'signature_case.reminder', idempotencyKey: key, payload: { signatureCaseId: id, requestedBy: context.subjectId } });
        await appendOutbox(transaction, context.tenantId, 'signature_case', id, 'reminder.queued', { signatureCaseId: id, jobId: queued.jobId });
        return { jobId: queued.jobId, status: 'queued' as const };
      }));
    },
    async signedDocument(context, id) {
      return downloadCaseArtifact(database, infrastructure, context, id, 'signed_document');
    },
    async validationReport(context, id) {
      return downloadCaseArtifact(database, infrastructure, context, id, 'validation_report');
    },
    async evidencePackage(context, id) {
      return downloadCaseArtifact(database, infrastructure, context, id, 'evidence_package');
    },
  };
}

export function createUploadRepository(database: SqlDatabase, infrastructure: ProductionInfrastructure): UploadRepository {
  return {
    async create(context, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, 'upload:create', key, payloadHash, async () => {
        const userId = await requireUserId(transaction, context);
        validateUpload(input);
        const id = crypto.randomUUID();
        const safeFileName = cleanFileName(input.fileName);
        const objectKey = `${context.tenantId}/quarantine/${id}/${safeFileName}`;
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const grant = await infrastructure.objectStorage.createUploadGrant(context, { ...input, fileName: safeFileName, objectKey, expiresAt });
        await transaction.query(
          `insert into app.upload_grants
             (tenant_id,id,object_key,file_name,mime_type,byte_size,expected_sha256,status,expires_at,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9)`,
          [context.tenantId, id, objectKey, safeFileName, input.mimeType, input.byteSize, input.sha256, expiresAt, userId],
        );
        return { id, fileName: safeFileName, mimeType: input.mimeType, byteSize: input.byteSize, sha256: input.sha256, uploadUrl: grant.uploadUrl, expiresAt, requiredHeaders: grant.requiredHeaders };
      }));
    },
  };
}

export function createWebhookRepository(database: SqlDatabase): WebhookRepository {
  return {
    async createEndpoint(context, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, 'webhook:create', key, payloadHash, async () => {
        const parsed = assertSafeWebhookUrl(input.url);
        const inserted = await transaction.query<WebhookRow>(
          `insert into app.webhook_endpoints(tenant_id,url,secret_current_ref,subscribed_events,active)
           values ($1,$2,$3,$4,true)
           returning id,url,subscribed_events,active,created_at`,
          [context.tenantId, parsed.toString(), `vault://webhooks/${context.tenantId}/${crypto.randomUUID()}`, input.subscribedEvents],
        );
        return webhookView(requireRow(inserted.rows[0], 'WEBHOOK_INSERT_FAILED'));
      }));
    },
  };
}

export function createEventRepository(database: SqlDatabase): EventRepository {
  return {
    async list(context, page) {
      return tenantTx(database, context, async (transaction) => {
        const { offset, limit } = pageBounds(page);
        const result = await transaction.query<OutboxRow>(
          `select id,event_type,payload,occurred_at from app.outbox_events
            where tenant_id=$1 order by occurred_at desc,id desc offset $2 limit $3`,
          [context.tenantId, offset, limit + 1],
        );
        return pageResult(result.rows.map((row): DomainEvent => ({ id: row.id, tenantId: context.tenantId, type: row.event_type, occurredAt: iso(row.occurred_at), apiVersion: '2026-08-01', data: row.payload })), offset, limit);
      });
    },
  };
}

export function createTemplateRepository(database: SqlDatabase): TemplateRepository {
  return {
    async list(context, page) {
      return tenantTx(database, context, async (transaction) => {
        const { offset, limit } = pageBounds(page);
        const result = await transaction.query<TemplateRow>(
          `select id,template_key,version,locale,subject_template,body_template,active
             from app.notification_templates where tenant_id=$1
            order by template_key,locale,version desc offset $2 limit $3`,
          [context.tenantId, offset, limit + 1],
        );
        return pageResult(result.rows.map(templateView), offset, limit);
      });
    },
    async create(context, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, 'template:create', key, payloadHash, async () => {
        const current = await transaction.query<{ readonly next_version: number }>(
          `select coalesce(max(version),0)+1 as next_version from app.notification_templates
            where tenant_id=$1 and template_key=$2 and locale=$3`,
          [context.tenantId, input.templateKey, input.locale],
        );
        const version = Number(requireRow(current.rows[0], 'TEMPLATE_VERSION_FAILED').next_version);
        const inserted = await transaction.query<TemplateRow>(
          `insert into app.notification_templates
             (tenant_id,template_key,version,locale,subject_template,body_template,active)
           values ($1,$2,$3,$4,$5,$6,false)
           returning id,template_key,version,locale,subject_template,body_template,active`,
          [context.tenantId, cleanText(input.templateKey, 2, 100), version, cleanText(input.locale, 2, 20), cleanText(input.subjectTemplate, 1, 500), cleanText(input.bodyTemplate, 1, 50_000)],
        );
        return templateView(requireRow(inserted.rows[0], 'TEMPLATE_INSERT_FAILED'));
      }));
    },
  };
}

async function transitionCase(
  database: SqlDatabase, context: TenantContext, id: string, status: SignatureCaseStatus,
  key: string, payloadHash: string, expectedVersion?: number,
  before?: (transaction: SqlTransaction, current: CaseRow) => Promise<void>,
): Promise<SignatureCaseView> {
  return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:${status}`, key, payloadHash, async () => {
    const current = await requireCase(transaction, context.tenantId, id);
    if (expectedVersion !== undefined && Number(current.status_version) !== expectedVersion) throw new Error('RESOURCE_VERSION_CONFLICT');
    if (before) await before(transaction, current);
    const updated = await transaction.query<CaseRow>(
      `update app.signature_cases set status=$3::app.case_status,status_version=status_version+1,updated_at=now(),
              sent_at=case when $3='sent' then coalesce(sent_at,now()) else sent_at end
        where tenant_id=$1 and id=$2 and status_version=$4
        returning id,tenant_id,status::text as status,status_version,decision_mode::text as decision_mode,title,external_reference,created_at`,
      [context.tenantId, id, status, current.status_version],
    );
    const view = caseView(requireRow(updated.rows[0], 'RESOURCE_VERSION_CONFLICT'));
    await appendOutbox(transaction, context.tenantId, 'signature_case', id, `signature_case.${status}`, { signatureCaseId: id, statusVersion: view.statusVersion ?? 1 });
    return view;
  }));
}

async function downloadCaseArtifact(database: SqlDatabase, infrastructure: ProductionInfrastructure, context: TenantContext, id: string, kind: 'signed_document'|'validation_report'|'evidence_package'): Promise<DownloadArtifact> {
  return tenantTx(database, context, async (transaction) => {
    await requireCase(transaction, context.tenantId, id);
    if (kind === 'signed_document') {
      const result = await transaction.query<{ readonly object_key: string; readonly sha256: string; readonly display_name: string }>(
        `select a.signed_document_object_key as object_key,a.signed_document_sha256 as sha256,d.display_name
           from app.signature_artifacts a
           join app.signature_attempts attempt on attempt.tenant_id=a.tenant_id and attempt.id=a.signature_attempt_id
           join app.document_versions v on v.tenant_id=attempt.tenant_id and v.id=attempt.document_version_id
           join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
          where a.tenant_id=$1 and d.signature_case_id=$2 and attempt.status in ('signed','validated')
          order by a.created_at desc limit 1`, [context.tenantId,id],
      );
      const row = requireRow(result.rows[0], 'SIGNED_DOCUMENT_NOT_AVAILABLE');
      return infrastructure.objectStorage.downloadObject(context, row.object_key, { contentType: 'application/pdf', fileName: row.display_name, sha256: row.sha256 });
    }
    if (kind === 'validation_report') {
      const result = await transaction.query<{ readonly object_key: string; readonly sha256: string }>(
        `select r.object_key,r.sha256 from app.validation_reports r
          join app.validation_runs run on run.tenant_id=r.tenant_id and run.id=r.validation_run_id
          join app.signature_artifacts a on a.tenant_id=run.tenant_id and a.id=run.signature_artifact_id
          join app.signature_attempts attempt on attempt.tenant_id=a.tenant_id and attempt.id=a.signature_attempt_id
          join app.document_versions v on v.tenant_id=attempt.tenant_id and v.id=attempt.document_version_id
          join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
         where r.tenant_id=$1 and d.signature_case_id=$2 and r.report_type='human'
         order by run.validated_at desc limit 1`, [context.tenantId,id],
      );
      const row = requireRow(result.rows[0], 'VALIDATION_REPORT_NOT_AVAILABLE');
      return infrastructure.objectStorage.downloadObject(context, row.object_key, { contentType: 'application/pdf', fileName: `validation-${id}.pdf`, sha256: row.sha256 });
    }
    const result = await transaction.query<{ readonly object_key: string; readonly manifest_sha256: string }>(
      `select object_key,manifest_sha256 from app.evidence_packages where tenant_id=$1 and signature_case_id=$2 and status='ready' order by created_at desc limit 1`, [context.tenantId,id],
    );
    const row = requireRow(result.rows[0], 'EVIDENCE_PACKAGE_NOT_AVAILABLE');
    return infrastructure.objectStorage.downloadObject(context, row.object_key, { contentType: 'application/zip', fileName: `evidence-${id}.zip`, sha256: row.manifest_sha256 });
  });
}

async function idempotent<T>(transaction: SqlTransaction, tenantId: string, operation: string, key: string, payloadHash: string, work: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error('IDEMPOTENCY_KEY_INVALID');
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('PAYLOAD_HASH_INVALID');
  await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`${tenantId}:${operation}:${key}`]);
  const existing = await transaction.query<{ readonly payload_sha256: string; readonly response_body: T | null }>(
    `select payload_sha256,response_body from app.operation_idempotency
      where tenant_id=$1 and operation=$2 and idempotency_key=$3 and expires_at>now() for update`, [tenantId,operation,key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.payload_sha256 !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
    if (row.response_body === null) throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
    return row.response_body;
  }
  await transaction.query(`insert into app.operation_idempotency(tenant_id,operation,idempotency_key,payload_sha256) values($1,$2,$3,$4)`, [tenantId,operation,key,payloadHash]);
  const response = await work();
  const responseJson = JSON.stringify(response);
  await transaction.query(`update app.operation_idempotency set response_body=$4::jsonb,response_body_sha256=$5 where tenant_id=$1 and operation=$2 and idempotency_key=$3`, [tenantId,operation,key,responseJson,await sha256Hex(responseJson)]);
  return response;
}

async function tenantTx<T>(database: SqlDatabase, context: TenantContext, work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, context, actorKind(context), work);
}
function actorKind(context: TenantContext): 'internal_user'|'external_client'|'worker'|'trusted_service' {
  if (context.authMethod === 'oauth2_client_credentials' || context.authMethod === 'mtls') return 'external_client';
  if (context.authMethod === 'worker') return 'worker';
  if (context.authMethod === 'trusted_service') return 'trusted_service';
  return 'internal_user';
}
async function requireUserId(transaction: SqlTransaction, context: TenantContext): Promise<string> {
  const result = await transaction.query<{ readonly id: string }>(`select id from app.users where tenant_id=$1 and external_subject=$2 and disabled_at is null limit 1`, [context.tenantId,context.subjectId]);
  return requireRow(result.rows[0], 'TENANT_SUBJECT_NOT_PROVISIONED').id;
}
async function requireCase(transaction: SqlTransaction, tenantId: string, id: string, statuses?: readonly string[]): Promise<CaseRow> {
  const result = await transaction.query<CaseRow>(`${caseSelect} where tenant_id=$1 and id=$2 for update`, [tenantId,id]);
  const row = requireRow(result.rows[0], 'NOT_FOUND');
  if (statuses && !statuses.includes(row.status)) throw new Error('CASE_STATE_INVALID');
  return row;
}
async function appendOutbox(transaction: SqlTransaction, tenantId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  const payloadJson = JSON.stringify(payload);
  await transaction.query(`insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId,aggregateType,aggregateId,eventType,payloadJson,await sha256Hex(payloadJson)]);
}
function pageBounds(page: PageInput): { readonly offset: number; readonly limit: number } {
  const limit = Math.min(Math.max(page.limit,1),200);
  const offset = page.cursor ? Number.parseInt(page.cursor,10) : 0;
  return { offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0, limit };
}
function pageResult<T>(rows: readonly T[], offset: number, limit: number): Page<T> {
  const data = rows.slice(0,limit);
  return { data, ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) };
}
function cleanText(value: string, minimum: number, maximum: number): string {
  const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ');
  if (cleaned.length < minimum || cleaned.length > maximum) throw new Error('TEXT_VALUE_INVALID');
  return cleaned;
}
function cleanFileName(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._ -]/g,'_').replace(/\s+/g,'_').slice(0,180);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('FILE_NAME_INVALID');
  return cleaned;
}
function validateUpload(input: UploadGrantInput): void {
  if (input.mimeType !== 'application/pdf') throw new Error('UPLOAD_MIME_TYPE_NOT_ALLOWED');
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 104_857_600) throw new Error('UPLOAD_SIZE_INVALID');
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('UPLOAD_SHA256_INVALID');
}
function requireRow<T>(row: T | undefined, code: string): T { if (!row) throw new Error(code); return row; }
function iso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function normalizeDocumentStatus(value: string): DocumentView['status'] {
  if (['quarantined','scanning','rejected','canonicalizing','ready','locked'].includes(value)) return value as DocumentView['status'];
  throw new Error('DOCUMENT_STATUS_NOT_API_VISIBLE');
}

interface CaseRow { readonly id:string; readonly tenant_id:string; readonly status:SignatureCaseStatus; readonly status_version:number|string; readonly decision_mode:CreateCaseInput['decisionMode']; readonly title:string; readonly external_reference:string|null; readonly created_at:string|Date; }
interface DocumentRow { readonly id:string; readonly document_id:string; readonly status:string; readonly sha256:string; readonly byte_size:number|string; readonly mime_type:string; }
interface SignerRow { readonly id:string; readonly signature_case_id:string; readonly display_name:string|null; readonly recipient_reference:string; readonly status:SignerView['status']; readonly signing_order:number|null; readonly required:boolean; }
interface UploadRow { readonly id:string; readonly object_key:string; readonly file_name:string; readonly mime_type:string; readonly byte_size:number|string; readonly expected_sha256:string; readonly status:string; }
interface WebhookRow { readonly id:string; readonly url:string; readonly subscribed_events:readonly string[]; readonly active:boolean; readonly created_at:string|Date; }
interface OutboxRow { readonly id:string; readonly event_type:string; readonly payload:Readonly<Record<string,unknown>>; readonly occurred_at:string|Date; }
interface TemplateRow { readonly id:string; readonly template_key:string; readonly version:number; readonly locale:string; readonly subject_template:string; readonly body_template:string; readonly active:boolean; }
const caseSelect = `select id,tenant_id,status::text as status,status_version,decision_mode::text as decision_mode,title,external_reference,created_at from app.signature_cases`;
function caseView(row: CaseRow): SignatureCaseView { return { id:row.id,tenantId:row.tenant_id,status:row.status,statusVersion:Number(row.status_version),decisionMode:row.decision_mode,title:row.title,createdAt:iso(row.created_at),...(row.external_reference ? {externalReference:row.external_reference}:{}) }; }
function signerView(row: SignerRow): SignerView { return { id:row.id,signatureCaseId:row.signature_case_id,recipientReference:row.recipient_reference,status:row.status,required:row.required,...(row.display_name?{displayName:row.display_name}:{}),...(row.signing_order===null?{}:{signingOrder:row.signing_order}) }; }
function webhookView(row: WebhookRow): WebhookEndpointView { return { id:row.id,url:row.url,subscribedEvents:row.subscribed_events,active:row.active,createdAt:iso(row.created_at) }; }
function templateView(row: TemplateRow): TemplateView { return { id:row.id,templateKey:row.template_key,version:row.version,locale:row.locale,subjectTemplate:row.subject_template,bodyTemplate:row.body_template,active:row.active }; }
