import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob, DurableJobType } from './jobs.js';
import { ClamAvInstreamClient, GotenbergPdfAClient, QpdfInspector, VeraPdfRestClient } from '../../../packages/document-processing/src/production.js';
import { assertExpectedPageCount, documentObjectKeys } from '../../../packages/document-processing/src/index.js';
import { TicBankIdProvider } from '../../../packages/provider-adapters/src/tic-bankid.js';
import { ValidationServiceClient } from '../../../packages/validation-client/src/index.js';
import { DevelopmentEmailProvider, ResendEmailProvider, EmailProviderError } from '../../../packages/provider-adapters/src/email.js';
import type { EmailMessage, EmailProvider } from '../../../packages/email/src/index.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { base64Encode } from '../../../packages/crypto/src/base64.js';
import { randomToken } from '../../../packages/crypto/src/tokens.js';
import { createEvidenceManifest, type EvidenceFile } from '../../../packages/evidence/src/index.js';
import { createEvidenceZip } from '../../../packages/evidence/src/zip.js';
import { normalizeSwedishPersonalNumber } from '../../../packages/personal-number/src/index.js';
import { activateNextSigningGroup } from './signing-groups.js';
import { createPadesJobHandlers, type PadesServices } from './pades-handlers.js';
import { SignServiceClient } from '../../../packages/signservice-client/src/index.js';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UTF8 = new TextEncoder();

type HandlerMap = Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>>;

interface Services {
  readonly clam: ClamAvInstreamClient;
  readonly qpdf: QpdfInspector;
  readonly gotenberg: GotenbergPdfAClient;
  readonly verapdf: VeraPdfRestClient;
  readonly tic: TicBankIdProvider | null;
  readonly validation: ValidationServiceClient;
  readonly email: EmailProvider;
  readonly signUrl: string;
  readonly onboardingUrl: string;
  readonly defaultFrom: { readonly email: string; readonly name?: string };
  readonly defaultReplyTo: { readonly email: string; readonly name?: string };
}

export function createProductionJobHandlers(input: {
  readonly controlDatabase: SqlDatabase;
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
  readonly configuration: Readonly<Record<string,string>>;
}): HandlerMap {
  const services = createServices(input.configuration);
  const phaseUnsupported = async (job: DurableJob): Promise<void> => { throw permanent(`WORKER_JOB_TYPE_OUTSIDE_BANKID_PHASE_${job.type}`); };
  return {
    APPLICATION_NOTIFICATION: (job) => handleApplicationNotification(input.controlDatabase, input.infrastructure, services, job),
    APPLICATION_DEADLINE: phaseUnsupported,
    TENANT_PROVISION: phaseUnsupported,
    TENANT_READINESS: phaseUnsupported,
    TENANT_ACTIVATION: phaseUnsupported,
    CERTIFICATE_MONITOR: phaseUnsupported,
    DOCUMENT_SCAN: (job) => handleDocumentScan(input.dataDatabase, input.infrastructure, services, job),
    DOCUMENT_CANONICALIZE: (job) => handleDocumentCanonicalize(input.dataDatabase, input.infrastructure, services, job),
    IDENTITY_STATUS_POLL: (job) => handleIdentityPoll(input.dataDatabase, services, job),
    SIGNATURE_CREATE: (job) => handleSignatureCreateGuard(input.dataDatabase, job),
    TIC_EVIDENCE_COLLECT: (job) => handleTicCollect(input.dataDatabase, input.infrastructure, services, job),
    SIGNATURE_VALIDATE: (job) => handleSignatureValidate(input.dataDatabase, input.infrastructure, services, job),
    ...createPadesJobHandlers({ dataDatabase: input.dataDatabase, infrastructure: input.infrastructure, services: padesServices(input.configuration, services.validation) }),
    EVIDENCE_PACKAGE_BUILD: (job) => handleEvidencePackageBuild(input.dataDatabase, input.infrastructure, job),
    EMAIL_SEND: (job) => handleEmailSend(input.dataDatabase, input.infrastructure, services, job),
    WEBHOOK_DELIVER: phaseUnsupported,
    REMINDER_SEND: (job) => handleReminder(input.dataDatabase, input.infrastructure, job),
    CASE_EXPIRE: (job) => handleCaseExpire(input.dataDatabase, job),
    ARCHIVE_EXPORT: phaseUnsupported,
    RETENTION_EXECUTE: phaseUnsupported,
  };
}

async function handleDocumentScan(database: SqlDatabase, infrastructure: ProductionInfrastructure, services: Services, job: DurableJob): Promise<void> {
  const documentVersionId = uuidPayload(job.payload, 'documentVersionId');
  const loaded = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<DocumentSourceRow>(
      `select v.id,v.document_id,d.signature_case_id,v.source_object_key,v.mime_type,v.byte_size,v.status,
              coalesce(s.maximum_document_bytes,52428800) maximum_document_bytes,
              coalesce(s.maximum_document_pages,500) maximum_document_pages
         from app.document_versions v
         join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
         left join app.tenant_signing_settings s on s.tenant_id=v.tenant_id
        where v.tenant_id=$1 and v.id=$2 for update`, [job.tenantId, documentVersionId]);
    const row = requireRow(result.rows[0], 'DOCUMENT_VERSION_NOT_FOUND');
    if (['canonicalizing','ready','locked','partially_signed','signed','validated','archived'].includes(row.status)) return { skip: true as const, row };
    if (row.status === 'rejected') return { skip: true as const, row };
    if (!['uploaded','quarantined','scanning'].includes(row.status)) throw permanent('DOCUMENT_SCAN_STATE_INVALID');
    await tx.query(`update app.document_versions set status='scanning' where tenant_id=$1 and id=$2`, [job.tenantId, documentVersionId]);
    return { skip: false as const, row };
  });
  if (loaded.skip) return;
  const row = loaded.row;
  const context = workerContext(job.tenantId);
  const artifact = await infrastructure.objectStorage.downloadObject(context, row.source_object_key, { contentType: 'application/pdf', fileName: 'source.pdf' });
  if (artifact.bytes.byteLength !== Number(row.byte_size) || row.mime_type !== 'application/pdf') {
    await rejectDocument(database, infrastructure, job.tenantId, row, 'DOCUMENT_PDF_POLICY_REJECTED', { expectedBytes: Number(row.byte_size), actualBytes: artifact.bytes.byteLength });
    return;
  }
  const malware = await services.clam.scan(artifact.bytes);
  await saveProcessorReport(database, infrastructure, job.tenantId, row, 'MALWARE_SCAN', malware.engine, `${malware.engineVersion}/${malware.signatureVersion}`, malware.result === 'CLEAN' ? 'PASS' : 'FAIL', malware, malware.finding ? [{ code: 'DOCUMENT_INFECTED' }] : []);
  if (malware.result === 'INFECTED') {
    await rejectDocument(database, infrastructure, job.tenantId, row, 'DOCUMENT_INFECTED', { findingCode: malware.finding ? 'MALWARE_FOUND' : 'MALWARE_DETECTED' });
    return;
  }
  let inspection;
  try {
    inspection = await services.qpdf.inspect(artifact.bytes, { maximumBytes: Number(row.maximum_document_bytes), maximumPages: Number(row.maximum_document_pages) });
  } catch (error) {
    if (isPermanentDocumentError(error)) {
      await rejectDocument(database, infrastructure, job.tenantId, row, error instanceof Error ? safeCode(error.message) : 'DOCUMENT_PDF_POLICY_REJECTED', {});
      return;
    }
    throw error;
  }
  await saveProcessorReport(database, infrastructure, job.tenantId, row, 'QPDF_CHECK', inspection.engine, inspection.engineVersion, inspection.passed ? 'PASS' : 'FAIL', inspection, inspection.findings);
  await saveProcessorReport(database, infrastructure, job.tenantId, row, 'PDF_POLICY', 'kommunsign-pdf-policy', '2', inspection.passed ? 'PASS' : 'FAIL', { findings: inspection.findings, encrypted: inspection.encrypted }, inspection.findings);
  if (!inspection.passed) {
    await rejectDocument(database, infrastructure, job.tenantId, row, 'DOCUMENT_PDF_POLICY_REJECTED', { findingCodes: inspection.findings.map((finding) => finding.code) });
    return;
  }
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(`insert into app.document_scan_results(tenant_id,document_version_id,engine,engine_version,result,findings) values($1,$2,'ClamAV',$3,'CLEAN','[]'::jsonb) on conflict do nothing`, [job.tenantId, row.id, malware.engineVersion]);
    await tx.query(`update app.document_versions set status='canonicalizing',source_page_count=$3 where tenant_id=$1 and id=$2 and status='scanning'`, [job.tenantId, row.id, inspection.pageCount]);
    await enqueue(tx, job.tenantId, 'DOCUMENT_CANONICALIZE', `document-canonicalize:${row.id}`, { signatureCaseId: row.signature_case_id, documentId: row.document_id, documentVersionId: row.id });
    await audit(tx, job.tenantId, 'BUSINESS', 'document.scan_passed', 'document_version', row.id, { documentVersionId: row.id, scanReportHash: inspection.outputSha256 });
    await outbox(tx, job.tenantId, 'document', row.document_id, 'document.scan_passed', { documentVersionId: row.id });
  });
}

