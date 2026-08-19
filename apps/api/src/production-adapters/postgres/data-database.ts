import type { TenantContext, DomainEvent, SignatureCaseStatus } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { canonicalJson } from '../../../../../packages/crypto/src/canonical-json.js';
import { randomToken } from '../../../../../packages/crypto/src/tokens.js';
import { decideIdentifierBinding, maskSwedishPersonalNumber } from '../../../../../packages/personal-number/src/index.js';
import { assertSafeWebhookUrl } from '../../../../../packages/webhooks/src/index.js';
import type {
  AddDocumentInput, AddSignerInput, CaseRepository, CreateCaseInput, DocumentView, EventRepository,
  Page, PageInput, SignatureCaseView, SignerView, TemplateInput, TemplateRepository, TemplateView,
  UploadGrantInput, UploadGrantView, UploadRepository, WebhookEndpointInput, WebhookEndpointView, WebhookRepository,
  DownloadArtifact, SignaturePolicyView,
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
    webhooks: createWebhookRepository(database, infrastructure),
    events: createEventRepository(database),
    templates: createTemplateRepository(database),
  };
}

export function createCaseRepository(database: SqlDatabase, infrastructure: ProductionInfrastructure): CaseRepository {
  return {
    async listPolicies(context) {
      return tenantTx(database, context, async (transaction) => {
        const result = await transaction.query<{ readonly id: string; readonly version: number|string; readonly name: string; readonly decision_mode: SignaturePolicyView['decisionMode']; readonly active: boolean }>(
          `select id,version,name,decision_mode::text as decision_mode,active
             from app.signature_policies
            where tenant_id=$1 and active=true
            order by decision_mode,name,version desc`,
          [context.tenantId],
        );
        return result.rows.map((row) => ({ id: row.id, version: Number(row.version), name: row.name, decisionMode: row.decision_mode, active: row.active }));
      });
    },
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
          [context.tenantId, userId, input.externalReference ?? null, cleanText(input.title, 1, 300), input.decisionMode, policyRow.id, policyRow.version, policyRow.policy],
        );
        const view = caseView(requireRow(inserted.rows[0], 'CASE_INSERT_FAILED'));
        await appendOutbox(transaction, context.tenantId, 'signature_case', view.id, 'signature_case.created', { signatureCaseId: view.id });
        return view;
      }));
    },
    async get(context, id) {
      return tenantTx(database, context, async (transaction) => {
        const result = await transaction.query<CaseDetailRow>(
          `select c.id,c.tenant_id,c.status::text as status,c.status_version,c.decision_mode::text as decision_mode,
                  c.title,c.external_reference,c.policy_id,c.policy_version,c.policy_snapshot,
                  c.created_by,c.created_at,c.sent_at,c.completed_at,c.expires_at,c.updated_at,
                  exists(select 1 from app.evidence_packages ep where ep.tenant_id=c.tenant_id and ep.signature_case_id=c.id and ep.status='ready') as evidence_available,
                  exists(select 1 from app.archive_exports ae where ae.tenant_id=c.tenant_id and ae.signature_case_id=c.id and ae.status='completed') as archive_completed
             from app.signature_cases c
            where c.tenant_id=$1 and c.id=$2`,
          [context.tenantId, id],
        );
        const row = result.rows[0];
        if (!row) return null;
        const documents = await transaction.query<{ readonly payload: unknown }>(
          `select coalesce(jsonb_agg(jsonb_build_object(
             'id',d.id,'displayName',d.display_name,'role',d.document_role,'ordinal',d.document_ordinal,
             'version',v.version,'status',v.status::text,'mimeType',v.mime_type,'byteSize',v.byte_size,'sha256',v.sha256,
             'sourcePageCount',v.source_page_count,'canonicalPageCount',v.canonical_page_count,'pdfProfile',v.pdf_profile,'lockedAt',v.locked_at,
             'scanResult',(select sr.result from app.document_scan_results sr where sr.tenant_id=d.tenant_id and sr.document_version_id=v.id order by sr.scanned_at desc limit 1),
             'processingResult',(select pr.result from app.document_processor_reports pr where pr.tenant_id=d.tenant_id and pr.document_version_id=v.id order by pr.created_at desc limit 1)
           ) order by d.document_ordinal,d.created_at,d.id), '[]'::jsonb) as payload
             from app.documents d
             join lateral (select v.* from app.document_versions v where v.tenant_id=d.tenant_id and v.document_id=d.id order by v.version desc limit 1) v on true
            where d.tenant_id=$1 and d.signature_case_id=$2`, [context.tenantId,id],
        );
        const signers = await transaction.query<{ readonly payload: unknown }>(
          `select coalesce(jsonb_agg(jsonb_build_object(
             'id',s.id,'displayName',s.display_name,'status',s.status::text,'signingOrder',s.signing_order,'required',s.required,
             'identifierBindingMode',s.identifier_binding_mode,'identifierBindingExceptionCode',s.identifier_binding_exception_code,
             'emailConfigured',(s.email_ciphertext is not null)
           ) order by s.signing_order,s.id), '[]'::jsonb) as payload
             from app.signers s where s.tenant_id=$1 and s.signature_case_id=$2`, [context.tenantId,id],
        );
        const events = await transaction.query<{ readonly payload: unknown }>(
          `select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'type',a.event_type,'category',a.category,'actorType',a.actor_type,'resourceType',a.resource_type,'resourceId',a.resource_id,'occurredAt',a.occurred_at) order by a.sequence), '[]'::jsonb) as payload
             from audit.audit_events a where a.tenant_id=$1 and a.resource_type='signature_case' and a.resource_id=$2`, [context.tenantId,id],
        );
        const view = caseView(row);
        return { ...view,
          policy: { id: row.policy_id, version: Number(row.policy_version), snapshot: row.policy_snapshot },
          createdBy: row.created_by, createdAt: iso(row.created_at),
          sentAt: row.sent_at ? iso(row.sent_at) : undefined,
          completedAt: row.completed_at ? iso(row.completed_at) : undefined,
          expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
          updatedAt: iso(row.updated_at),
          documents: documents.rows[0]?.payload ?? [],
          signers: signers.rows[0]?.payload ?? [],
          events: events.rows[0]?.payload ?? [],
          evidenceAvailable: row.evidence_available,
          archiveCompleted: row.archive_completed,
        };
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
        await enqueueDurableJob(transaction, context.tenantId, 'DOCUMENT_SCAN', `document-scan:${row.id}`, { signatureCaseId:id,documentId,documentVersionId:row.id });
        // A case with a document in it is no longer a draft. The worker moves
        // it on to ready when every version has been canonicalised; until
        // something made this first step, the case stayed in draft and the
        // database correctly refused to send it.
        const prepared = await transaction.query(
          `update app.signature_cases set status='preparing',status_version=status_version+1,updated_at=now()
            where tenant_id=$1 and id=$2 and status='draft'`, [context.tenantId, id],
        );
        if (prepared.rowCount) {
          await appendOutbox(transaction, context.tenantId, 'signature_case', id, 'signature_case.preparing', { signatureCaseId: id });
        }
        return view;
      }));
    },
    async addSigner(context, id, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:signer`, key, payloadHash, async () => {
        await requireCase(transaction, context.tenantId, id, ['draft','preparing','ready']);
        const view = await insertOrUpdateSigner(transaction, infrastructure, context, id, null, input);
        await appendOutbox(transaction, context.tenantId, 'signer', view.id, 'signer.added', { signatureCaseId: id, signerId: view.id, identifierBindingMode: view.identifierBindingMode });
        if (view.identifierBindingMode === 'BANKID_DISCOVERED') {
          await appendOutbox(transaction, context.tenantId, 'signer', view.id, 'signer.identifier_binding_exception_used', { signatureCaseId: id, signerId: view.id, code: view.identifierBindingExceptionCode });
        }
        return view;
      }));
    },
    async updateSigner(context, id, signerId, input, key, payloadHash, expectedVersion) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:signer:${signerId}:update`, key, payloadHash, async () => {
        await requireCase(transaction, context.tenantId, id, ['draft','preparing','ready']);
        const current = await transaction.query<{ readonly status: string; readonly status_version: number|string }>(
          `select status::text as status,status_version from app.signers where tenant_id=$1 and signature_case_id=$2 and id=$3 for update`,
          [context.tenantId,id,signerId],
        );
        const row = requireRow(current.rows[0], 'NOT_FOUND');
        if (row.status !== 'pending') throw new Error('SIGNER_NOT_EDITABLE');
        if (expectedVersion !== undefined && Number(row.status_version) !== expectedVersion) throw new Error('RESOURCE_VERSION_CONFLICT');
        const view = await insertOrUpdateSigner(transaction, infrastructure, context, id, signerId, input);
        await appendOutbox(transaction, context.tenantId, 'signer', view.id, 'signer.updated', { signatureCaseId: id, signerId: view.id, identifierBindingMode: view.identifierBindingMode });
        return view;
      }));
    },
    async send(context, id, key, payloadHash, expectedVersion) {
      return transitionCase(database, context, id, 'sent', key, payloadHash, expectedVersion, async (transaction, current) => {
        // Only from ready. A draft has no canonicalised document behind it, and
        // the database's transition table says the same thing.
        if (current.status !== 'ready') throw new Error('CASE_NOT_SENDABLE');
        const details = await transaction.query<CaseSigningRow>(
          `select c.id,c.external_reference,c.title,c.policy_id,c.policy_version,o.legal_name as organization_name
             from app.signature_cases c
             left join app.organizations o on o.tenant_id=c.tenant_id
            where c.tenant_id=$1 and c.id=$2 order by o.created_at limit 1`, [context.tenantId,id],
        );
        const caseDetails = requireRow(details.rows[0], 'CASE_SEND_EVIDENCE_FAILED');
        const documents = await transaction.query<SigningDocumentRow>(
          `select d.id as document_id,v.id as document_version_id,d.display_name,v.sha256,v.mime_type,v.byte_size
             from app.documents d join app.document_versions v on v.tenant_id=d.tenant_id and v.document_id=d.id
            where d.tenant_id=$1 and d.signature_case_id=$2
            order by d.created_at,d.id,v.version desc`, [context.tenantId,id],
        );
        if (!documents.rows.length || documents.rows.length > 20 || documents.rows.some((document) => !document.sha256 || document.mime_type!=='application/pdf')) throw new Error('DOCUMENT_NOT_READY');
        const notReady = await transaction.query<{ readonly count: number|string }>(
          `select count(*) as count from app.documents d join app.document_versions v on v.tenant_id=d.tenant_id and v.document_id=d.id
            where d.tenant_id=$1 and d.signature_case_id=$2 and v.status<>'ready'`, [context.tenantId,id],
        );
        if (Number(notReady.rows[0]?.count ?? 0) !== 0) throw new Error('DOCUMENT_NOT_READY');
        const signers = await transaction.query<SigningSignerRow>(
          `select id,display_name,email_ciphertext,identifier_binding_mode,identifier_binding_exception_code,signing_order,required
             from app.signers where tenant_id=$1 and signature_case_id=$2 order by signing_order,id for update`, [context.tenantId,id],
        );
        if (!signers.rows.some((signer) => signer.required) || signers.rows.some((signer) => !signer.email_ciphertext || !signer.identifier_binding_mode)) throw new Error('CASE_SEND_EVIDENCE_INCOMPLETE');
        await transaction.query(
          `update app.document_versions v set status='locked',locked_at=now()
            from app.documents d where d.tenant_id=v.tenant_id and d.id=v.document_id and d.tenant_id=$1 and d.signature_case_id=$2 and v.status='ready'`,
          [context.tenantId,id],
        );
        const firstGroup = Math.min(...signers.rows.map((signer) => signer.signing_order));
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + 60 * 60 * 1000);
        for (const signer of signers.rows) {
          const signingIntentId = crypto.randomUUID();
          const snapshots = documents.rows.map((document, index) => ({
            ordinal:index+1,documentId:document.document_id,documentVersionId:document.document_version_id,
            displayName:document.display_name,mimeType:'application/pdf' as const,profile:'PDF/A-2b' as const,
            byteSize:Number(document.byte_size),sha256:document.sha256,
          }));
          const visibleText = buildBankIdVisibleText(caseDetails, snapshots);
          const payload = canonicalJson({
            schema:'kommunsign.bankid-evidence.v2',tenantId:context.tenantId,signatureCaseId:id,signingIntentId,signerId:signer.id,
            identifierBindingMode:signer.identifier_binding_mode,identifierBindingExceptionCode:signer.identifier_binding_exception_code ?? null,
            signaturePolicyId:caseDetails.policy_id,signaturePolicyVersion:caseDetails.policy_version,documents:snapshots,
            nonce:randomToken(32),issuedAt:issuedAt.toISOString(),expiresAt:expiresAt.toISOString(),
          });
          await transaction.query(
            `insert into app.signing_intents(tenant_id,id,signature_case_id,signer_id,sequence_group,visible_text,visible_text_sha256,non_visible_payload,non_visible_payload_sha256,evidence_schema_version,identifier_binding_mode,status,issued_at,expires_at)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,'kommunsign.bankid-evidence.v2',$10,'prepared',$11,$12)`,
            [context.tenantId,signingIntentId,id,signer.id,signer.signing_order,visibleText,await sha256Hex(visibleText),payload,await sha256Hex(payload),signer.identifier_binding_mode,issuedAt.toISOString(),expiresAt.toISOString()],
          );
          for (const document of snapshots) await transaction.query(
            `insert into app.signing_intent_documents(tenant_id,signing_intent_id,document_version_id,ordinal,document_sha256,display_name_snapshot,mime_type_snapshot,profile_snapshot,byte_size_snapshot)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [context.tenantId,signingIntentId,document.documentVersionId,document.ordinal,document.sha256,document.displayName,document.mimeType,document.profile,document.byteSize],
          );
          if (signer.signing_order === firstGroup) {
            const invitationId = crypto.randomUUID();
            const token = randomToken(32);
            const tokenHash = await infrastructure.sensitiveData.blindIndex(token, 'signer.invitation_token');
            await transaction.query(
              `insert into app.signer_invitations(tenant_id,id,signer_id,token_hash,expires_at) values($1,$2,$3,$4,$5)`,
              [context.tenantId,invitationId,signer.id,tokenHash,expiresAt.toISOString()],
            );
            const messageId = crypto.randomUUID();
            const messagePayload = JSON.stringify({ invitationToken:token,signerId:signer.id,signatureCaseId:id,tenantId:context.tenantId,expiresAt:expiresAt.toISOString() });
            const encryptedPayload = await infrastructure.sensitiveData.encryptText(messagePayload, 'email.signature_invitation');
            await transaction.query(
              `insert into app.email_messages(tenant_id,id,signer_id,signature_case_id,template_key,template_version,locale,recipient_ciphertext,message_payload_ciphertext,payload_sha256,idempotency_key)
               values($1,$2,$3,$4,'signature_invitation',1,'sv-SE',$5,$6,$7,$8)`,
              [context.tenantId,messageId,signer.id,id,signer.email_ciphertext,encryptedPayload,await sha256Hex(messagePayload),`signature-invitation:${invitationId}`],
            );
            await enqueueDurableJob(transaction, context.tenantId, 'EMAIL_SEND', `email:${messageId}`, { emailMessageId:messageId });
            await transaction.query(`update app.signers set status='invited',status_version=status_version+1 where tenant_id=$1 and id=$2`,[context.tenantId,signer.id]);
            await appendOutbox(transaction,context.tenantId,'invitation',invitationId,'invitation.created',{signatureCaseId:id,signerId:signer.id,signingOrder:signer.signing_order});
          }
        }
        await appendOutbox(transaction,context.tenantId,'document',id,'document.locked',{signatureCaseId:id,documentCount:documents.rows.length});
      });
    },
    async cancel(context, id, key, payloadHash, expectedVersion) {
      return transitionCase(database, context, id, 'cancelled', key, payloadHash, expectedVersion);
    },
    async remind(context, id, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `case:${id}:remind`, key, payloadHash, async () => {
        await requireCase(transaction, context.tenantId, id, ['sent','in_progress','partially_signed']);
        const queued = await enqueueDurableJob(transaction, context.tenantId, 'REMINDER_SEND', `case-reminder:${id}:${key}`, { signatureCaseId: id, requestedBy: context.subjectId });
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
    async complete(context, uploadId, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, `upload:${uploadId}:complete`, key, payloadHash, async () => {
        const result = await transaction.query<UploadRow>(`select id,object_key,file_name,mime_type,byte_size,expected_sha256,status from app.upload_grants where tenant_id=$1 and id=$2 for update`,[context.tenantId,uploadId]);
        const grant = requireRow(result.rows[0],'UPLOAD_GRANT_NOT_FOUND');
        if (grant.status === 'uploaded') return { id:grant.id,status:'uploaded' as const,sha256:grant.expected_sha256,byteSize:Number(grant.byte_size) };
        if (grant.status !== 'issued') throw new Error('UPLOAD_GRANT_NOT_ACTIVE');
        const object = await infrastructure.objectStorage.headObject(context, grant.object_key);
        if (object.byteSize !== Number(grant.byte_size)) throw new Error('UPLOAD_OBJECT_MISMATCH');
        const actualSha256 = object.sha256 ?? await sha256Hex((await infrastructure.objectStorage.downloadObject(context, grant.object_key, { contentType:grant.mime_type,fileName:grant.file_name })).bytes);
        if (actualSha256 !== grant.expected_sha256) throw new Error('UPLOAD_OBJECT_MISMATCH');
        await transaction.query(`update app.upload_grants set status='uploaded',uploaded_at=now() where tenant_id=$1 and id=$2`,[context.tenantId,uploadId]);
        await appendOutbox(transaction,context.tenantId,'upload',uploadId,'document.uploaded',{uploadId,sha256:grant.expected_sha256,byteSize:Number(grant.byte_size)});
        return { id:grant.id,status:'uploaded' as const,sha256:grant.expected_sha256,byteSize:Number(grant.byte_size) };
      }));
    },
  };
}

export function createWebhookRepository(database: SqlDatabase, infrastructure: ProductionInfrastructure): WebhookRepository {
  return {
    async createEndpoint(context, input, key, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(transaction, context.tenantId, 'webhook:create', key, payloadHash, async () => {
        const parsed = assertSafeWebhookUrl(input.url);
        // The secret is generated here and returned exactly once. Storing a
        // vault reference nothing resolves, as this did before, left every
        // subscriber unable to verify the signature on anything we sent them.
        const secret = randomToken(32);
        const ciphertext = await infrastructure.sensitiveData.encryptText(secret, 'webhook.signing_secret');
        const inserted = await transaction.query<WebhookRow>(
          `insert into app.webhook_endpoints(tenant_id,url,secret_current_ref,secret_current_ciphertext,subscribed_events,active)
           values ($1,$2,$3,$4,$5,true)
           returning id,url,subscribed_events,active,created_at`,
          [context.tenantId, parsed.toString(), `db://webhooks/${context.tenantId}`, ciphertext, input.subscribedEvents],
        );
        const view = webhookView(requireRow(inserted.rows[0], 'WEBHOOK_INSERT_FAILED'));
        return { ...view, signingSecret: secret };
      }));
    },

    async rotateSecret(context, endpointId, overlapSeconds) {
      return tenantTx(database, context, async (transaction) => {
        const secret = randomToken(32);
        const ciphertext = await infrastructure.sensitiveData.encryptText(secret, 'webhook.signing_secret');
        // The superseded secret stays valid for a while. Cutting it off at the
        // instant of rotation would reject deliveries already in flight and make
        // a routine key change look like an outage to the subscriber.
        const overlap = Math.min(Math.max(overlapSeconds, 0), 86_400);
        const updated = await transaction.query<WebhookRow>(
          `update app.webhook_endpoints
              set secret_previous_ciphertext = case when $3 > 0 then secret_current_ciphertext else null end,
                  previous_valid_until = case when $3 > 0 then now() + make_interval(secs => $3) else null end,
                  secret_current_ciphertext = $4,
                  secret_rotated_at = now()
            where tenant_id=$1 and id=$2
            returning id,url,subscribed_events,active,created_at`,
          [context.tenantId, endpointId, overlap, ciphertext],
        );
        const view = webhookView(requireRow(updated.rows[0], 'WEBHOOK_ENDPOINT_NOT_FOUND'));
        return { ...view, signingSecret: secret };
      });
    },

    async listDeliveries(context, page, status) {
      return tenantTx(database, context, async (transaction) => {
        const { offset, limit } = pageBounds(page);
        const result = await transaction.query<WebhookDeliveryRow>(
          `select d.id,d.webhook_endpoint_id,d.outbox_event_id,e.event_type,d.status,d.attempt,
                  d.response_status,d.next_attempt_at,d.delivered_at
             from app.webhook_deliveries d
             join app.outbox_events e on e.tenant_id=d.tenant_id and e.id=d.outbox_event_id
            where d.tenant_id=$1 and ($4::text is null or d.status=$4)
            order by d.next_attempt_at desc,d.id desc offset $2 limit $3`,
          [context.tenantId, offset, limit, status ?? null],
        );
        return pageResult(result.rows.map(webhookDeliveryView), offset, limit);
      });
    },

    async replayDelivery(context, deliveryId) {
      return tenantTx(database, context, async (transaction) => {
        const current = await transaction.query<WebhookDeliveryRow & { readonly event_type: string }>(
          `select d.id,d.webhook_endpoint_id,d.outbox_event_id,e.event_type,d.status,d.attempt,
                  d.response_status,d.next_attempt_at,d.delivered_at
             from app.webhook_deliveries d
             join app.outbox_events e on e.tenant_id=d.tenant_id and e.id=d.outbox_event_id
            where d.tenant_id=$1 and d.id=$2 for update`,
          [context.tenantId, deliveryId],
        );
        const row = requireRow(current.rows[0], 'WEBHOOK_DELIVERY_NOT_FOUND');
        // Replay exists to recover a delivery that failed. Re-sending one that
        // succeeded would hand the subscriber a duplicate event that our own
        // idempotency contract promised them they would not receive.
        if (row.status === 'delivered') throw new Error('WEBHOOK_DELIVERY_ALREADY_DELIVERED');

        await transaction.query(
          `update app.webhook_deliveries set status='pending',next_attempt_at=now(),response_status=null,response_body_sha256=null
            where tenant_id=$1 and id=$2`,
          [context.tenantId, deliveryId],
        );
        // A fresh idempotency key: the original job has already been completed or
        // dead-lettered, and reusing its key would be silently discarded.
        await transaction.query(
          `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts)
           values($1,'WEBHOOK_DELIVER',$2::jsonb,$3,'pending',now(),10)
           on conflict (tenant_id,job_type,idempotency_key) do nothing`,
          [context.tenantId, { outboxEventId: row.outbox_event_id }, `outbox-replay:${deliveryId}:${Date.now()}`],
        );
        await transaction.query(
          `select audit.append_event($1,'TECHNICAL','webhook.replay_requested',$2,$3,'webhook_delivery',$4,$5::jsonb,now())`,
          [context.tenantId, context.authMethod, context.subjectId, deliveryId, { outboxEventId: row.outbox_event_id, previousStatus: row.status }],
        );
        return { ...webhookDeliveryView(row), status: 'pending' as const, responseStatus: null };
      });
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

async function insertOrUpdateSigner(
  transaction: SqlTransaction,
  infrastructure: ProductionInfrastructure,
  context: TenantContext,
  signatureCaseId: string,
  signerId: string | null,
  input: AddSignerInput,
): Promise<SignerView> {
  const settingsResult = await transaction.query<{ readonly allow_identifier_binding_exceptions: boolean }>(
    `select allow_identifier_binding_exceptions from app.tenant_signing_settings where tenant_id=$1`, [context.tenantId],
  );
  const decision = decideIdentifierBinding({
    personalNumber: input.personalNumber,
    requirePersonalNumberMatch: input.requirePersonalNumberMatch,
    exception: input.personalNumberException,
    tenantAllowsException: settingsResult.rows[0]?.allow_identifier_binding_exceptions ?? false,
    actorHasExceptionPermission: input.exceptionPermissionGranted === true,
  });
  const actorId = await requireUserId(transaction, context);
  const email = input.email.trim().toLowerCase();
  const emailCiphertext = await infrastructure.sensitiveData.encryptText(email, 'signer.email');
  const emailBlindIndex = await infrastructure.sensitiveData.blindIndex(email, 'signer.email');
  const expectedCiphertext = decision.normalizedPersonalNumber
    ? await infrastructure.sensitiveData.encryptText(decision.normalizedPersonalNumber, 'signer.expected_personal_number') : null;
  const expectedBlindIndex = decision.normalizedPersonalNumber
    ? await infrastructure.sensitiveData.blindIndex(decision.normalizedPersonalNumber, 'signer.expected_personal_number') : null;
  const exceptionReasonCiphertext = decision.exception?.reason
    ? await infrastructure.sensitiveData.encryptText(decision.exception.reason, 'signer.identifier_binding_exception_reason') : null;
  const id = signerId ?? crypto.randomUUID();
  const parameters = [
    context.tenantId,id,signatureCaseId,cleanText(input.displayName,1,200),`signer-${id}`,emailCiphertext,emailBlindIndex,
    expectedCiphertext,expectedBlindIndex,decision.mode,decision.exception?.code ?? null,exceptionReasonCiphertext,
    decision.mode === 'BANKID_DISCOVERED' ? actorId : null,decision.mode === 'BANKID_DISCOVERED' ? new Date().toISOString() : null,
    input.signingOrder,input.required,
  ];
  if (signerId) {
    const updated = await transaction.query<{ readonly id:string }>(
      `update app.signers set display_name=$4,recipient_reference=$5,email_ciphertext=$6,email_blind_index=$7,
        expected_identifier_ciphertext=$8,expected_identifier_blind_index=$9,expected_identifier_type=case when $10='STRICT_PREBOUND' then 'SSN' else null end,
        identifier_binding_mode=$10,identifier_binding_exception_code=$11,identifier_binding_exception_reason_ciphertext=$12,
        identifier_binding_exception_approved_by=$13,identifier_binding_exception_at=$14,signing_order=$15,required=$16,status_version=status_version+1
       where tenant_id=$1 and id=$2 and signature_case_id=$3 and status='pending' returning id`, parameters,
    );
    requireRow(updated.rows[0], 'SIGNER_NOT_EDITABLE');
  } else {
    await transaction.query(
      `insert into app.signers(tenant_id,id,signature_case_id,display_name,recipient_reference,email_ciphertext,email_blind_index,
        expected_identifier_ciphertext,expected_identifier_blind_index,expected_identifier_type,identifier_binding_mode,
        identifier_binding_exception_code,identifier_binding_exception_reason_ciphertext,identifier_binding_exception_approved_by,
        identifier_binding_exception_at,status,signing_order,required)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $10='STRICT_PREBOUND' then 'SSN' else null end,$10,$11,$12,$13,$14,'pending',$15,$16)`, parameters,
    );
  }
  return {
    id,signatureCaseId,displayName:input.displayName,maskedEmail:maskEmail(email),identifierBindingMode:decision.mode,
    ...(decision.normalizedPersonalNumber ? { maskedPersonalNumber:maskSwedishPersonalNumber(decision.normalizedPersonalNumber) } : {}),
    ...(decision.exception ? { identifierBindingExceptionCode:decision.exception.code } : {}),
    status:'pending',required:input.required,signingOrder:input.signingOrder,
  };
}

function buildBankIdVisibleText(caseDetails: CaseSigningRow, documents: readonly { readonly displayName:string; readonly sha256:string }[]): string {
  const lines = documents.map((document) => `+ ${document.displayName} — SHA-256: ${document.sha256.slice(0,8)}…${document.sha256.slice(-4)}`);
  return [
    '# Elektronisk underskrift','',
    'Jag undertecknar följande handlingar i Kommunsign:','',...lines,'',
    `Ärende: ${caseDetails.external_reference ?? caseDetails.id}`,
    `Organisation: ${caseDetails.organization_name ?? 'Kommunsign-tenant'}`,
    `Antal handlingar: ${documents.length}`,'',
    'Jag bekräftar att jag har granskat handlingarna och avser att underteckna dem elektroniskt.',
  ].join('\n');
}

async function enqueueDurableJob(
  transaction: SqlTransaction, tenantId: string, jobType: string, idempotencyKey: string, payload: Readonly<Record<string, unknown>>,
): Promise<{ readonly jobId:string }> {
  const result = await transaction.query<{ readonly id:string }>(
    `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts)
     values($1,$2,$3::jsonb,$4,'pending',now(),10)
     on conflict(tenant_id,job_type,idempotency_key) do update set updated_at=app.durable_jobs.updated_at
     returning id`, [tenantId,jobType,payload,idempotencyKey],
  );
  return { jobId:requireRow(result.rows[0],'JOB_ENQUEUE_FAILED').id };
}

function maskEmail(email: string): string {
  const [local='',domain=''] = email.split('@');
  return `${local.slice(0,1)}${local.length>1?'•••':''}@${domain}`;
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
  await transaction.query(`update app.operation_idempotency set response_body=$4::jsonb,response_body_sha256=$5 where tenant_id=$1 and operation=$2 and idempotency_key=$3`, [tenantId,operation,key,response,await sha256Hex(responseJson)]);
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
  await transaction.query(`insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId,aggregateType,aggregateId,eventType,payload,await sha256Hex(payloadJson)]);
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
interface SignerRow { readonly id:string; readonly signature_case_id:string; readonly display_name:string; readonly status:SignerView['status']; readonly signing_order:number; readonly required:boolean; readonly identifier_binding_mode:'STRICT_PREBOUND'|'BANKID_DISCOVERED'; }
interface CaseSigningRow { readonly id:string; readonly external_reference:string|null; readonly title:string; readonly policy_id:string; readonly policy_version:number; readonly organization_name:string|null; }
interface SigningDocumentRow { readonly document_id:string; readonly document_version_id:string; readonly display_name:string; readonly sha256:string; readonly mime_type:string; readonly byte_size:number|string; }
interface SigningSignerRow { readonly id:string; readonly display_name:string; readonly email_ciphertext:Uint8Array; readonly identifier_binding_mode:'STRICT_PREBOUND'|'BANKID_DISCOVERED'; readonly identifier_binding_exception_code:string|null; readonly signing_order:number; readonly required:boolean; }
interface UploadRow { readonly id:string; readonly object_key:string; readonly file_name:string; readonly mime_type:string; readonly byte_size:number|string; readonly expected_sha256:string; readonly status:string; }
interface WebhookRow { readonly id:string; readonly url:string; readonly subscribed_events:readonly string[]; readonly active:boolean; readonly created_at:string|Date; }
interface WebhookDeliveryRow {
  readonly id:string; readonly webhook_endpoint_id:string; readonly outbox_event_id:string; readonly event_type:string;
  readonly status:string; readonly attempt:number; readonly response_status:number|null;
  readonly next_attempt_at:string|Date; readonly delivered_at:string|Date|null;
}
function webhookDeliveryView(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    webhookEndpointId: row.webhook_endpoint_id,
    outboxEventId: row.outbox_event_id,
    eventType: row.event_type,
    status: row.status as 'pending'|'delivering'|'delivered'|'failed'|'dead_letter',
    attempt: Number(row.attempt),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at).toISOString(),
  };
}
interface OutboxRow { readonly id:string; readonly event_type:string; readonly payload:Readonly<Record<string,unknown>>; readonly occurred_at:string|Date; }
interface TemplateRow { readonly id:string; readonly template_key:string; readonly version:number; readonly locale:string; readonly subject_template:string; readonly body_template:string; readonly active:boolean; }

interface CaseDetailRow extends CaseRow {
  readonly policy_id: string;
  readonly policy_version: number|string;
  readonly policy_snapshot: Readonly<Record<string, unknown>>;
  readonly created_by: string;
  readonly sent_at: string|Date|null;
  readonly completed_at: string|Date|null;
  readonly expires_at: string|Date|null;
  readonly updated_at: string|Date;
  readonly evidence_available: boolean;
  readonly archive_completed: boolean;
}
const caseSelect = `select id,tenant_id,status::text as status,status_version,decision_mode::text as decision_mode,title,external_reference,created_at from app.signature_cases`;
function caseView(row: CaseRow): SignatureCaseView { return { id:row.id,tenantId:row.tenant_id,status:row.status,statusVersion:Number(row.status_version),decisionMode:row.decision_mode,title:row.title,createdAt:iso(row.created_at),...(row.external_reference ? {externalReference:row.external_reference}:{}) }; }
function webhookView(row: WebhookRow): WebhookEndpointView { return { id:row.id,url:row.url,subscribedEvents:row.subscribed_events,active:row.active,createdAt:iso(row.created_at) }; }
function templateView(row: TemplateRow): TemplateView { return { id:row.id,templateKey:row.template_key,version:row.version,locale:row.locale,subjectTemplate:row.subject_template,bodyTemplate:row.body_template,active:row.active }; }
