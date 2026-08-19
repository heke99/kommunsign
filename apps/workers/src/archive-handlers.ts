import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob } from './jobs.js';
import {
  ArchiveError, ARCHIVE_PROFILE_VERSION, buildArchivePackage,
  type ArchiveCase, type ArchiveDocument, type ArchiveIdentityEvidence, type ArchiveSignatureEvidence,
} from '../../../packages/archive/src/index.js';
import { buildFgsPackage, FGS_CONFORMANCE_STATUS, type FgsAgents } from '../../../packages/archive/src/fgs.js';
import type { EvidenceFile } from '../../../packages/evidence/src/index.js';
import { createEvidenceZip } from '../../../packages/evidence/src/zip.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { maskSwedishPersonalNumber } from '../../../packages/personal-number/src/index.js';

/**
 * Archive export.
 *
 * Two things leave the system here, and they answer different questions. The
 * canonical JSON manifest (`packages/archive`) is what lets a municipality check
 * a package years later with nothing but the package itself. The METS `sip.xml`
 * (`packages/archive/src/fgs.ts`) is what lets a Swedish e-archive ingest it
 * without knowing anything about Kommunsign. Shipping only the first was the
 * gap: it is a good format that is not FGS, and describing it as FGS would have
 * been a claim about interoperability nobody had tested.
 *
 * The export refuses rather than degrades. `assertArchivable` will not build a
 * package for a case whose documents have no verified PDF/A profile, whose
 * signatures have no validation report, or whose audit trail is missing —
 * because an archived record that misrepresents a legal act is worse than an
 * export that failed loudly.
 */

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UTF8 = new TextEncoder();

export interface ArchiveServices {
  /** The archive institution the package is delivered to. */
  readonly archivistName: string;
  readonly softwareName: string;
  readonly softwareVersion: string;
}

export function createArchiveServices(configuration: Readonly<Record<string, string>>): ArchiveServices {
  return {
    archivistName: configuration.ARCHIVE_ARCHIVIST_NAME?.trim() || '',
    softwareName: 'Kommunsign',
    softwareVersion: configuration.APP_VERSION?.trim() || '0.2.0',
  };
}

export function createArchiveJobHandlers(input: {
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
  readonly services: ArchiveServices;
}): Readonly<Record<'ARCHIVE_EXPORT', (job: DurableJob) => Promise<void>>> {
  return {
    ARCHIVE_EXPORT: (job) => handleArchiveExport(input.dataDatabase, input.infrastructure, input.services, job),
  };
}

interface CaseRow {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly external_reference: string | null;
  readonly decision_mode: 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
  readonly created_at: string | Date;
  readonly completed_at: string | Date | null;
  readonly legal_name: string | null;
}

interface PackageRow {
  readonly id: string;
  readonly status: string;
  readonly package_sha256: string | null;
}