async function handleDocumentCanonicalize(database: SqlDatabase, infrastructure: ProductionInfrastructure, services: Services, job: DurableJob): Promise<void> {
  const documentVersionId = uuidPayload(job.payload, 'documentVersionId');
  const row = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<CanonicalizeRow>(
      `select v.id,v.document_id,d.signature_case_id,v.source_object_key,v.status,v.source_page_count,
              coalesce(s.maximum_document_bytes,52428800) maximum_document_bytes,
              coalesce(s.maximum_document_pages,500) maximum_document_pages
         from app.document_versions v join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
         left join app.tenant_signing_settings s on s.tenant_id=v.tenant_id
        where v.tenant_id=$1 and v.id=$2`, [job.tenantId, documentVersionId]);
    return requireRow(result.rows[0], 'DOCUMENT_VERSION_NOT_FOUND');
  });
  if (['ready','locked','partially_signed','signed','validated','archived'].includes(row.status)) return;
  if (row.status === 'rejected') return;
  if (row.status !== 'canonicalizing') throw permanent('DOCUMENT_CANONICALIZE_STATE_INVALID');
  const context = workerContext(job.tenantId);
  const source = await infrastructure.objectStorage.downloadObject(context, row.source_object_key, { contentType: 'application/pdf', fileName: 'source.pdf' });
  const canonical = await services.gotenberg.convertToPdfA2b(source.bytes, job.id);
  const canonicalInspection = await services.qpdf.inspect(canonical, { maximumBytes: Number(row.maximum_document_bytes), maximumPages: Number(row.maximum_document_pages) });
  if (!canonicalInspection.passed) {
    await rejectDocument(database, infrastructure, job.tenantId, row, 'DOCUMENT_PDFA_CONVERSION_FAILED', { findingCodes: canonicalInspection.findings.map((finding) => finding.code) });
    return;
  }
  assertExpectedPageCount(Number(row.source_page_count), canonicalInspection.pageCount);
  const validation = await services.verapdf.validatePdfA2b(canonical);
  const keys = documentObjectKeys({ tenantId: job.tenantId, caseId: row.signature_case_id, documentId: row.document_id, versionId: row.id });
  const canonicalKey = keys.canonical.replace('/canonical.pdf', '/canonical/canonical.pdf');
  const validationKey = keys.pdfaReport;
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  await infrastructure.objectStorage.putObject(context, validationKey, validation.rawReport, validation.rawReportContentType, true);
  const reportSha = await sha256Hex(validation.rawReport);
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `insert into app.document_processor_reports(tenant_id,document_version_id,report_type,engine,engine_version,result,object_key,sha256,findings)
       values($1,$2,'PDFA_VALIDATION','veraPDF',$3,$4,$5,$6,$7::jsonb)
       on conflict(tenant_id,document_version_id,report_type) do nothing`,
      [job.tenantId, row.id, validation.engineVersion, validation.compliant ? 'PASS' : 'FAIL', validationKey, reportSha, validation.compliant ? [] : [{ code: 'DOCUMENT_PDFA_VALIDATION_FAILED' }]],
    );
  });
  if (!validation.compliant) {
    await rejectDocument(database, infrastructure, job.tenantId, row, 'DOCUMENT_PDFA_VALIDATION_FAILED', { reportSha256: reportSha });
    return;
  }
  const canonicalSha = await sha256Hex(canonical);
  await infrastructure.objectStorage.putObject(context, canonicalKey, canonical, 'application/pdf', true);
  const conversionReport = { engine: 'Gotenberg', profile: 'PDF/A-2b', sourceBytes: source.bytes.byteLength, canonicalBytes: canonical.byteLength, canonicalSha256: canonicalSha, pageCount: canonicalInspection.pageCount };
  await saveProcessorReport(database, infrastructure, job.tenantId, row, 'PDFA_CONVERSION', 'Gotenberg', '8.34.0', 'PASS', conversionReport, []);
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `update app.document_versions set status='ready',canonical_object_key=$3,byte_size=$4,sha256=$5,canonical_page_count=$6,pdf_profile='PDF/A-2b',canonicalized_at=now()
        where tenant_id=$1 and id=$2 and status='canonicalizing'`,
      [job.tenantId, row.id, canonicalKey, canonical.byteLength, canonicalSha, canonicalInspection.pageCount],
    );
    await tx.query(`insert into app.document_hashes(tenant_id,document_version_id,algorithm,digest) values($1,$2,'SHA-256',$3) on conflict do nothing`, [job.tenantId, row.id, canonicalSha]);
    await audit(tx, job.tenantId, 'BUSINESS', 'document.pdfa_validated', 'document_version', row.id, { documentVersionId: row.id, profile: 'PDF/A-2b', sha256: canonicalSha, validatorReportSha256: reportSha });
    await outbox(tx, job.tenantId, 'document', row.document_id, 'document.pdfa_validated', { documentVersionId: row.id, sha256: canonicalSha, profile: 'PDF/A-2b' });
  });
}

async function handleIdentityPoll(database: SqlDatabase, services: Services, job: DurableJob): Promise<void> {
  if (!services.tic) throw permanent('TIC_NOT_CONFIGURED');
  const transactionId = uuidPayload(job.payload, 'identityTransactionId');
  const row = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<{readonly provider_reference:string;readonly status:string}>(`select provider_reference,status from app.identity_transactions where tenant_id=$1 and id=$2`, [job.tenantId, transactionId]);
    return requireRow(result.rows[0], 'IDENTITY_TRANSACTION_NOT_FOUND');
  });
  if (['complete_collected','verified','cancelled','expired','failed'].includes(row.status)) return;
  const status = await services.tic.getStatus(row.provider_reference);
  await tenant(database, job.tenantId, async (tx) => {
    if (status === 'COMPLETED') await enqueue(tx, job.tenantId, 'TIC_EVIDENCE_COLLECT', `tic-collect:${transactionId}`, { identityTransactionId: transactionId });
    else if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED') await tx.query(`update app.identity_transactions set status=$3,failure_code=$4 where tenant_id=$1 and id=$2 and status in ('pending','user_action_required')`, [job.tenantId, transactionId, status.toLowerCase(), `TIC_${status}`]);
    // USER_ACTION_REQUIRED is not the same as PENDING: it is what tells the
    // signer's browser to prompt them to open the BankID app. Collapsing both
    // into 'pending' loses the only signal that distinguishes "waiting on the
    // provider" from "waiting on the person".
    else await tx.query(`update app.identity_transactions set status=$3,last_polled_at=now() where tenant_id=$1 and id=$2 and status in ('pending','user_action_required')`, [job.tenantId, transactionId, status === 'USER_ACTION_REQUIRED' ? 'user_action_required' : 'pending']);
  });
}

async function handleSignatureCreateGuard(database: SqlDatabase, job: DurableJob): Promise<void> {
  const signingIntentId = uuidPayload(job.payload, 'signingIntentId');
  await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<{readonly status:string}>(`select status from app.signing_intents where tenant_id=$1 and id=$2`, [job.tenantId, signingIntentId]);
    const row = requireRow(result.rows[0], 'SIGNING_INTENT_NOT_FOUND');
    if (row.status === 'provider_started') return;
    if (row.status !== 'prepared') throw permanent('SIGNATURE_CREATE_STATE_INVALID');
    throw permanent('SIGNATURE_CREATE_MUST_USE_PUBLIC_BANKID_START');
  });
}

