import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob } from './jobs.js';
import { ClamAvInstreamClient, QpdfInspector, VeraPdfRestClient } from '../../../packages/document-processing/src/production.js';
import { GotenbergOfficePdfAClient } from '../../../packages/document-processing/src/office-production.js';
import { documentObjectKeys } from '../../../packages/document-processing/src/index.js';
import { planOfficeIngestion } from '../../../packages/document-processing/src/office-ingestion.js';
import { assertMagicBytesMatch, OFFICE_SOURCE_MIME_TYPES } from '../../../packages/uploads/src/index.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UTF8 = new TextEncoder();
const OFFICE_MIME_TYPES = new Set<string>(OFFICE_SOURCE_MIME_TYPES);

type JobHandler = (job: DurableJob) => Promise<void>;

interface OfficeServices {
  readonly clam: ClamAvInstreamClient;
  readonly qpdf: QpdfInspector;
  readonly gotenberg: GotenbergOfficePdfAClient;
  readonly verapdf: VeraPdfRestClient;
}

interface OfficeDocumentRow {
  readonly id: string;
  readonly document_id: string;
  readonly signature_case_id: string;
  readonly source_object_key: string;
  readonly mime_type: string;
  readonly byte_size: number | string;
  readonly status: string;
  readonly maximum_document_bytes: number | string;
  readonly maximum_document_pages: number | string;
}

export function createOfficeSourceJobHandlers(input: {
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
  readonly configuration: Readonly<Record<string, string>>;
  readonly fallback: Readonly<{
    DOCUMENT_SCAN: JobHandler;
    DOCUMENT_CANONICALIZE: JobHandler;
  }>;
}): Readonly<{ DOCUMENT_SCAN: JobHandler; DOCUMENT_CANONICALIZE: JobHandler }> {
  const services = createServices(input.configuration);
  return {
    DOCUMENT_SCAN: async (job) => {
      const documentVersionId = uuidPayload(job.payload, 'documentVersionId');
      const mimeType = await currentMimeType(input.dataDatabase, job.tenantId, documentVersionId);
      if (!OFFICE_MIME_TYPES.has(mimeType)) return input.fallback.DOCUMENT_SCAN(job);
      return handleOfficeScan(input.dataDatabase, input.infrastructure, services, job, documentVersionId);
    },
    DOCUMENT_CANONICALIZE: async (job) => {
      const documentVersionId = uuidPayload(job.payload, 'documentVersionId');
      const mimeType = await currentMimeType(input.dataDatabase, job.tenantId, documentVersionId);
      if (!OFFICE_MIME_TYPES.has(mimeType)) return input.fallback.DOCUMENT_CANONICALIZE(job);
      return handleOfficeCanonicalize(input.dataDatabase, input.infrastructure, services, job, documentVersionId);
    },
  };
}