export async function handleArchiveExport(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: ArchiveServices,
  job: DurableJob,
): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  // The archivist is the receiving institution's name and appears in the METS
  // header as a required agent. There is no sensible default: guessing it would
  // put a wrong organisation on a preservation record.
  if (!services.archivistName) throw permanent('ARCHIVE_ARCHIVIST_NAME_NOT_CONFIGURED');

  const signatureCaseId = uuidPayload(job.payload, 'signatureCaseId');
  const context = workerContext(job.tenantId);

  const loaded = await tenant(database, job.tenantId, async (tx) => {
    const caseResult = await tx.query<CaseRow>(
      `select c.id,c.status::text status,c.title,c.external_reference,c.decision_mode::text decision_mode,
              c.created_at,c.completed_at,o.legal_name
         from app.signature_cases c
         left join app.organizations o on o.tenant_id=c.tenant_id
        where c.tenant_id=$1 and c.id=$2`,
      [job.tenantId, signatureCaseId],
    );
    const packageResult = await tx.query<PackageRow>(
      `select id,status,package_sha256 from app.evidence_packages
        where tenant_id=$1 and signature_case_id=$2 and signer_id is null`,
      [job.tenantId, signatureCaseId],
    );
    const existing = await tx.query<{ readonly status: string }>(
      `select status from app.archive_exports
        where tenant_id=$1 and signature_case_id=$2 and archive_profile_version=$3`,
      [job.tenantId, signatureCaseId, ARCHIVE_PROFILE_VERSION],
    );
    return { signatureCase: caseResult.rows[0], evidencePackage: packageResult.rows[0], existing: existing.rows[0] };
  });

  if (loaded.existing?.status === 'completed') return;

  const signatureCase = requireRow(loaded.signatureCase, 'SIGNATURE_CASE_NOT_FOUND');
  // A running case would be frozen mid-flight and read as final. The state
  // machine puts a case into 'archiving' precisely so this job has a window.
  if (!['archiving', 'archived'].includes(signatureCase.status)) throw permanent('ARCHIVE_EXPORT_STATE_INVALID');

  const evidencePackage = requireRow(loaded.evidencePackage, 'EVIDENCE_PACKAGE_NOT_READY');
  if (evidencePackage.status !== 'ready') throw permanent('EVIDENCE_PACKAGE_NOT_READY');

  const exportId = await ensureExportRow(database, job.tenantId, signatureCaseId, evidencePackage.id);

  try {
    const archiveCase = await loadArchiveCase(database, job.tenantId, signatureCase, infrastructure);
    const files = await loadPackageFiles(database, infrastructure, context, job.tenantId, evidencePackage.id);

    const archive = await buildArchivePackage(archiveCase, files);
    const fgs = await buildFgsPackage(archive, agentsFor(services, archiveCase, signatureCase));

    // sip.xml lives at the package root, alongside the content/, metadata/ and
    // evidence/ directories the manifest already describes.
    const manifestBytes = UTF8.encode(canonicalJson(archive.manifest as unknown as CanonicalJsonValue));
    const packageFiles: EvidenceFile[] = [
      ...archive.files,
      { path: 'metadata/archive-manifest.json', bytes: manifestBytes, mediaType: 'application/json' },
      fgs.descriptor,
    ].sort((left, right) => left.path.localeCompare(right.path, 'en'));

    const zip = createEvidenceZip(packageFiles);
    const packageSha256 = await sha256Hex(zip);
    const packageKey = `${job.tenantId}/cases/${signatureCaseId}/archive/kommunsign-sip.zip`;
    const descriptorKey = `${job.tenantId}/cases/${signatureCaseId}/archive/${fgs.descriptor.path}`;

    await infrastructure.objectStorage.putObject(context, packageKey, zip, 'application/zip', true);
    await infrastructure.objectStorage.putObject(context, descriptorKey, fgs.descriptor.bytes, 'text/xml', true);

    await tenant(database, job.tenantId, async (tx) => {
      await tx.query(
        `update app.archive_exports
            set status='completed',completed_at=now(),
                package_object_key=$3,package_sha256=$4,
                descriptor_object_key=$5,descriptor_sha256=$6,
                manifest_sha256=$7,specification=$8,profile_uri=$9,
                schema_validated=$10,failure_code=null
          where tenant_id=$1 and id=$2`,
        [
          job.tenantId, exportId, packageKey, packageSha256, descriptorKey, fgs.descriptorSha256,
          archive.manifestSha256, fgs.specification, fgs.profileUri,
          // Never inferred from "we produced a package". Structural conformance
          // to the published profile and validation against the receiving
          // archive's schema set are different claims.
          FGS_CONFORMANCE_STATUS.receivingArchiveSchemaValidated,
        ],
      );
      await tx.query(
        `update app.signature_cases set status='archived',status_version=status_version+1,updated_at=now()
          where tenant_id=$1 and id=$2 and status='archiving'`,
        [job.tenantId, signatureCaseId],
      );
      await audit(tx, job.tenantId, 'BUSINESS', 'archive.exported', 'signature_case', signatureCaseId, {
        archiveExportId: exportId, packageSha256, descriptorSha256: fgs.descriptorSha256,
        manifestSha256: archive.manifestSha256, specification: fgs.specification,
        schemaValidated: FGS_CONFORMANCE_STATUS.receivingArchiveSchemaValidated,
        publishedSchemaValidated: FGS_CONFORMANCE_STATUS.publishedSchemaValidated, fileCount: packageFiles.length,
      });
      await outbox(tx, job.tenantId, 'signature_case', signatureCaseId, 'archive.exported', {
        archiveExportId: exportId, packageSha256, specification: fgs.specification,
      });
    });
  } catch (error) {
    // An archive package that cannot honestly describe the case is a refusal,
    // not a transient fault: retrying will produce the same incomplete record.
    if (error instanceof ArchiveError) {
      await tenant(database, job.tenantId, async (tx) => {
        await tx.query(
          `update app.archive_exports set status='failed',failure_code=$3 where tenant_id=$1 and id=$2`,
          [job.tenantId, exportId, safeCode(error.code)],
        );
        await audit(tx, job.tenantId, 'BUSINESS', 'archive.export_refused', 'signature_case', signatureCaseId, {
          archiveExportId: exportId, reason: error.code,
        });
      });
      throw permanent(`ARCHIVE_EXPORT_REFUSED_${error.code}`);
    }
    throw error;
  }
}