async function handleTicCollect(database: SqlDatabase, infrastructure: ProductionInfrastructure, services: Services, job: DurableJob): Promise<void> {
  if (!services.tic) throw permanent('TIC_NOT_CONFIGURED');
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  const identityTransactionId = uuidPayload(job.payload, 'identityTransactionId');
  const row = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<CollectRow>(
      `select it.id,it.provider_reference,it.status,it.signing_intent_id,si.signature_case_id,si.signer_id
         from app.identity_transactions it join app.signing_intents si on si.tenant_id=it.tenant_id and si.id=it.signing_intent_id
        where it.tenant_id=$1 and it.id=$2`, [job.tenantId, identityTransactionId]);
    return requireRow(result.rows[0], 'IDENTITY_TRANSACTION_NOT_FOUND');
  });
  if (['complete_collected','verified'].includes(row.status)) return;
  if (['cancelled','expired','failed'].includes(row.status)) throw permanent('TIC_SESSION_TERMINAL');
  const evidence = await services.tic.collectEvidence(row.provider_reference);
  const collect = asObject(evidence.rawPayload, 'TIC_EVIDENCE_INVALID');
  const signature = asObject(collect.signature, 'TIC_EVIDENCE_INVALID');
  const xmlBase64 = requiredString(signature.value, 'TIC_SIGNATURE_MISSING');
  const ocspBase64 = requiredString(signature.ocspResponse, 'TIC_OCSP_MISSING');
  const xml = decodeBase64(xmlBase64, 'TIC_SIGNATURE_INVALID');
  const ocsp = decodeBase64(ocspBase64, 'TIC_OCSP_INVALID');
  const collectBytes = UTF8.encode(canonicalJson(collect as CanonicalJsonValue));
  const prefix = `${job.tenantId}/cases/${row.signature_case_id}/signers/${row.signer_id}/identity/${identityTransactionId}/evidence`;
  const collectKey = `${prefix}/tic-collect-response.json`;
  const xmlKey = `${prefix}/tic-signature.xml`;
  const ocspKey = `${prefix}/tic-ocsp-response.der`;
  const context = workerContext(job.tenantId);
  await infrastructure.objectStorage.putObject(context, collectKey, collectBytes, 'application/json', true);
  await infrastructure.objectStorage.putObject(context, xmlKey, xml, 'application/xml', true);
  await infrastructure.objectStorage.putObject(context, ocspKey, ocsp, 'application/ocsp-response', true);
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(`update app.identity_transactions set status='complete_collected',collected_at=now(),completed_at=coalesce(completed_at,now()),raw_evidence_object_key=$3,evidence_sha256=$4 where tenant_id=$1 and id=$2 and status in ('pending','user_action_required')`, [job.tenantId, identityTransactionId, collectKey, await sha256Hex(collectBytes)]);
    await tx.query(`update app.signing_intents set status='evidence_collected',evidence_collected_at=now() where tenant_id=$1 and id=$2 and status='provider_started'`, [job.tenantId, row.signing_intent_id]);
    await enqueue(tx, job.tenantId, 'SIGNATURE_VALIDATE', `signature-validate:${identityTransactionId}`, { identityTransactionId, collectKey, xmlKey, ocspKey });
    await audit(tx, job.tenantId, 'BUSINESS', 'bankid.evidence_collected', 'identity_transaction', identityTransactionId, { identityTransactionId, signingIntentId: row.signing_intent_id, collectSha256: await sha256Hex(collectBytes), signatureXmlSha256: await sha256Hex(xml), ocspSha256: await sha256Hex(ocsp) });
    await outbox(tx, job.tenantId, 'identity_transaction', identityTransactionId, 'bankid.evidence_collected', { signingIntentId: row.signing_intent_id });
  });
}

async function handleSignatureValidate(database: SqlDatabase, infrastructure: ProductionInfrastructure, services: Services, job: DurableJob): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  const identityTransactionId = uuidPayload(job.payload, 'identityTransactionId');
  const row = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<ValidationRow>(
      `select it.id,it.provider_reference,it.status,it.raw_evidence_object_key,it.signing_intent_id,
              si.signature_case_id,si.signer_id,si.visible_text,si.non_visible_payload,si.identifier_binding_mode,
              s.expected_identifier_ciphertext
         from app.identity_transactions it
         join app.signing_intents si on si.tenant_id=it.tenant_id and si.id=it.signing_intent_id
         join app.signers s on s.tenant_id=si.tenant_id and s.id=si.signer_id
        where it.tenant_id=$1 and it.id=$2`, [job.tenantId, identityTransactionId]);
    return requireRow(result.rows[0], 'IDENTITY_TRANSACTION_NOT_FOUND');
  });
  if (row.status === 'verified') return;
  if (row.status !== 'complete_collected') throw permanent('SIGNATURE_VALIDATE_STATE_INVALID');
  const context = workerContext(job.tenantId);
  const collectKey = stringPayload(job.payload, 'collectKey');
  const xmlKey = stringPayload(job.payload, 'xmlKey');
  const ocspKey = stringPayload(job.payload, 'ocspKey');
  const [collectArtifact, xmlArtifact, ocspArtifact] = await Promise.all([
    infrastructure.objectStorage.downloadObject(context, collectKey, { contentType: 'application/json', fileName: 'tic-collect-response.json' }),
    infrastructure.objectStorage.downloadObject(context, xmlKey, { contentType: 'application/xml', fileName: 'tic-signature.xml' }),
    infrastructure.objectStorage.downloadObject(context, ocspKey, { contentType: 'application/ocsp-response', fileName: 'tic-ocsp-response.der' }),
  ]);
  const expectedPersonalNumber = row.identifier_binding_mode === 'STRICT_PREBOUND'
    ? await infrastructure.sensitiveData.decryptText(requireValue(row.expected_identifier_ciphertext, 'PERSONAL_NUMBER_REQUIRED'), 'signer.expected_personal_number')
    : undefined;
  const documents = await tenant(database, job.tenantId, async (tx) => tx.query<ValidationDocumentRow>(
    `select sid.document_sha256,sid.document_version_id,v.canonical_object_key
       from app.signing_intent_documents sid join app.document_versions v on v.tenant_id=sid.tenant_id and v.id=sid.document_version_id
      where sid.tenant_id=$1 and sid.signing_intent_id=$2 order by sid.ordinal`, [job.tenantId, row.signing_intent_id]).then((result) => result.rows));
  const documentChecks: {code:string;passed:boolean;detail?:string}[] = [];
  for (const document of documents) {
    const artifact = await infrastructure.objectStorage.downloadObject(context, requireValue(document.canonical_object_key, 'DOCUMENT_NOT_READY'), { contentType: 'application/pdf', fileName: 'canonical.pdf' });
    const actual = await sha256Hex(artifact.bytes);
    documentChecks.push({ code: `DOCUMENT_HASH_${document.document_version_id}`, passed: actual === document.document_sha256, ...(actual === document.document_sha256 ? {} : { detail: 'Canonical document hash mismatch' }) });
  }
  const report = await services.validation.validateTicEvidence({
    signatureXmlBase64: base64Encode(xmlArtifact.bytes), ocspResponseBase64: base64Encode(ocspArtifact.bytes),
    expectedVisibleData: row.visible_text, expectedNonVisibleData: row.non_visible_payload,
    ...(expectedPersonalNumber ? { expectedPersonalNumber } : {}), policyVersion: 'kommunsign.bankid-evidence.v2',
  });
  const allChecks = [...report.checks, ...documentChecks];
  const pass = report.result === 'PASS' && allChecks.every((check) => check.passed) && Boolean(report.personalNumber);
  const reportObject = { ...report, result: pass ? 'PASS' : 'FAIL', checks: allChecks, identityTransactionId, signingIntentId: row.signing_intent_id };
  const reportBytes = UTF8.encode(canonicalJson(reportObject as unknown as CanonicalJsonValue));
  const reportKey = `${job.tenantId}/cases/${row.signature_case_id}/signers/${row.signer_id}/identity/${identityTransactionId}/validation/verification-report.json`;
  await infrastructure.objectStorage.putObject(context, reportKey, reportBytes, 'application/json', true);
  const hashes = { collect: await sha256Hex(collectArtifact.bytes), xml: await sha256Hex(xmlArtifact.bytes), ocsp: await sha256Hex(ocspArtifact.bytes), report: await sha256Hex(reportBytes) };
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `insert into app.tic_identity_artifacts(tenant_id,identity_transaction_id,signing_intent_id,collect_response_object_key,collect_response_sha256,signature_xml_object_key,signature_xml_sha256,ocsp_response_object_key,ocsp_response_sha256,verification_report_object_key,verification_report_sha256,verification_result,verifier_engine,verifier_policy_version,verified_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict(tenant_id,identity_transaction_id) do nothing`,
      [job.tenantId, identityTransactionId, row.signing_intent_id, collectKey, hashes.collect, xmlKey, hashes.xml, ocspKey, hashes.ocsp, reportKey, hashes.report, pass ? 'PASS' : 'FAIL', report.engine, report.policyVersion, report.verifiedAt],
    );
    if (!pass) {
      await tx.query(`update app.identity_transactions set status='failed',failure_code='TIC_EVIDENCE_INVALID' where tenant_id=$1 and id=$2`, [job.tenantId, identityTransactionId]);
      await tx.query(`update app.signing_intents set status='failed' where tenant_id=$1 and id=$2 and status='evidence_collected'`, [job.tenantId, row.signing_intent_id]);
      await tx.query(`update app.signers set status='failed',status_version=status_version+1 where tenant_id=$1 and id=$2 and status not in ('signed','declined','cancelled')`, [job.tenantId, row.signer_id]);
      await audit(tx, job.tenantId, 'BUSINESS', 'bankid.evidence_failed', 'identity_transaction', identityTransactionId, { identityTransactionId, reportSha256: hashes.report, failedChecks: allChecks.filter((check) => !check.passed).map((check) => check.code) });
      await outbox(tx, job.tenantId, 'identity_transaction', identityTransactionId, 'bankid.evidence_failed', { signingIntentId: row.signing_intent_id, reportSha256: hashes.report });
      return;
    }
    const verifiedPersonalNumber = normalizeSwedishPersonalNumber(requireValue(report.personalNumber, 'TIC_EVIDENCE_IDENTITY_MISSING'));
    const verifiedCipher = await infrastructure.sensitiveData.encryptText(verifiedPersonalNumber, 'signer.verified_personal_number');
    const verifiedIndex = await infrastructure.sensitiveData.blindIndex(verifiedPersonalNumber, 'signer.verified_personal_number');
    await tx.query(`update app.identity_transactions set status='verified',verified_at=$3 where tenant_id=$1 and id=$2 and status='complete_collected'`, [job.tenantId, identityTransactionId, report.verifiedAt]);
    await tx.query(`update app.signing_intents set status='verified',completed_at=$3 where tenant_id=$1 and id=$2 and status='evidence_collected'`, [job.tenantId, row.signing_intent_id, report.verifiedAt]);

    // A TIC PASS means the person was identified and consented to these exact
    // document hashes. It is not a signature: no PDF has been signed at this
    // point, and nothing here may claim otherwise. The signer therefore reaches
    // 'identity_verified' and no further; PADES_CREATE takes it from here, and
    // only an admitted PAdES signature over every document can reach 'signed'.
    await tx.query(`update app.signers set status='identity_verified',status_version=status_version+1,verified_identifier_ciphertext=$3,verified_identifier_blind_index=$4 where tenant_id=$1 and id=$2 and status='identity_started'`, [job.tenantId, row.signer_id, verifiedCipher, verifiedIndex]);

    await enqueue(tx, job.tenantId, 'PADES_CREATE', `pades-create:${row.signing_intent_id}`, { signingIntentId: row.signing_intent_id });
    await audit(tx, job.tenantId, 'BUSINESS', 'bankid.evidence_verified', 'identity_transaction', identityTransactionId, { identityTransactionId, signingIntentId: row.signing_intent_id, reportSha256: hashes.report, signatureXmlSha256: hashes.xml, ocspSha256: hashes.ocsp });
    await audit(tx, job.tenantId, 'BUSINESS', 'signer.identity_verified', 'signer', row.signer_id, { signerId: row.signer_id, signatureCaseId: row.signature_case_id, signingIntentId: row.signing_intent_id });
    await outbox(tx, job.tenantId, 'signer', row.signer_id, 'signer.identity_verified', { signatureCaseId: row.signature_case_id, signingIntentId: row.signing_intent_id });
  });
}