async function handleOfficeScan(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: OfficeServices,
  job: DurableJob,
  documentVersionId: string,
): Promise<void> {
  const loaded = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<OfficeDocumentRow>(
      `select v.id,v.document_id,d.signature_case_id,v.source_object_key,v.mime_type,v.byte_size,v.status,
              coalesce(s.maximum_document_bytes,52428800) maximum_document_bytes,
              coalesce(s.maximum_document_pages,500) maximum_document_pages
         from app.document_versions v
         join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
         left join app.tenant_signing_settings s on s.tenant_id=v.tenant_id
        where v.tenant_id=$1 and v.id=$2 for update of v`,
      [job.tenantId, documentVersionId],
    );
    const row = requireRow(result.rows[0], 'DOCUMENT_VERSION_NOT_FOUND');
    if (['canonicalizing','ready','locked','partially_signed','signed','validated','archived'].includes(row.status)) return { skip: true as const, row };
    if (row.status === 'rejected') return { skip: true as const, row };
    if (!['uploaded','quarantined','scanning'].includes(row.status)) throw permanent('DOCUMENT_SCAN_STATE_INVALID');
    await tx.query(`update app.document_versions set status='scanning' where tenant_id=$1 and id=$2`, [job.tenantId, documentVersionId]);
    return { skip: false as const, row };
  });
  if (loaded.skip) return;

  const row = loaded.row;
  const sourceFileName = sourceFileNameFromObjectKey(row.source_object_key);
  try {
    planOfficeIngestion({ fileName: sourceFileName, mimeType: row.mime_type, byteSize: Number(row.byte_size) });
  } catch (error) {
    await rejectDocument(database, job.tenantId, row, safeCode(error instanceof Error ? error.message : 'DOCUMENT_OFFICE_POLICY_REJECTED'), {});
    return;
  }

  const context = workerContext(job.tenantId);
  const artifact = await infrastructure.objectStorage.downloadObject(context, row.source_object_key, {
    contentType: row.mime_type,
    fileName: sourceFileName,
  });
  if (artifact.bytes.byteLength !== Number(row.byte_size)) {
    await rejectDocument(database, job.tenantId, row, 'DOCUMENT_SIZE_MISMATCH', {
      expectedBytes: Number(row.byte_size), actualBytes: artifact.bytes.byteLength,
    });
    return;
  }
  try {
    assertMagicBytesMatch(row.mime_type, artifact.bytes);
  } catch {
    await rejectDocument(database, job.tenantId, row, 'DOCUMENT_OFFICE_MAGIC_BYTES_MISMATCH', {});
    return;
  }

  const malware = await services.clam.scan(artifact.bytes);
  await saveProcessorReport(
    database, infrastructure, job.tenantId, row,
    'MALWARE_SCAN', malware.engine, `${malware.engineVersion}/${malware.signatureVersion}`,
    malware.result === 'CLEAN' ? 'PASS' : 'FAIL', malware,
    malware.finding ? [{ code: 'DOCUMENT_INFECTED' }] : [],
  );
  if (malware.result === 'INFECTED') {
    await rejectDocument(database, job.tenantId, row, 'DOCUMENT_INFECTED', { findingCode: 'MALWARE_FOUND' });
    return;
  }

  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `insert into app.document_scan_results(tenant_id,document_version_id,engine,engine_version,result,findings)
       values($1,$2,'ClamAV',$3,'CLEAN','[]'::jsonb) on conflict do nothing`,
      [job.tenantId, row.id, malware.engineVersion],
    );
    await tx.query(
      `update app.document_versions set status='canonicalizing' where tenant_id=$1 and id=$2 and status='scanning'`,
      [job.tenantId, row.id],
    );
    await enqueue(tx, job.tenantId, 'DOCUMENT_CANONICALIZE', `document-canonicalize:${row.id}`, {
      signatureCaseId: row.signature_case_id,
      documentId: row.document_id,
      documentVersionId: row.id,
    });
    await audit(tx, job.tenantId, 'BUSINESS', 'document.scan_passed', 'document_version', row.id, {
      documentVersionId: row.id,
      sourceMimeType: row.mime_type,
      sourceFileName,
      malwareEngine: malware.engine,
      malwareEngineVersion: malware.engineVersion,
    });
    await outbox(tx, job.tenantId, 'document', row.document_id, 'document.scan_passed', {
      documentVersionId: row.id,
      sourceMimeType: row.mime_type,
    });
  });
}