async function ensureExportRow(database: SqlDatabase, tenantId: string, signatureCaseId: string, evidencePackageId: string): Promise<string> {
  return tenant(database, tenantId, async (tx) => {
    await tx.query(
      `insert into app.archive_exports(tenant_id,signature_case_id,evidence_package_id,archive_profile_version,status)
       values($1,$2,$3,$4,'exporting')
       on conflict (tenant_id,signature_case_id,archive_profile_version) do nothing`,
      [tenantId, signatureCaseId, evidencePackageId, ARCHIVE_PROFILE_VERSION],
    );
    const result = await tx.query<{ readonly id: string; readonly status: string }>(
      `select id,status from app.archive_exports
        where tenant_id=$1 and signature_case_id=$2 and archive_profile_version=$3`,
      [tenantId, signatureCaseId, ARCHIVE_PROFILE_VERSION],
    );
    const row = requireRow(result.rows[0], 'ARCHIVE_EXPORT_NOT_CREATED');
    if (row.status === 'failed' || row.status === 'queued') {
      await tx.query(`update app.archive_exports set status='exporting' where tenant_id=$1 and id=$2`, [tenantId, row.id]);
    }
    return row.id;
  });
}

/**
 * Assembles the case as the archive domain sees it.
 *
 * Everything here is read from evidence tables rather than from case fields:
 * the PDF/A profile from the processor report, the PAdES level from the
 * signature artifact, the validation report from the validation run. A field
 * the case merely claims is not evidence, and `assertArchivable` exists to
 * reject exactly that.
 */