async function handleEvidencePackageBuild(database: SqlDatabase, infrastructure: ProductionInfrastructure, job: DurableJob): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  const signatureCaseId = uuidPayload(job.payload, 'signatureCaseId');
  const signerId = optionalUuidPayload(job.payload, 'signerId');
  const context = workerContext(job.tenantId);
  const packageData = await loadEvidenceFiles(database, infrastructure, context, signatureCaseId, signerId);
  const manifest = await createEvidenceManifest(signatureCaseId, packageData.files, packageData.metadata as CanonicalJsonValue, packageData.createdAt);
  const manifestBytes = UTF8.encode(canonicalJson(manifest as unknown as CanonicalJsonValue));
  const checksumLines = [...manifest.entries].sort((a,b) => a.path.localeCompare(b.path,'en')).map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
  const allFiles = [
    ...packageData.files,
    { path: 'manifest.json', bytes: manifestBytes, mediaType: 'application/json' },
    { path: 'checksums.sha256', bytes: UTF8.encode(checksumLines), mediaType: 'text/plain; charset=utf-8' },
  ].sort((a,b) => a.path.localeCompare(b.path,'en'));
  const zip = createEvidenceZip(allFiles);
  const packageSha = await sha256Hex(zip);
  const verificationId = randomToken(24);
  const suffix = signerId ? `signers/${signerId}/signer-evidence.zip` : 'case/kommunsign-evidence-package-v1.zip';
  const objectKey = `${job.tenantId}/cases/${signatureCaseId}/evidence/${suffix}`;
  await infrastructure.objectStorage.putObject(context, objectKey, zip, 'application/zip', true);
  await tenant(database, job.tenantId, async (tx) => {
    const existing = await tx.query<{readonly id:string;readonly status:string}>(`select id,status from app.evidence_packages where tenant_id=$1 and signature_case_id=$2 and signer_id is not distinct from $3`, [job.tenantId, signatureCaseId, signerId ?? null]);
    if (existing.rows[0]?.status === 'ready') return;
    const packageId = existing.rows[0]?.id ?? crypto.randomUUID();
    if (!existing.rows[0]) await tx.query(`insert into app.evidence_packages(tenant_id,id,signature_case_id,signer_id,object_key,manifest_sha256,status,verification_id,package_sha256,ready_at) values($1,$2,$3,$4,$5,$6,'ready',$7,$8,now())`, [job.tenantId, packageId, signatureCaseId, signerId ?? null, objectKey, await sha256Hex(manifestBytes), verificationId, packageSha]);
    else await tx.query(`update app.evidence_packages set object_key=$4,manifest_sha256=$5,status='ready',verification_id=coalesce(verification_id,$6),package_sha256=$7,ready_at=now() where tenant_id=$1 and id=$2 and signature_case_id=$3 and status='preparing'`, [job.tenantId, packageId, signatureCaseId, objectKey, await sha256Hex(manifestBytes), verificationId, packageSha]);
    let ordinal = 0;
    for (const file of allFiles) {
      ordinal += 1;
      const fileObjectKey = `${job.tenantId}/cases/${signatureCaseId}/evidence/files/${packageId}/${file.path}`;
      await infrastructure.objectStorage.putObject!(context, fileObjectKey, file.bytes, file.mediaType, true);
      await tx.query(`insert into app.evidence_package_files(tenant_id,evidence_package_id,ordinal,path,media_type,byte_size,sha256,object_key) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`, [job.tenantId, packageId, ordinal, file.path, file.mediaType, file.bytes.byteLength, await sha256Hex(file.bytes), fileObjectKey]);
    }
    if (signerId) {
      await tx.query(`update app.signing_intents set status='packaged' where tenant_id=$1 and signature_case_id=$2 and signer_id=$3 and status='verified'`, [job.tenantId, signatureCaseId, signerId]);
    } else {
      await tx.query(`update app.signature_cases set status='completed',completed_at=now(),status_version=status_version+1,updated_at=now() where tenant_id=$1 and id=$2 and status in ('sent','in_progress','partially_signed')`, [job.tenantId, signatureCaseId]);
      await audit(tx, job.tenantId, 'BUSINESS', 'case.completed', 'signature_case', signatureCaseId, { signatureCaseId, evidencePackageId: packageId, packageSha256: packageSha, verificationId });
      await outbox(tx, job.tenantId, 'signature_case', signatureCaseId, 'case.completed', { evidencePackageId: packageId, packageSha256: packageSha, verificationId });
    }
    await audit(tx, job.tenantId, 'BUSINESS', 'evidence_package.ready', 'evidence_package', packageId, { signatureCaseId, signerId: signerId ?? null, packageSha256: packageSha, verificationId });
    await outbox(tx, job.tenantId, 'evidence_package', packageId, 'evidence_package.ready', { signatureCaseId, signerId: signerId ?? null, packageSha256: packageSha, verificationId });
  });
}