async function handleOfficeCanonicalize(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: OfficeServices,
  job: DurableJob,
  documentVersionId: string,
): Promise<void> {
  const row = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<OfficeDocumentRow>(
      `select v.id,v.document_id,d.signature_case_id,v.source_object_key,v.mime_type,v.byte_size,v.status,
              coalesce(s.maximum_document_bytes,52428800) maximum_document_bytes,
              coalesce(s.maximum_document_pages,500) maximum_document_pages
         from app.document_versions v
         join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
         left join app.tenant_signing_settings s on s.tenant_id=v.tenant_id
        where v.tenant_id=$1 and v.id=$2`,
      [job.tenantId, documentVersionId],
    );
    return requireRow(result.rows[0], 'DOCUMENT_VERSION_NOT_FOUND');
  });
  if (['ready','locked','partially_signed','signed','validated','archived'].includes(row.status)) return;
  if (row.status === 'rejected') return;
  if (row.status !== 'canonicalizing') throw permanent('DOCUMENT_CANONICALIZE_STATE_INVALID');

  const sourceFileName = sourceFileNameFromObjectKey(row.source_object_key);
  const plan = planOfficeIngestion({ fileName: sourceFileName, mimeType: row.mime_type, byteSize: Number(row.byte_size) });
  const context = workerContext(job.tenantId);
  const source = await infrastructure.objectStorage.downloadObject(context, row.source_object_key, {
    contentType: row.mime_type,
    fileName: sourceFileName,
  });
  if (source.bytes.byteLength !== Number(row.byte_size)) {
    await rejectDocument(database, job.tenantId, row, 'DOCUMENT_SIZE_MISMATCH', {});
    return;
  }

  let converted;
  try {
    converted = await services.gotenberg.convertToPdfA2b({
      bytes: source.bytes,
      fileName: sourceFileName,
      mimeType: row.mime_type,
      traceId: job.id,
    });
  } catch (error) {
    if (error instanceof Error && /TEMPORARY|TIMEOUT|UNAVAILABLE/.test(error.message)) throw error;
    await rejectDocument(database, job.tenantId, row, safeCode(error instanceof Error ? error.message : 'DOCUMENT_OFFICE_CONVERSION_FAILED'), {});
    return;
  }

  let inspection;
  try {
    inspection = await services.qpdf.inspect(converted.bytes, {
      maximumBytes: Number(row.maximum_document_bytes),
      maximumPages: Number(row.maximum_document_pages),
    });
  } catch (error) {
    if (error instanceof Error && /TIMEOUT|UNAVAILABLE/.test(error.message)) throw error;
    await rejectDocument(database, job.tenantId, row, safeCode(error instanceof Error ? error.message : 'DOCUMENT_PDFA_CONVERSION_FAILED'), {});
    return;
  }
  await saveProcessorReport(
    database, infrastructure, job.tenantId, row,
    'QPDF_CHECK', inspection.engine, inspection.engineVersion,
    inspection.passed ? 'PASS' : 'FAIL', inspection, inspection.findings,
  );
  if (!inspection.passed) {
    await rejectDocument(database, job.tenantId, row, 'DOCUMENT_PDFA_CONVERSION_FAILED', {
      findingCodes: inspection.findings.map((finding) => finding.code),
    });
    return;
  }

  const validation = await services.verapdf.validatePdfA2b(converted.bytes);
  const keys = documentObjectKeys({
    tenantId: job.tenantId,
    caseId: row.signature_case_id,
    documentId: row.document_id,
    versionId: row.id,
  });
  const canonicalKey = keys.canonical.replace('/canonical.pdf', '/canonical/canonical.pdf');
  const validationKey = keys.pdfaReport;
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  await infrastructure.objectStorage.putObject(context, validationKey, validation.rawReport, validation.rawReportContentType, true);
  const reportSha = await sha256Hex(validation.rawReport);
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `insert into app.document_processor_reports
         (tenant_id,document_version_id,report_type,engine,engine_version,result,object_key,sha256,findings)
       values($1,$2,'PDFA_VALIDATION','veraPDF',$3,$4,$5,$6,$7::jsonb)
       on conflict(tenant_id,document_version_id,report_type) do nothing`,
      [
        job.tenantId, row.id, validation.engineVersion, validation.compliant ? 'PASS' : 'FAIL',
        validationKey, reportSha, validation.compliant ? [] : [{ code: 'DOCUMENT_PDFA_VALIDATION_FAILED' }],
      ],
    );
  });
  if (!validation.compliant) {
    await rejectDocument(database, job.tenantId, row, 'DOCUMENT_PDFA_VALIDATION_FAILED', { reportSha256: reportSha });
    return;
  }

  const canonicalSha = await sha256Hex(converted.bytes);
  const sourceSha = await sha256Hex(source.bytes);
  if (canonicalSha === sourceSha) {
    await rejectDocument(database, job.tenantId, row, 'OFFICE_CONVERSION_UNVERIFIED', {});
    return;
  }
  await infrastructure.objectStorage.putObject(context, canonicalKey, converted.bytes, 'application/pdf', true);
  const conversionReport = {
    engine: converted.engine,
    engineVersion: converted.engineVersion,
    sourceFormat: plan.sourceFormat,
    sourceMimeType: row.mime_type,
    sourceFileName,
    sourceSha256: sourceSha,
    sourceBytes: source.bytes.byteLength,
    targetProfile: converted.profile,
    canonicalBytes: converted.bytes.byteLength,
    canonicalSha256: canonicalSha,
    canonicalPageCount: inspection.pageCount,
    qpdfEngineVersion: inspection.engineVersion,
    veraPdfEngineVersion: validation.engineVersion,
  };
  await saveProcessorReport(
    database, infrastructure, job.tenantId, row,
    'PDFA_CONVERSION', converted.engine, converted.engineVersion, 'PASS', conversionReport, [],
  );

  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `update app.document_versions
          set status='ready',canonical_object_key=$3,mime_type='application/pdf',byte_size=$4,sha256=$5,
              source_page_count=$6,canonical_page_count=$6,pdf_profile='PDF/A-2b',canonicalized_at=now()
        where tenant_id=$1 and id=$2 and status='canonicalizing'`,
      [job.tenantId, row.id, canonicalKey, converted.bytes.byteLength, canonicalSha, inspection.pageCount],
    );
    await tx.query(
      `insert into app.document_hashes(tenant_id,document_version_id,algorithm,digest)
       values($1,$2,'SHA-256',$3) on conflict do nothing`,
      [job.tenantId, row.id, canonicalSha],
    );
    await audit(tx, job.tenantId, 'BUSINESS', 'document.office_converted', 'document_version', row.id, {
      documentVersionId: row.id,
      sourceMimeType: row.mime_type,
      sourceSha256: sourceSha,
      canonicalSha256: canonicalSha,
      profile: 'PDF/A-2b',
      pageCount: inspection.pageCount,
      converterEngine: converted.engine,
      converterVersion: converted.engineVersion,
      validatorEngine: validation.engine,
      validatorVersion: validation.engineVersion,
      validatorReportSha256: reportSha,
    });
    await audit(tx, job.tenantId, 'BUSINESS', 'document.pdfa_validated', 'document_version', row.id, {
      documentVersionId: row.id,
      profile: 'PDF/A-2b',
      sha256: canonicalSha,
      validatorReportSha256: reportSha,
      convertedFrom: row.mime_type,
    });
    await outbox(tx, job.tenantId, 'document', row.document_id, 'document.pdfa_validated', {
      documentVersionId: row.id,
      sha256: canonicalSha,
      profile: 'PDF/A-2b',
      convertedFrom: row.mime_type,
    });
  });
}