async function loadArchiveCase(
  database: SqlDatabase,
  tenantId: string,
  signatureCase: CaseRow,
  infrastructure: ProductionInfrastructure,
): Promise<ArchiveCase> {
  return tenant(database, tenantId, async (tx) => {
    const documents = await tx.query<{
      readonly document_id: string; readonly document_version_id: string; readonly display_name: string;
      readonly sha256: string | null; readonly byte_size: string | number; readonly pdf_profile: string | null;
    }>(
      `select d.id document_id, v.id document_version_id, d.display_name, v.sha256, v.byte_size, v.pdf_profile
         from app.documents d
         join app.document_versions v on v.tenant_id=d.tenant_id and v.document_id=d.id
        where d.tenant_id=$1 and d.signature_case_id=$2
          and v.status in ('locked','partially_signed','signed','validated','archived')
        order by d.created_at,d.id,v.version`,
      [tenantId, signatureCase.id],
    );

    const signatures = await tx.query<{
      readonly signer_id: string; readonly signed_at: string | Date; readonly format: string | null;
      readonly signed_document_sha256: string | null; readonly report_sha256: string | null;
      readonly timestamp_sha256: string | null;
    }>(
      `select attempt.signer_id, coalesce(attempt.completed_at, artifact.created_at) signed_at,
              artifact.format, artifact.signed_document_sha256,
              run.report_sha256, token.sha256 timestamp_sha256
         from app.signature_attempts attempt
         join app.signature_artifacts artifact on artifact.tenant_id=attempt.tenant_id and artifact.signature_attempt_id=attempt.id
         join app.signers s on s.tenant_id=attempt.tenant_id and s.id=attempt.signer_id
         left join app.validation_runs run on run.tenant_id=artifact.tenant_id and run.signature_artifact_id=artifact.id
              and run.indication='TOTAL_PASSED'
         left join app.timestamp_tokens token on token.tenant_id=artifact.tenant_id and token.signature_artifact_id=artifact.id
              and token.token_type='SIGNATURE'
        where attempt.tenant_id=$1 and s.signature_case_id=$2 and attempt.status='validated'
        order by attempt.signer_id, artifact.created_at`,
      [tenantId, signatureCase.id],
    );

    const identities = await tx.query<{
      readonly signer_id: string; readonly provider: string; readonly verified_at: string | Date;
      readonly verification_report_sha256: string; readonly verified_identifier_ciphertext: Uint8Array | null;
    }>(
      `select si.signer_id, it.provider::text provider, tia.verified_at, tia.verification_report_sha256,
              s.verified_identifier_ciphertext
         from app.signing_intents si
         join app.identity_transactions it on it.tenant_id=si.tenant_id and it.signing_intent_id=si.id
         join app.tic_identity_artifacts tia on tia.tenant_id=si.tenant_id and tia.identity_transaction_id=it.id
         join app.signers s on s.tenant_id=si.tenant_id and s.id=si.signer_id
        where si.tenant_id=$1 and si.signature_case_id=$2 and tia.verification_result='PASS'
        order by si.signer_id`,
      [tenantId, signatureCase.id],
    );

    // The audit trail is preserved as a hash over this case's event hashes in
    // sequence. The chain is already tamper-evident; this pins which prefix of
    // it the package was built from.
    const auditTrail = await tx.query<{ readonly digest: string | null }>(
      `select string_agg(event_hash, '' order by sequence) digest
         from audit.audit_events
        where tenant_id=$1 and resource_id=$2`,
      [tenantId, signatureCase.id],
    );

    const archiveDocuments: ArchiveDocument[] = [];
    for (const row of documents.rows) {
      archiveDocuments.push({
        documentId: row.document_id,
        documentVersionId: row.document_version_id,
        displayName: row.display_name,
        sha256: row.sha256 ?? '',
        byteSize: Number(row.byte_size),
        verifiedProfile: row.pdf_profile === 'PDF/A-2b' || row.pdf_profile === 'PDF/A-3b' ? row.pdf_profile : null,
        isSignedArtifact: false,
      });
    }

    const archiveSignatures: ArchiveSignatureEvidence[] = signatures.rows.map((row) => ({
      signerId: row.signer_id,
      signedAt: new Date(row.signed_at).toISOString(),
      padesLevel: row.format,
      signatureArtifactSha256: row.signed_document_sha256,
      validationReportSha256: row.report_sha256,
      timestampTokenSha256: row.timestamp_sha256,
    }));

    const archiveIdentities: ArchiveIdentityEvidence[] = [];
    for (const row of identities.rows) {
      // A full personal number must never reach a preservation package; the
      // archive keeps the record for decades and the masked form is enough to
      // tie a signature to a person alongside the identity evidence hash.
      const identifier = row.verified_identifier_ciphertext
        ? maskSwedishPersonalNumber(await infrastructure.sensitiveData.decryptText(row.verified_identifier_ciphertext, 'signer.verified_personal_number'))
        : 'okänd';
      archiveIdentities.push({
        signerId: row.signer_id,
        provider: row.provider,
        assuranceLevel: 'HIGH',
        maskedIdentifier: identifier,
        verifiedAt: new Date(row.verified_at).toISOString(),
        evidenceSha256: row.verification_report_sha256,
      });
    }

    const digest = auditTrail.rows[0]?.digest ?? null;
    return {
      tenantId,
      signatureCaseId: signatureCase.id,
      reference: signatureCase.external_reference ?? signatureCase.id,
      title: signatureCase.title,
      decisionMode: signatureCase.decision_mode,
      status: signatureCase.status,
      createdAt: new Date(signatureCase.created_at).toISOString(),
      closedAt: signatureCase.completed_at === null ? null : new Date(signatureCase.completed_at).toISOString(),
      documents: archiveDocuments,
      signatures: archiveSignatures,
      identities: archiveIdentities,
      auditTrailSha256: digest === null ? null : await sha256Hex(UTF8.encode(digest)),
    };
  });
}