async function handleEmailSend(database: SqlDatabase, infrastructure: ProductionInfrastructure, services: Services, job: DurableJob): Promise<void> {
  const emailMessageId = uuidPayload(job.payload, 'emailMessageId');
  const row = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<EmailRow>(
      `select m.id,m.signer_id,m.signature_case_id,m.template_key,m.template_version,m.locale,m.recipient_ciphertext,m.message_payload_ciphertext,m.idempotency_key,m.status,m.attempt_count,m.maximum_attempts,o.legal_name
         from app.email_messages m left join app.signature_cases c on c.tenant_id=m.tenant_id and c.id=m.signature_case_id
         left join app.organizations o on o.tenant_id=c.tenant_id
        where m.tenant_id=$1 and m.id=$2 for update`, [job.tenantId, emailMessageId]);
    return requireRow(result.rows[0], 'EMAIL_MESSAGE_NOT_FOUND');
  });
  if (['accepted','delivered','bounced','complained','cancelled'].includes(row.status)) return;
  const recipient = await infrastructure.sensitiveData.decryptText(row.recipient_ciphertext, 'signer.email');
  const payload = JSON.parse(await infrastructure.sensitiveData.decryptText(row.message_payload_ciphertext, `email.${row.template_key}`)) as Record<string, unknown>;
  const rendered = renderEmail(row.template_key, payload, row.legal_name ?? 'Kommunsign', services);
  const message: EmailMessage = { from: services.defaultFrom, to: [{ email: recipient }], replyTo: services.defaultReplyTo, subject: rendered.subject, html: rendered.html, text: rendered.text, idempotencyKey: row.idempotency_key, tags: { tenant: job.tenantId, template: row.template_key } };
  try {
    const result = await services.email.send(message);
    await tenant(database, job.tenantId, async (tx) => {
      await tx.query(`update app.email_messages set status='accepted',provider=$3,provider_message_id=$4,accepted_at=$5,attempt_count=attempt_count+1,updated_at=now(),last_error_code=null where tenant_id=$1 and id=$2`, [job.tenantId, emailMessageId, result.provider, result.providerMessageId, result.acceptedAt]);
      await audit(tx, job.tenantId, 'BUSINESS', 'email.accepted', 'email_message', emailMessageId, { emailMessageId, provider: result.provider, providerMessageId: result.providerMessageId, templateKey: row.template_key });
      await outbox(tx, job.tenantId, 'email_message', emailMessageId, 'email.accepted', { provider: result.provider, providerMessageId: result.providerMessageId, templateKey: row.template_key });
    });
  } catch (error) {
    if (error instanceof EmailProviderError && !error.retryable) {
      await tenant(database, job.tenantId, async (tx) => tx.query(`update app.email_messages set status='failed',attempt_count=attempt_count+1,last_error_code=$3,updated_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, emailMessageId, error.code]));
      return;
    }
    throw error;
  }
}

async function handleReminder(database: SqlDatabase, infrastructure: ProductionInfrastructure, job: DurableJob): Promise<void> {
  const signatureCaseId = uuidPayload(job.payload, 'signatureCaseId');
  await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<ReminderRow>(
      `select s.id,s.email_ciphertext,c.expires_at from app.signers s join app.signature_cases c on c.tenant_id=s.tenant_id and c.id=s.signature_case_id
        where s.tenant_id=$1 and s.signature_case_id=$2 and s.status in ('invited','opened') and s.hard_bounced_at is null and s.complained_at is null`, [job.tenantId, signatureCaseId]);
    for (const signer of result.rows) {
      await tx.query(`update app.signer_invitations set revoked_at=now() where tenant_id=$1 and signer_id=$2 and used_at is null and revoked_at is null`, [job.tenantId, signer.id]);
      const invitationId = crypto.randomUUID(); const token = randomToken(32);
      const tokenHash = await infrastructure.sensitiveData.blindIndex(token, 'signer.invitation_token');
      const expiresAt = signer.expires_at ? new Date(signer.expires_at).toISOString() : new Date(Date.now() + 7 * 86_400_000).toISOString();
      await tx.query(`insert into app.signer_invitations(tenant_id,id,signer_id,token_hash,expires_at) values($1,$2,$3,$4,$5)`, [job.tenantId, invitationId, signer.id, tokenHash, expiresAt]);
      const messageId = crypto.randomUUID(); const payload = JSON.stringify({ invitationToken: token, signerId: signer.id, signatureCaseId, tenantId: job.tenantId, expiresAt });
      const encryptedPayload = await infrastructure.sensitiveData.encryptText(payload, 'email.signature_reminder');
      await tx.query(`insert into app.email_messages(tenant_id,id,signer_id,signature_case_id,template_key,template_version,locale,recipient_ciphertext,message_payload_ciphertext,payload_sha256,idempotency_key) values($1,$2,$3,$4,'signature_reminder',1,'sv-SE',$5,$6,$7,$8)`, [job.tenantId, messageId, signer.id, signatureCaseId, signer.email_ciphertext, encryptedPayload, await sha256Hex(payload), `signature-reminder:${invitationId}`]);
      await enqueue(tx, job.tenantId, 'EMAIL_SEND', `email:${messageId}`, { emailMessageId: messageId });
      await audit(tx, job.tenantId, 'BUSINESS', 'invitation.revoked', 'signer', signer.id, { signerId: signer.id, reason: 'TOKEN_ROTATED_FOR_REMINDER' });
      await audit(tx, job.tenantId, 'BUSINESS', 'invitation.created', 'signer', signer.id, { signerId: signer.id, signatureCaseId, reminder: true });
    }
  });
}

async function handleCaseExpire(database: SqlDatabase, job: DurableJob): Promise<void> {
  const signatureCaseId = uuidPayload(job.payload, 'signatureCaseId');
  await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<{readonly status:string;readonly expires_at:string|Date|null}>(`select status,expires_at from app.signature_cases where tenant_id=$1 and id=$2 for update`, [job.tenantId, signatureCaseId]);
    const row = requireRow(result.rows[0], 'SIGNATURE_CASE_NOT_FOUND');
    if (['completed','declined','expired','cancelled','failed','archived'].includes(row.status)) return;
    if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()) throw new Error('CASE_NOT_EXPIRED_YET');
    await tx.query(`update app.signature_cases set status='expired',status_version=status_version+1,updated_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, signatureCaseId]);
    await tx.query(`update app.signers set status='expired',status_version=status_version+1 where tenant_id=$1 and signature_case_id=$2 and status not in ('signed','declined','cancelled','failed')`, [job.tenantId, signatureCaseId]);
    await tx.query(`update app.signer_invitations i set revoked_at=now() from app.signers s where s.tenant_id=i.tenant_id and s.id=i.signer_id and s.tenant_id=$1 and s.signature_case_id=$2 and i.used_at is null and i.revoked_at is null`, [job.tenantId, signatureCaseId]);
    await audit(tx, job.tenantId, 'BUSINESS', 'case.expired', 'signature_case', signatureCaseId, { signatureCaseId });
    await outbox(tx, job.tenantId, 'signature_case', signatureCaseId, 'case.expired', { signatureCaseId });
  });
}