async function currentMimeType(database: SqlDatabase, tenantId: string, documentVersionId: string): Promise<string> {
  return tenant(database, tenantId, async (tx) => {
    const result = await tx.query<{ readonly mime_type: string }>(
      `select mime_type from app.document_versions where tenant_id=$1 and id=$2`,
      [tenantId, documentVersionId],
    );
    return requireRow(result.rows[0], 'DOCUMENT_VERSION_NOT_FOUND').mime_type;
  });
}

function createServices(configuration: Readonly<Record<string, string>>): OfficeServices {
  return {
    clam: new ClamAvInstreamClient(
      required(configuration, 'CLAMAV_HOST'),
      numberValue(configuration, 'CLAMAV_PORT', 3310),
      numberValue(configuration, 'CLAMAV_TIMEOUT_MS', 30_000),
    ),
    qpdf: new QpdfInspector(configuration.QPDF_COMMAND ?? 'qpdf', numberValue(configuration, 'QPDF_TIMEOUT_MS', 30_000)),
    gotenberg: new GotenbergOfficePdfAClient(
      required(configuration, 'GOTENBERG_URL'),
      numberValue(configuration, 'GOTENBERG_TIMEOUT_MS', 120_000),
    ),
    verapdf: new VeraPdfRestClient(
      required(configuration, 'VERAPDF_URL'),
      configuration.VERAPDF_VALIDATE_PATH ?? '/api/validate/2b',
      numberValue(configuration, 'VERAPDF_TIMEOUT_MS', 120_000),
    ),
  };
}

async function rejectDocument(
  database: SqlDatabase,
  tenantId: string,
  row: Pick<OfficeDocumentRow, 'id' | 'document_id'>,
  code: string,
  details: Readonly<Record<string, unknown>>,
): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(
      `update app.document_versions set status='rejected'
        where tenant_id=$1 and id=$2 and status not in ('ready','locked','partially_signed','signed','validated','archived')`,
      [tenantId, row.id],
    );
    await audit(tx, tenantId, 'BUSINESS', 'document.scan_failed', 'document_version', row.id, {
      documentVersionId: row.id,
      errorCode: safeCode(code),
      ...details,
    });
    await outbox(tx, tenantId, 'document', row.document_id, 'document.scan_failed', {
      documentVersionId: row.id,
      errorCode: safeCode(code),
    });
  });
}