/**
 * Reads the evidence package's files back out of object storage.
 *
 * Each byte is re-hashed against the recorded manifest hash rather than trusted.
 * The package is being sealed for decades here; a silent corruption in storage
 * would otherwise be preserved along with everything else.
 */
async function loadPackageFiles(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  context: TenantContext,
  tenantId: string,
  evidencePackageId: string,
): Promise<readonly EvidenceFile[]> {
  const rows = await tenant(database, tenantId, async (tx) => tx.query<{
    readonly path: string; readonly media_type: string; readonly sha256: string; readonly object_key: string;
  }>(
    `select path,media_type,sha256,object_key from app.evidence_package_files
      where tenant_id=$1 and evidence_package_id=$2 order by ordinal`,
    [tenantId, evidencePackageId],
  ).then((result) => result.rows));

  const files: EvidenceFile[] = [];
  for (const row of rows) {
    const artifact = await infrastructure.objectStorage.downloadObject(context, row.object_key, { contentType: row.media_type, fileName: row.path });
    const actual = await sha256Hex(artifact.bytes);
    if (actual !== row.sha256) throw permanent('ARCHIVE_SOURCE_FILE_HASH_MISMATCH');
    files.push({
      // The archive package namespaces by category; evidence-package paths that
      // already carry one are kept, the rest are filed as evidence.
      path: /^(content|metadata|evidence)\//.test(row.path) ? row.path : `evidence/${row.path.replace(/\//g, '_')}`,
      bytes: artifact.bytes,
      mediaType: row.media_type,
    });
  }
  return files;
}

function agentsFor(services: ArchiveServices, archiveCase: ArchiveCase, signatureCase: CaseRow): FgsAgents {
  const organisation = signatureCase.legal_name?.trim() || archiveCase.tenantId;
  return {
    archivist: services.archivistName,
    creator: organisation,
    submitter: organisation,
    producingSoftware: services.softwareName,
    producingSoftwareVersion: services.softwareVersion,
  };
}

async function tenant<T>(database: SqlDatabase, tenantId: string, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, workerContext(tenantId), 'worker', work);
}
function workerContext(tenantId: string): TenantContext {
  return { tenantId, subjectId: SYSTEM_ACTOR_ID, requestId: crypto.randomUUID(), authMethod: 'worker', source: 'deployment' };
}
async function audit(tx: SqlTransaction, tenantId: string, category: 'TECHNICAL' | 'BUSINESS', eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`select audit.append_event($1,$2,$3,'worker',$4,$5,$6,$7::jsonb,now())`, [tenantId, category, eventType, SYSTEM_ACTOR_ID, resourceType, resourceId, payload]);
}
async function outbox(tx: SqlTransaction, tenantId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  const serialized = JSON.stringify(payload);
  await tx.query(`insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId, aggregateType, aggregateId, eventType, payload, await sha256Hex(serialized)]);
}
function uuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  }
  return value;
}
function requireRow<T>(row: T | undefined, code: string): T { if (!row) throw permanent(code); return row; }
function permanent(code: string): Error { const error = new Error(safeCode(code)); error.name = 'PermanentWorkerError'; return error; }
function safeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'ARCHIVE_ERROR'; }