async function handleApplicationNotification(controlDatabase: SqlDatabase, infrastructure: ProductionInfrastructure, services: Services, job: DurableJob): Promise<void> {
  const encrypted = stringPayload(job.payload, 'encryptedPayload');
  const decoded = decodeBase64(encrypted, 'APPLICATION_NOTIFICATION_PAYLOAD_INVALID');
  const payload = JSON.parse(await infrastructure.sensitiveData.decryptText(decoded, 'onboarding.application_notification')) as Record<string, unknown>;
  const email = requiredString(payload.email, 'APPLICATION_NOTIFICATION_EMAIL_MISSING');
  const template = requiredString(payload.template, 'APPLICATION_NOTIFICATION_TEMPLATE_MISSING');
  if (template !== 'email_verification') throw permanent('APPLICATION_NOTIFICATION_TEMPLATE_UNSUPPORTED');
  const token = requiredString(payload.verificationToken, 'APPLICATION_NOTIFICATION_TOKEN_MISSING');
  const applicationId = requiredString(payload.applicationId, 'APPLICATION_NOTIFICATION_APPLICATION_MISSING');
  const url = `${services.onboardingUrl}/verify-email?applicationId=${encodeURIComponent(applicationId)}&token=${encodeURIComponent(token)}`;
  await services.email.send({ from: services.defaultFrom, to: [{ email }], replyTo: services.defaultReplyTo, subject: 'Verifiera din e-postadress för Kommunsign', text: `Verifiera din e-postadress genom att öppna länken:\n${url}\n\nLänken är tidsbegränsad.`, html: `<p>Verifiera din e-postadress för Kommunsign.</p><p><a href="${escapeHtml(url)}">Verifiera e-postadress</a></p><p>Länken är tidsbegränsad.</p>`, idempotencyKey: job.idempotencyKey, tags: { application: applicationId, template } });
  await controlDatabase.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('control-audit-chain',0))`);
    const previous = await tx.query<{ readonly event_hash: string }>(`select event_hash from control.control_audit_events order by occurred_at desc,id desc limit 1`);
    const previousHash = previous.rows[0]?.event_hash ?? '0'.repeat(64);
    const auditPayload = { applicationId, template, jobId: job.id };
    const eventHash = await sha256Hex(JSON.stringify({ tenantId: null, actorId: null, eventType: 'onboarding.notification.accepted', payload: auditPayload, previousHash }));
    await tx.query(`insert into control.control_audit_events(tenant_id,actor_id,event_type,payload,previous_event_hash,event_hash) values(null,null,'onboarding.notification.accepted',$1::jsonb,$2,$3)`, [auditPayload, previousHash, eventHash]);
  });
}

async function loadEvidenceFiles(database: SqlDatabase, infrastructure: ProductionInfrastructure, context: TenantContext, signatureCaseId: string, signerId?: string): Promise<{readonly files:EvidenceFile[];readonly metadata:Readonly<Record<string,CanonicalJsonValue>>;readonly createdAt:string}> {
  const caseInfo = await tenant(database, context.tenantId, async (tx) => {
    const caseResult = await tx.query<{readonly title:string;readonly external_reference:string|null;readonly legal_name:string|null}>(`select c.title,c.external_reference,o.legal_name from app.signature_cases c left join app.organizations o on o.tenant_id=c.tenant_id where c.tenant_id=$1 and c.id=$2`, [context.tenantId, signatureCaseId]);
    const signers = await tx.query<EvidenceSignerRow>(
      `select s.id,si.visible_text,si.non_visible_payload,tia.collect_response_object_key,tia.signature_xml_object_key,tia.ocsp_response_object_key,tia.verification_report_object_key,tia.verified_at
         from app.signers s join app.signing_intents si on si.tenant_id=s.tenant_id and si.signer_id=s.id
         join app.tic_identity_artifacts tia on tia.tenant_id=si.tenant_id and tia.signing_intent_id=si.id and tia.verification_result='PASS'
        where s.tenant_id=$1 and s.signature_case_id=$2 and ($3::uuid is null or s.id=$3) order by s.signing_order,s.id`, [context.tenantId, signatureCaseId, signerId ?? null]);
    const documents = await tx.query<EvidenceDocumentRow>(`select d.id,d.display_name,v.canonical_object_key,v.sha256 from app.documents d join app.document_versions v on v.tenant_id=d.tenant_id and v.document_id=d.id where d.tenant_id=$1 and d.signature_case_id=$2 and v.status in ('locked','partially_signed','signed','validated','archived') order by d.created_at,d.id`, [context.tenantId, signatureCaseId]);
    const reports = await tx.query<{readonly object_key:string;readonly report_type:string;readonly document_version_id:string}>(`select r.object_key,r.report_type,r.document_version_id from app.document_processor_reports r join app.document_versions v on v.tenant_id=r.tenant_id and v.id=r.document_version_id join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id where r.tenant_id=$1 and d.signature_case_id=$2 and r.report_type='PDFA_VALIDATION' order by d.created_at,d.id`, [context.tenantId, signatureCaseId]);
    const audits = await tx.query(`select sequence,category,event_type,actor_type,actor_id,resource_type,resource_id,payload,occurred_at,previous_event_hash,event_hash,hash_version from audit.audit_events where tenant_id=$1 and (resource_id=$2 or payload->>'signatureCaseId'=$2::text) order by sequence`, [context.tenantId, signatureCaseId]);
    return { caseRow: requireRow(caseResult.rows[0], 'SIGNATURE_CASE_NOT_FOUND'), signers: signers.rows, documents: documents.rows, reports: reports.rows, audits: audits.rows };
  });
  if (caseInfo.signers.length === 0) throw permanent('EVIDENCE_VERIFIED_SIGNER_MISSING');
  const files: EvidenceFile[] = [];
  if (!signerId) {
    let ordinal = 0;
    for (const document of caseInfo.documents) {
      ordinal += 1;
      const artifact = await infrastructure.objectStorage.downloadObject(context, requireValue(document.canonical_object_key, 'DOCUMENT_NOT_READY'), { contentType: 'application/pdf', fileName: document.display_name, sha256: requireValue(document.sha256, 'DOCUMENT_HASH_MISSING') });
      files.push({ path: `documents/${String(ordinal).padStart(3,'0')}-${safeFileName(document.display_name)}`, bytes: artifact.bytes, mediaType: 'application/pdf' });
    }
  }
  for (const signer of caseInfo.signers) {
    const prefix = signerId ? '' : `signers/${signer.id}/`;
    const artifacts = await Promise.all([
      infrastructure.objectStorage.downloadObject(context, signer.collect_response_object_key, { contentType: 'application/json', fileName: 'tic-collect-response.json' }),
      infrastructure.objectStorage.downloadObject(context, signer.signature_xml_object_key, { contentType: 'application/xml', fileName: 'tic-signature.xml' }),
      infrastructure.objectStorage.downloadObject(context, signer.ocsp_response_object_key, { contentType: 'application/ocsp-response', fileName: 'tic-ocsp-response.der' }),
      infrastructure.objectStorage.downloadObject(context, signer.verification_report_object_key, { contentType: 'application/json', fileName: 'verification-report.json' }),
    ]);
    files.push(
      { path: `${prefix}visible-data.txt`, bytes: UTF8.encode(signer.visible_text), mediaType: 'text/plain; charset=utf-8' },
      { path: `${prefix}non-visible-data.json`, bytes: UTF8.encode(signer.non_visible_payload), mediaType: 'application/json' },
      { path: `${prefix}tic-collect-response.json`, bytes: artifacts[0].bytes, mediaType: 'application/json' },
      { path: `${prefix}tic-signature.xml`, bytes: artifacts[1].bytes, mediaType: 'application/xml' },
      { path: `${prefix}tic-ocsp-response.der`, bytes: artifacts[2].bytes, mediaType: 'application/ocsp-response' },
      { path: `${prefix}verification-report.json`, bytes: artifacts[3].bytes, mediaType: 'application/json' },
    );
  }
  if (!signerId) {
    let ordinal = 0;
    for (const report of caseInfo.reports) {
      ordinal += 1;
      const artifact = await infrastructure.objectStorage.downloadObject(context, report.object_key, { contentType: 'application/json', fileName: 'pdfa-validation.json' });
      files.push({ path: `reports/pdfa-validation-${String(ordinal).padStart(3,'0')}.json`, bytes: artifact.bytes, mediaType: artifact.contentType });
    }
    files.push({ path: 'audit/case-audit-events.json', bytes: UTF8.encode(canonicalJson(caseInfo.audits as unknown as CanonicalJsonValue)), mediaType: 'application/json' });
    files.push({ path: 'signing-receipt.pdf', bytes: createReceiptPdf(caseInfo.caseRow.title, caseInfo.caseRow.external_reference ?? signatureCaseId, caseInfo.caseRow.legal_name ?? 'Kommunsign-tenant', caseInfo.signers.length, new Date(caseInfo.signers.at(-1)!.verified_at).toISOString()), mediaType: 'application/pdf' });
  } else {
    files.push({ path: 'audit-events.json', bytes: UTF8.encode(canonicalJson(caseInfo.audits as unknown as CanonicalJsonValue)), mediaType: 'application/json' });
  }
  const createdAt = new Date(caseInfo.signers.map((signer) => new Date(signer.verified_at).getTime()).sort((a,b)=>b-a)[0]!).toISOString();
  return { files, metadata: { organization: caseInfo.caseRow.legal_name ?? 'Kommunsign-tenant', caseReference: caseInfo.caseRow.external_reference ?? signatureCaseId, caseTitle: caseInfo.caseRow.title, signerCount: caseInfo.signers.length, packageType: signerId ? 'signer' : 'case' }, createdAt };
}

function createServices(configuration: Readonly<Record<string,string>>): Services {
  const emailProviderName = required(configuration, 'EMAIL_PROVIDER').toLowerCase();
  const applicationEnvironment = (configuration.APP_ENV ?? 'production').trim().toLowerCase();
  const email: EmailProvider = emailProviderName === 'resend'
    ? new ResendEmailProvider({ apiKey: required(configuration, 'RESEND_API_KEY'), webhookSecret: required(configuration, 'RESEND_WEBHOOK_SECRET') })
    : emailProviderName === 'development' && applicationEnvironment !== 'production'
      ? new DevelopmentEmailProvider()
      : (() => { throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED'); })();
  const ticEnabled = booleanValue(configuration, 'TIC_BANKID_ENABLED', false);
  const tic = ticEnabled ? new TicBankIdProvider({ baseUrl: required(configuration, 'TIC_BASE_URL'), apiKey: required(configuration, 'TIC_API_KEY'), callbackUrl: required(configuration, 'TIC_CALLBACK_URL'), webhookUrl: required(configuration, 'TIC_WEBHOOK_URL'), timeoutMs: numberValue(configuration, 'TIC_REQUEST_TIMEOUT_MS', 10_000) }) : null;
  return {
    clam: new ClamAvInstreamClient(required(configuration, 'CLAMAV_HOST'), numberValue(configuration, 'CLAMAV_PORT', 3310), numberValue(configuration, 'CLAMAV_TIMEOUT_MS', 30_000)),
    qpdf: new QpdfInspector(configuration.QPDF_COMMAND ?? 'qpdf', numberValue(configuration, 'QPDF_TIMEOUT_MS', 30_000)),
    gotenberg: new GotenbergPdfAClient(required(configuration, 'GOTENBERG_URL'), numberValue(configuration, 'GOTENBERG_TIMEOUT_MS', 120_000)),
    verapdf: new VeraPdfRestClient(required(configuration, 'VERAPDF_URL'), configuration.VERAPDF_VALIDATE_PATH ?? '/api/validate/2b', numberValue(configuration, 'VERAPDF_TIMEOUT_MS', 120_000)),
    tic,
    validation: new ValidationServiceClient(required(configuration, 'VALIDATION_SERVICE_URL'), required(configuration, 'VALIDATION_SERVICE_TOKEN')),
    email,
    signUrl: httpsUrl(required(configuration, 'SIGNER_FALLBACK_URL')),
    onboardingUrl: httpsUrl(required(configuration, 'ONBOARDING_PORTAL_URL')),
    defaultFrom: parseAddress(required(configuration, 'EMAIL_DEFAULT_FROM')),
    defaultReplyTo: parseAddress(required(configuration, 'EMAIL_DEFAULT_REPLY_TO')),
  };
}


/**
 * Wires the PAdES stages.
 *
 * Both the SignService URL and the trust anchors are optional at construction
 * and fatal at use. That is deliberate: a deployment doing digital approval only
 * has no signing service, and refusing to boot the whole worker for that would
 * take out document scanning and email as well. A deployment doing electronic
 * signatures without them fails on the first PADES_CREATE, loudly and in one
 * place, rather than silently producing cases that look signed.
 */
function padesServices(configuration: Readonly<Record<string,string>>, validation: ValidationServiceClient): PadesServices {
  const signserviceUrl = configuration.SIGNSERVICE_URL?.trim();
  const signserviceToken = configuration.SIGNSERVICE_TOKEN?.trim();
  const signservice = signserviceUrl && signserviceToken ? new SignServiceClient(signserviceUrl, signserviceToken) : null;
  return { signservice, validation, trustAnchorsBase64: trustAnchors(configuration) };
}

/**
 * The certificate authorities whose signatures this deployment will accept.
 *
 * There is no default and no fallback to the host JDK's trust store. A validator
 * that trusts whatever the base image happens to ship would answer a question
 * nobody asked: what matters is whether the signer chains to the CA this
 * deployment was configured to trust.
 */
function trustAnchors(configuration: Readonly<Record<string,string>>): readonly string[] {
  const configured = configuration.SIGNING_TRUST_ANCHORS_BASE64?.trim();
  if (!configured) return [];
  return configured.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function renderEmail(templateKey: string, payload: Record<string,unknown>, organization: string, services: Services): {readonly subject:string;readonly text:string;readonly html:string} {
  const token = requiredString(payload.invitationToken, 'EMAIL_TEMPLATE_TOKEN_MISSING');
  const expiresAt = new Date(requiredString(payload.expiresAt, 'EMAIL_TEMPLATE_EXPIRY_MISSING')).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const url = `${services.signUrl}/?token=${encodeURIComponent(token)}`;
  const reminder = templateKey === 'signature_reminder';
  if (!['signature_invitation','signature_reminder'].includes(templateKey)) throw permanent('EMAIL_TEMPLATE_NOT_IMPLEMENTED');
  const subject = reminder ? `Påminnelse: handling väntar på din underskrift hos ${organization}` : `Handling väntar på din underskrift hos ${organization}`;
  const text = `${reminder ? 'Påminnelse: ' : ''}${organization} har skickat handlingar som ska granskas och undertecknas med BankID.\n\nÖppna signeringen: ${url}\n\nLänken gäller till ${expiresAt}. Dokument bifogas inte i e-post. Kommunsign visar de exakta PDF/A-handlingarna innan BankID startas.`;
  const html = `<p>${reminder ? '<strong>Påminnelse:</strong> ' : ''}${escapeHtml(organization)} har skickat handlingar som ska granskas och undertecknas med BankID.</p><p><a href="${escapeHtml(url)}">Öppna signeringen</a></p><p>Länken gäller till ${escapeHtml(expiresAt)}. Dokument bifogas inte i e-post. Kommunsign visar de exakta PDF/A-handlingarna innan BankID startas.</p>`;
  return { subject, text, html };
}

async function rejectDocument(database: SqlDatabase, infrastructure: ProductionInfrastructure, tenantId: string, row: {readonly id:string;readonly document_id:string;readonly signature_case_id:string}, code: string, details: Readonly<Record<string,unknown>>): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(`update app.document_versions set status='rejected' where tenant_id=$1 and id=$2 and status not in ('ready','locked','partially_signed','signed','validated','archived')`, [tenantId, row.id]);
    await audit(tx, tenantId, 'BUSINESS', 'document.scan_failed', 'document_version', row.id, { documentVersionId: row.id, errorCode: safeCode(code), ...details });
    await outbox(tx, tenantId, 'document', row.document_id, 'document.scan_failed', { documentVersionId: row.id, errorCode: safeCode(code) });
  });
  void infrastructure;
}

async function saveProcessorReport(database: SqlDatabase, infrastructure: ProductionInfrastructure, tenantId: string, row: {readonly id:string;readonly document_id:string;readonly signature_case_id:string}, reportType: 'MALWARE_SCAN'|'PDF_POLICY'|'QPDF_CHECK'|'PDFA_CONVERSION'|'PDFA_VALIDATION', engine: string, engineVersion: string, result: 'PASS'|'FAIL'|'ERROR', report: unknown, findings: readonly unknown[]): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  const bytes = UTF8.encode(canonicalJson(report as CanonicalJsonValue));
  const key = `${tenantId}/cases/${row.signature_case_id}/documents/${row.document_id}/versions/${row.id}/validation/${reportType.toLowerCase()}.json`;
  await infrastructure.objectStorage.putObject(workerContext(tenantId), key, bytes, 'application/json', true);
  await tenant(database, tenantId, async (tx) => tx.query(
    `insert into app.document_processor_reports(tenant_id,document_version_id,report_type,engine,engine_version,result,object_key,sha256,findings)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict(tenant_id,document_version_id,report_type) do nothing`,
    [tenantId, row.id, reportType, engine, engineVersion, result, key, await sha256Hex(bytes), findings],
  ));
}

async function tenant<T>(database: SqlDatabase, tenantId: string, work: (tx: SqlTransaction) => Promise<T>): Promise<T> { return withTenantTransaction(database, workerContext(tenantId), 'worker', work); }
function workerContext(tenantId: string): TenantContext { return { tenantId, subjectId: SYSTEM_ACTOR_ID, requestId: crypto.randomUUID(), authMethod: 'worker', source: 'deployment' }; }
async function audit(tx: SqlTransaction, tenantId: string, category: 'TECHNICAL'|'BUSINESS', eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string,unknown>>): Promise<void> { await tx.query(`select audit.append_event($1,$2,$3,'worker',$4,$5,$6,$7::jsonb,now())`, [tenantId, category, eventType, SYSTEM_ACTOR_ID, resourceType, resourceId, payload]); }
async function outbox(tx: SqlTransaction, tenantId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Readonly<Record<string,unknown>>): Promise<void> { const serialized=JSON.stringify(payload); await tx.query(`insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId,aggregateType,aggregateId,eventType,payload,await sha256Hex(serialized)]); }
async function enqueue(tx: SqlTransaction, tenantId: string, type: DurableJobType, key: string, payload: Readonly<Record<string,unknown>>): Promise<void> { await tx.query(`insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts) values($1,$2,$3::jsonb,$4,'pending',now(),10) on conflict(tenant_id,job_type,idempotency_key) do nothing`, [tenantId,type,payload,key]); }