async function saveProcessorReport(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  tenantId: string,
  row: Pick<OfficeDocumentRow, 'id' | 'document_id' | 'signature_case_id'>,
  reportType: 'MALWARE_SCAN' | 'PDF_POLICY' | 'QPDF_CHECK' | 'PDFA_CONVERSION' | 'PDFA_VALIDATION',
  engine: string,
  engineVersion: string,
  result: 'PASS' | 'FAIL' | 'ERROR',
  report: unknown,
  findings: readonly unknown[],
): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  const bytes = UTF8.encode(canonicalJson(report as CanonicalJsonValue));
  const key = `${tenantId}/cases/${row.signature_case_id}/documents/${row.document_id}/versions/${row.id}/validation/${reportType.toLowerCase()}.json`;
  await infrastructure.objectStorage.putObject(workerContext(tenantId), key, bytes, 'application/json', true);
  await tenant(database, tenantId, async (tx) => tx.query(
    `insert into app.document_processor_reports
       (tenant_id,document_version_id,report_type,engine,engine_version,result,object_key,sha256,findings)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     on conflict(tenant_id,document_version_id,report_type) do nothing`,
    [tenantId, row.id, reportType, engine, engineVersion, result, key, await sha256Hex(bytes), findings],
  ));
}

async function tenant<T>(
  database: SqlDatabase,
  tenantId: string,
  work: (tx: SqlTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(database, workerContext(tenantId), 'worker', work);
}

function workerContext(tenantId: string): TenantContext {
  return {
    tenantId,
    subjectId: SYSTEM_ACTOR_ID,
    requestId: crypto.randomUUID(),
    authMethod: 'worker',
    source: 'deployment',
  };
}

async function audit(
  tx: SqlTransaction,
  tenantId: string,
  category: 'TECHNICAL' | 'BUSINESS',
  eventType: string,
  resourceType: string,
  resourceId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await tx.query(`select audit.append_event($1,$2,$3,'worker',$4,$5,$6,$7::jsonb,now())`, [
    tenantId, category, eventType, SYSTEM_ACTOR_ID, resourceType, resourceId, payload,
  ]);
}

async function outbox(
  tx: SqlTransaction,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const serialized = JSON.stringify(payload);
  await tx.query(
    `insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256)
     values($1,$2,$3,$4,$5::jsonb,$6)`,
    [tenantId, aggregateType, aggregateId, eventType, payload, await sha256Hex(serialized)],
  );
}

async function enqueue(
  tx: SqlTransaction,
  tenantId: string,
  type: 'DOCUMENT_CANONICALIZE',
  key: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await tx.query(
    `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts)
     values($1,$2,$3::jsonb,$4,'pending',now(),10)
     on conflict(tenant_id,job_type,idempotency_key) do nothing`,
    [tenantId, type, payload, key],
  );
}

function uuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  }
  return value;
}

function sourceFileNameFromObjectKey(objectKey: string): string {
  const value = objectKey.split('/').at(-1)?.trim() ?? '';
  if (!value || value === '.' || value === '..' || /[\\\0\r\n]/.test(value)) throw permanent('DOCUMENT_SOURCE_FILE_NAME_INVALID');
  return value;
}

function required(configuration: Readonly<Record<string, string>>, key: string): string {
  const value = configuration[key]?.trim();
  if (!value) throw new Error(`${key}_MISSING`);
  return value;
}

function numberValue(configuration: Readonly<Record<string, string>>, key: string, fallback: number): number {
  const value = Number(configuration[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key}_INVALID`);
  return value;
}

function requireRow<T>(row: T | undefined, code: string): T {
  if (!row) throw permanent(code);
  return row;
}

function permanent(code: string): Error {
  const error = new Error(safeCode(code));
  error.name = 'PermanentWorkerError';
  return error;
}

function safeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'WORKER_ERROR';
}