function uuidPayload(payload: Readonly<Record<string,unknown>>, key: string): string { const value=stringPayload(payload,key); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`); return value; }
function optionalUuidPayload(payload: Readonly<Record<string,unknown>>, key: string): string|undefined { return payload[key]===undefined ? undefined : uuidPayload(payload,key); }
function stringPayload(payload: Readonly<Record<string,unknown>>, key: string): string { const value=payload[key]; if(typeof value!=='string'||!value.trim())throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`); return value; }
function asObject(value: unknown, code: string): Record<string,unknown> { if(!value||typeof value!=='object'||Array.isArray(value))throw permanent(code); return value as Record<string,unknown>; }
function requiredString(value: unknown, code: string): string { if(typeof value!=='string'||!value)throw permanent(code); return value; }
function requireRow<T>(row:T|undefined,code:string):T { if(!row)throw permanent(code); return row; }
function requireValue<T>(value:T|null|undefined,code:string):T { if(value===null||value===undefined)throw permanent(code); return value; }
function required(configuration:Readonly<Record<string,string>>,key:string):string { const value=configuration[key]?.trim();if(!value)throw new Error(`${key}_MISSING`);return value; }
function numberValue(configuration:Readonly<Record<string,string>>,key:string,fallback:number):number { const value=Number(configuration[key]??fallback);if(!Number.isSafeInteger(value)||value<1)throw new Error(`${key}_INVALID`);return value; }
function booleanValue(configuration:Readonly<Record<string,string>>,key:string,fallback:boolean):boolean { const value=configuration[key]?.trim().toLowerCase();if(!value)return fallback;if(value==='true')return true;if(value==='false')return false;throw new Error(`${key}_INVALID`); }
function httpsUrl(value:string):string { const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('PUBLIC_URL_INVALID');return url.toString().replace(/\/$/,''); }
function parseAddress(value:string):{readonly email:string;readonly name?:string} { const match=/^\s*([^<>]+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);const email=match?.[2]??value.trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('EMAIL_ADDRESS_INVALID');return match?.[1]?{email,name:match[1].trim()}:{email}; }
function decodeBase64(value:string,code:string):Uint8Array { try { const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normalized);const bytes=Uint8Array.from(binary,(char)=>char.charCodeAt(0));if(bytes.byteLength===0)throw new Error(code);return bytes; } catch { throw permanent(code); } }
function permanent(code:string):Error { const error=new Error(safeCode(code));error.name='PermanentWorkerError';return error; }
function safeCode(value:string):string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g,'_').slice(0,120)||'WORKER_ERROR'; }
function isPermanentDocumentError(error:unknown):boolean { return error instanceof Error && /DOCUMENT_(TOO_LARGE|PAGE_LIMIT_EXCEEDED|PDF_POLICY_REJECTED|SIZE_POLICY_INVALID|PAGE_POLICY_INVALID|COUNT_POLICY_INVALID|PAGE_COUNT_CHANGED)|PDF_/.test(error.message); }
function escapeHtml(value:string):string { return value.replace(/[&<>"']/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!)); }
function safeFileName(value:string):string { const cleaned=value.replace(/[\\/\0\r\n]/g,'_').replace(/[^\p{L}\p{N}._ -]/gu,'_').trim();return cleaned.toLowerCase().endsWith('.pdf')?cleaned:`${cleaned}.pdf`; }
function createReceiptPdf(title:string,reference:string,organization:string,signerCount:number,signedAt:string):Uint8Array { const lines=["Kommunsign signeringskvitto",`Organisation: ${organization}`,`Ärende: ${reference}`,`Titel: ${title}`,`Antal verifierade signerare: ${signerCount}`,`Senast verifierad: ${signedAt}`,"Detta kvitto är inte den signerade originalhandlingen."];const escaped=lines.map((line)=>line.replace(/([\\()])/g,'\\$1'));let content='BT /F1 12 Tf 50 790 Td ';for(const [index,line] of escaped.entries())content+=`${index?'0 -22 Td ':''}(${line}) Tj `;content+='ET';const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",`<< /Length ${UTF8.encode(content).byteLength} >>\nstream\n${content}\nendstream`,`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`];let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(UTF8.encode(pdf).byteLength);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=UTF8.encode(pdf).byteLength;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return UTF8.encode(pdf); }

interface DocumentSourceRow { readonly id:string;readonly document_id:string;readonly signature_case_id:string;readonly source_object_key:string;readonly mime_type:string;readonly byte_size:number|string;readonly status:string;readonly maximum_document_bytes:number|string;readonly maximum_document_pages:number|string; }
interface CanonicalizeRow { readonly id:string;readonly document_id:string;readonly signature_case_id:string;readonly source_object_key:string;readonly status:string;readonly source_page_count:number|string;readonly maximum_document_bytes:number|string;readonly maximum_document_pages:number|string; }
interface CollectRow { readonly id:string;readonly provider_reference:string;readonly status:string;readonly signing_intent_id:string;readonly signature_case_id:string;readonly signer_id:string; }
interface ValidationRow { readonly id:string;readonly provider_reference:string;readonly status:string;readonly raw_evidence_object_key:string|null;readonly signing_intent_id:string;readonly signature_case_id:string;readonly signer_id:string;readonly visible_text:string;readonly non_visible_payload:string;readonly identifier_binding_mode:'STRICT_PREBOUND'|'BANKID_DISCOVERED';readonly expected_identifier_ciphertext:Uint8Array|null; }
interface ValidationDocumentRow { readonly document_sha256:string;readonly document_version_id:string;readonly canonical_object_key:string|null; }
interface EmailRow { readonly id:string;readonly signer_id:string|null;readonly signature_case_id:string|null;readonly template_key:string;readonly template_version:number;readonly locale:string;readonly recipient_ciphertext:Uint8Array;readonly message_payload_ciphertext:Uint8Array;readonly idempotency_key:string;readonly status:string;readonly attempt_count:number;readonly maximum_attempts:number;readonly legal_name:string|null; }
interface ReminderRow { readonly id:string;readonly email_ciphertext:Uint8Array;readonly expires_at:string|Date|null; }
interface EvidenceSignerRow { readonly id:string;readonly visible_text:string;readonly non_visible_payload:string;readonly collect_response_object_key:string;readonly signature_xml_object_key:string;readonly ocsp_response_object_key:string;readonly verification_report_object_key:string;readonly verified_at:string|Date; }
interface EvidenceDocumentRow { readonly id:string;readonly display_name:string;readonly canonical_object_key:string|null;readonly sha256:string|null; }
