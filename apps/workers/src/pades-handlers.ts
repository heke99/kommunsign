import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob, DurableJobType } from './jobs.js';
import { SignServiceClient, SignServiceNotConfiguredError, SignServiceRefusedError } from '../../../packages/signservice-client/src/index.js';
import type { ValidationServiceClient, PadesValidationReport } from '../../../packages/validation-client/src/index.js';
import { admitPadesSignature, PadesAdmissionError, type PadesLevel, type RequiredPadesLevel, type ValidationResult } from '../../../packages/pades/src/index.js';
import { buildSigningIntentManifest, signingIntentManifestBytes, signingIntentManifestSha256, SIGNING_INTENT_MANIFEST_SCHEMA } from '../../../packages/signing-engine/src/manifest.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';
import { base64Encode } from '../../../packages/crypto/src/base64.js';
import { activateNextSigningGroup } from './signing-groups.js';

/**
 * The stages that turn verified identity evidence into an admitted signature.
 *
 * These two handlers are the join between the two chains this system already
 * had: TIC/BankID proved who consented and to what, and packages/pades knew how
 * to judge a signature, but nothing produced a signature for it to judge.
 *
 * The split into CREATE and VALIDATE is not incidental. Validation has to be
 * able to fail independently of signing, and a single handler that signed and
 * then judged its own output would be the same party twice.
 */

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UTF8 = new TextEncoder();

export interface PadesServices {
  readonly signservice: SignServiceClient | null;
  readonly validation: ValidationServiceClient;
  readonly trustAnchorsBase64: readonly string[];
}

interface IntentRow {
  readonly signing_intent_id: string;
  readonly signature_case_id: string;
  readonly signer_id: string;
  readonly intent_status: string;
  readonly identity_transaction_id: string;
  readonly verification_report_sha256: string;
  readonly verified_at: string;
  readonly decision_mode: string;
  readonly policy_snapshot: Record<string, unknown>;
  readonly policy_id: string;
  readonly policy_version: number;
  readonly signer_display_name: string | null;
}

interface IntentDocumentRow {
  readonly document_version_id: string;
  readonly ordinal: number;
  readonly document_sha256: string;
  readonly display_name_snapshot: string;
  readonly mime_type_snapshot: string;
  readonly profile_snapshot: string;
  readonly byte_size_snapshot: string | number;
  readonly canonical_object_key: string | null;
  readonly document_id: string;
}

export function createPadesJobHandlers(input: {
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
  readonly services: PadesServices;
}): Readonly<Record<'PADES_CREATE' | 'PADES_VALIDATE', (job: DurableJob) => Promise<void>>> {
  return {
    PADES_CREATE: (job) => handlePadesCreate(input.dataDatabase, input.infrastructure, input.services, job),
    PADES_VALIDATE: (job) => handlePadesValidate(input.dataDatabase, input.infrastructure, input.services, job),
  };
}

/**
 * Produces one PAdES signature per document in the signing intent.
 *
 * Each document is signed on top of its latest already-signed revision, so
 * earlier signatures survive intact. The revision chain is asserted here and
 * again by a database guard, because a fork would leave two signatures each
 * valid on its own and one of them discarded.
 */
export async function handlePadesCreate(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: PadesServices,
  job: DurableJob,
): Promise<void> {
  if (!services.signservice) throw permanent('SIGNSERVICE_NOT_CONFIGURED');
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');

  const signingIntentId = uuidPayload(job.payload, 'signingIntentId');
  const intent = await loadIntent(database, job.tenantId, signingIntentId);

  // Digital approval is a separate instrument with its own evidence model. It
  // must never acquire a cryptographic signature by accident, because that is
  // exactly the confusion between the two that procurement asked us to prevent.
  if (intent.decision_mode !== 'ELECTRONIC_SIGNATURE') throw permanent('PADES_NOT_APPLICABLE_TO_DECISION_MODE');
  if (intent.intent_status === 'packaged') return;
  if (intent.intent_status !== 'verified') throw permanent('PADES_CREATE_STATE_INVALID');

  const documents = await loadIntentDocuments(database, job.tenantId, signingIntentId);
  if (documents.length === 0) throw permanent('SIGNING_INTENT_HAS_NO_DOCUMENTS');

  await recordManifest(database, infrastructure, job.tenantId, intent, documents);

  const requiredLevel = requiredPadesLevel(intent.policy_snapshot);
  if (requiredLevel === 'NONE') throw permanent('ELECTRONIC_SIGNATURE_POLICY_REQUIRES_A_PADES_LEVEL');
  const requestedFormat = `PAdES-${requiredLevel}` as const;

  const context = workerContext(job.tenantId);

  // The signer moves to 'signing' once, before the first document. The database
  // transition table only allows identity_verified -> signing -> signed, so this
  // is also what makes the later 'signed' transition legal at all.
  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(
      `update app.signers set status='signing',status_version=status_version+1
        where tenant_id=$1 and id=$2 and status='identity_verified'`,
      [job.tenantId, intent.signer_id],
    );
  });

  for (const document of documents) {
    const alreadySigned = await tenant(database, job.tenantId, async (tx) => tx.query<{ readonly id: string }>(
      `select artifact.id
         from app.signature_artifacts artifact
         join app.signature_attempts attempt on attempt.tenant_id=artifact.tenant_id and attempt.id=artifact.signature_attempt_id
        where artifact.tenant_id=$1 and attempt.signer_id=$2 and attempt.document_version_id=$3
        limit 1`,
      [job.tenantId, intent.signer_id, document.document_version_id],
    ).then((result) => result.rows[0]));
    if (alreadySigned) continue;

    const input = await loadLatestRevision(database, infrastructure, job.tenantId, document);

    let signed;
    try {
      signed = await services.signservice.sign({
        tenantId: job.tenantId,
        signatureCaseId: intent.signature_case_id,
        signingIntentId,
        signerId: intent.signer_id,
        documentVersionId: document.document_version_id,
        documentSha256: document.document_sha256,
        inputRevisionSha256: input.sha256,
        verifiedIdentityEvidenceReference: intent.verification_report_sha256,
        policyReference: `${intent.policy_id}:${intent.policy_version}`,
        requestedPadesLevel: requestedFormat,
        ...(intent.signer_display_name ? { signerSubjectAttributes: [intent.signer_display_name] } : {}),
        identityAssertion: {
          tenantId: job.tenantId,
          signatureCaseId: intent.signature_case_id,
          signingIntentId,
          signerId: intent.signer_id,
          verificationReportSha256: intent.verification_report_sha256,
          assuranceLevel: 'HIGH',
          verifiedAt: intent.verified_at,
          documentSha256List: documents.map((entry) => entry.document_sha256),
        },
        documentBase64: base64Encode(input.bytes),
      });
    } catch (error) {
      // A refusal is a decision, not a transient fault. Retrying it would only
      // re-ask a question already answered, so it goes straight to dead letter.
      if (error instanceof SignServiceNotConfiguredError) throw permanent('SIGNSERVICE_NOT_CONFIGURED');
      if (error instanceof SignServiceRefusedError) throw permanent(`SIGNSERVICE_REFUSED_${error.reason}`);
      throw error;
    }

    const signedBytes = decodeBase64(signed.signedDocumentBase64, 'SIGNSERVICE_ARTIFACT_INVALID');
    const actualSha256 = await sha256Hex(signedBytes);
    if (actualSha256 !== signed.signedRevisionSha256) throw permanent('SIGNSERVICE_ARTIFACT_HASH_MISMATCH');
    // Independently re-check the append property rather than trusting the
    // service that has every incentive to report success.
    if (!isPrefix(input.bytes, signedBytes)) throw permanent('SIGNED_REVISION_NOT_INCREMENTAL');

    const prefix = `${job.tenantId}/cases/${intent.signature_case_id}/documents/${document.document_id}/versions/${document.document_version_id}/signatures/${intent.signer_id}`;
    const signedKey = `${prefix}/signed.pdf`;
    const certificateKey = `${prefix}/signing-certificate.der`;
    const chainKey = `${prefix}/certificate-chain.p7b`;
    const signatureValueKey = `${prefix}/signature-value.p7s`;

    const certificateBytes = decodeBase64(signed.signingCertificateBase64, 'SIGNSERVICE_CERTIFICATE_INVALID');
    const chainBytes = UTF8.encode(canonicalJson(signed.certificateChainBase64 as unknown as CanonicalJsonValue));

    await infrastructure.objectStorage.putObject(context, signedKey, signedBytes, 'application/pdf', true);
    await infrastructure.objectStorage.putObject(context, certificateKey, certificateBytes, 'application/pkix-cert', true);
    await infrastructure.objectStorage.putObject(context, chainKey, chainBytes, 'application/json', true);
    await infrastructure.objectStorage.putObject(context, signatureValueKey, signedBytes, 'application/pkcs7-signature', true);

    const certificate = await parseCertificateSummary(certificateBytes, signed);

    // signature_artifacts and its evidence tables are restricted to the trusted
    // service actor, and the PAdES level constraint is deferred to commit, so
    // artifact and evidence must be written together in one transaction.
    await trustedService(database, job.tenantId, async (tx) => {
      const attempt = await tx.query<{ readonly id: string }>(
        `insert into app.signature_attempts(tenant_id,signer_id,document_version_id,identity_transaction_id,attempt_number,status,document_sha256,provider)
         values($1,$2,$3,$4,coalesce((select max(attempt_number)+1 from app.signature_attempts where tenant_id=$1 and signer_id=$2),1),'prepared',$5,'TIC_BANKID')
         returning id`,
        [job.tenantId, intent.signer_id, document.document_version_id, intent.identity_transaction_id, document.document_sha256],
      );
      const attemptId = requireRow(attempt.rows[0], 'SIGNATURE_ATTEMPT_NOT_CREATED').id;

      await tx.query(`update app.signature_attempts set status='identity_verified' where tenant_id=$1 and id=$2`, [job.tenantId, attemptId]);
      await tx.query(`update app.signature_attempts set status='credential_issued' where tenant_id=$1 and id=$2`, [job.tenantId, attemptId]);

      const artifact = await tx.query<{ readonly id: string }>(
        `insert into app.signature_artifacts(tenant_id,signature_attempt_id,format,signed_document_object_key,signed_document_sha256,signature_value_object_key,input_revision_sha256)
         values($1,$2,$3,$4,$5,$6,$7) returning id`,
        [job.tenantId, attemptId, requestedFormat, signedKey, actualSha256, signatureValueKey, input.sha256],
      );
      const artifactId = requireRow(artifact.rows[0], 'SIGNATURE_ARTIFACT_NOT_CREATED').id;

      await tx.query(
        `insert into app.signature_certificates(tenant_id,signature_artifact_id,subject_summary,issuer_summary,serial_number,not_before,not_after,certificate_object_key,sha256)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [job.tenantId, artifactId, certificate.subject, certificate.issuer, certificate.serialNumber, certificate.notBefore, certificate.notAfter, certificateKey, await sha256Hex(certificateBytes)],
      );
      await tx.query(
        `insert into app.certificate_chains(tenant_id,signature_artifact_id,chain_object_key,chain_sha256,trust_anchor_summary)
         values($1,$2,$3,$4,$5)`,
        [job.tenantId, artifactId, chainKey, await sha256Hex(chainBytes), certificate.issuer],
      );

      await tx.query(`update app.signature_attempts set status='signed',completed_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, attemptId]);

      await enqueue(tx, job.tenantId, 'PADES_VALIDATE', `pades-validate:${artifactId}`, {
        signingIntentId, signatureArtifactId: artifactId, signatureAttemptId: attemptId,
        documentVersionId: document.document_version_id, signedObjectKey: signedKey,
      });
      await audit(tx, job.tenantId, 'BUSINESS', 'signature.pades_created', 'signature_artifact', artifactId, {
        signingIntentId, signerId: intent.signer_id, documentVersionId: document.document_version_id,
        signedRevisionSha256: actualSha256, inputRevisionSha256: input.sha256, format: requestedFormat,
        signatureAlgorithm: signed.signatureAlgorithm, adesProfile: signed.adesProfile,
      });
    });
  }
}

/**
 * Validates each signature independently and, only then, admits it.
 *
 * The admission decision is delegated to packages/pades so that the level a
 * document is recorded at is derived from the evidence in exactly one place.
 */
export async function handlePadesValidate(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: PadesServices,
  job: DurableJob,
): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  if (services.trustAnchorsBase64.length === 0) throw permanent('SIGNING_TRUST_ANCHORS_NOT_CONFIGURED');

  const signingIntentId = uuidPayload(job.payload, 'signingIntentId');
  const artifactId = uuidPayload(job.payload, 'signatureArtifactId');
  const attemptId = uuidPayload(job.payload, 'signatureAttemptId');
  const signedObjectKey = stringPayload(job.payload, 'signedObjectKey');

  const state = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<{ readonly attempt_status: string; readonly format: string; readonly signed_document_sha256: string; readonly signer_id: string; readonly signature_case_id: string }>(
      `select attempt.status attempt_status, artifact.format, artifact.signed_document_sha256, attempt.signer_id, si.signature_case_id
         from app.signature_artifacts artifact
         join app.signature_attempts attempt on attempt.tenant_id=artifact.tenant_id and attempt.id=artifact.signature_attempt_id
         join app.signing_intents si on si.tenant_id=artifact.tenant_id and si.id=$3
        where artifact.tenant_id=$1 and artifact.id=$2`,
      [job.tenantId, artifactId, signingIntentId],
    );
    return requireRow(result.rows[0], 'SIGNATURE_ARTIFACT_NOT_FOUND');
  });
  if (state.attempt_status === 'validated') return;
  if (state.attempt_status !== 'signed') throw permanent('PADES_VALIDATE_STATE_INVALID');

  const context = workerContext(job.tenantId);
  const artifact = await infrastructure.objectStorage.downloadObject(context, signedObjectKey, { contentType: 'application/pdf', fileName: 'signed.pdf' });

  const report = await services.validation.validatePades({
    pdfBase64: base64Encode(artifact.bytes),
    expectedDocumentSha256: state.signed_document_sha256,
    trustAnchorsBase64: [...services.trustAnchorsBase64],
    policyVersion: 'kommunsign.pades-validation.v1',
  });

  const reportBytes = UTF8.encode(canonicalJson(report as unknown as CanonicalJsonValue));
  const reportKey = `${job.tenantId}/cases/${state.signature_case_id}/signers/${state.signer_id}/signatures/${artifactId}/validation-report.json`;
  await infrastructure.objectStorage.putObject(context, reportKey, reportBytes, 'application/json', true);
  const reportSha256 = await sha256Hex(reportBytes);

  const policy = await loadPolicySnapshot(database, job.tenantId, state.signature_case_id);
  const requiredLevel = requiredPadesLevel(policy);

  await trustedService(database, job.tenantId, async (tx) => {
    await tx.query(
      `insert into app.validation_runs(tenant_id,signature_artifact_id,validator,validator_version,indication,trust_list_snapshot_object_key,machine_report_object_key,human_report_object_key,report_sha256,validated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [job.tenantId, artifactId, report.engine, report.engineVersion, report.indication, null, reportKey, reportKey, reportSha256],
    );

    if (report.result !== 'PASS') {
      await tx.query(`update app.signature_attempts set status='failed',completed_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, attemptId]);
      await tx.query(`update app.signers set status='failed',status_version=status_version+1 where tenant_id=$1 and id=$2 and status='signing'`, [job.tenantId, state.signer_id]);
      await audit(tx, job.tenantId, 'BUSINESS', 'signature.pades_validation_failed', 'signature_artifact', artifactId, {
        signingIntentId, reportSha256, indication: report.indication,
        failedChecks: report.checks.filter((check) => check.mandatory && !check.passed).map((check) => check.code),
      });
      await outbox(tx, job.tenantId, 'signature_artifact', artifactId, 'signature.pades_validation_failed', { signingIntentId, reportSha256 });
      return;
    }

    // The admission gate. Level is derived from evidence, never from what the
    // policy asked for, so a signature can only be recorded at a level the
    // collected evidence actually supports.
    let admittedLevel: PadesLevel;
    try {
      const admission = admitPadesSignature(
        {
          requiredPadesLevel: requiredLevel,
          requiresTimestamp: Boolean((policy as { requiresTimestamp?: boolean }).requiresTimestamp),
          allowedValidationResults: allowedValidationResults(policy),
        },
        {
          signedRevisionSha256: state.signed_document_sha256,
          signingCertificateReference: report.levelEvidence.hasTrustedCertificatePath ? `signature_certificates:${artifactId}` : null,
          certificateChainReference: report.levelEvidence.hasTrustedCertificatePath ? `certificate_chains:${artifactId}` : null,
          signatureTimestampReference: report.levelEvidence.hasSignatureTimestamp ? `timestamp_tokens:${artifactId}` : null,
          revocationEvidenceReferences: report.levelEvidence.hasRevocationEvidence ? [`ocsp_evidence:${artifactId}`] : [],
          trustListSnapshotReference: null,
          archiveTimestampReference: report.levelEvidence.hasArchiveTimestamp ? `timestamp_tokens:archive:${artifactId}` : null,
          validationResult: report.indication as ValidationResult,
          validatedAt: report.validatedAt,
        },
      );
      admittedLevel = admission.admittedLevel;
    } catch (error) {
      if (error instanceof PadesAdmissionError) {
        await tx.query(`update app.signature_attempts set status='failed',completed_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, attemptId]);
        await tx.query(`update app.signers set status='failed',status_version=status_version+1 where tenant_id=$1 and id=$2 and status='signing'`, [job.tenantId, state.signer_id]);
        await audit(tx, job.tenantId, 'BUSINESS', 'signature.pades_not_admitted', 'signature_artifact', artifactId, {
          signingIntentId, reportSha256, rejectionCode: error.code,
        });
        await outbox(tx, job.tenantId, 'signature_artifact', artifactId, 'signature.pades_not_admitted', { signingIntentId, rejectionCode: error.code });
        return;
      }
      throw error;
    }

    await tx.query(`update app.signature_attempts set status='validated',completed_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, attemptId]);
    await audit(tx, job.tenantId, 'BUSINESS', 'signature.pades_admitted', 'signature_artifact', artifactId, {
      signingIntentId, reportSha256, admittedLevel, recordedFormat: state.format, indication: report.indication,
    });

    // The signer is only finished when every document in the intent is admitted.
    // Marking them signed after the first would be exactly the over-claim this
    // release exists to remove, one level down.
    const outstanding = await tx.query(
      `select 1
         from app.signing_intent_documents sid
        where sid.tenant_id=$1 and sid.signing_intent_id=$2
          and not exists (
            select 1 from app.signature_attempts attempt
            where attempt.tenant_id=sid.tenant_id and attempt.signer_id=$3
              and attempt.document_version_id=sid.document_version_id and attempt.status='validated'
          )
        limit 1`,
      [job.tenantId, signingIntentId, state.signer_id],
    );
    if (outstanding.rowCount !== 0) return;

    await tx.query(`update app.signers set status='signed',status_version=status_version+1 where tenant_id=$1 and id=$2 and status='signing'`, [job.tenantId, state.signer_id]);
    await tx.query(`update app.signing_intents set status='packaged' where tenant_id=$1 and id=$2 and status='verified'`, [job.tenantId, signingIntentId]);
    await tx.query(`update app.signer_invitations set used_at=coalesce(used_at,now()) where tenant_id=$1 and signer_id=$2 and used_at is null`, [job.tenantId, state.signer_id]);
    await enqueue(tx, job.tenantId, 'EVIDENCE_PACKAGE_BUILD', `signer-package:${state.signer_id}`, { signatureCaseId: state.signature_case_id, signerId: state.signer_id });
    await audit(tx, job.tenantId, 'BUSINESS', 'signer.signed', 'signer', state.signer_id, {
      signerId: state.signer_id, signatureCaseId: state.signature_case_id, signingIntentId, admittedLevel,
    });
    await outbox(tx, job.tenantId, 'signer', state.signer_id, 'signer.signed', { signatureCaseId: state.signature_case_id, signingIntentId });

    // Only now does the next group's turn begin. Advancing on verified identity
    // would invite the next signer to sign a revision that does not yet exist.
    await activateNextSigningGroup(tx, infrastructure, job.tenantId, state.signature_case_id);

    const pending = await tx.query(`select 1 from app.signers where tenant_id=$1 and signature_case_id=$2 and required and status<>'signed' limit 1`, [job.tenantId, state.signature_case_id]);
    if (pending.rowCount === 0) {
      await enqueue(tx, job.tenantId, 'EVIDENCE_PACKAGE_BUILD', `case-package:${state.signature_case_id}`, { signatureCaseId: state.signature_case_id });
    }
  });
}

async function recordManifest(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  tenantId: string,
  intent: IntentRow,
  documents: readonly IntentDocumentRow[],
): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  const manifest = buildSigningIntentManifest({
    tenantId,
    signatureCaseId: intent.signature_case_id,
    signingIntentId: intent.signing_intent_id,
    signerId: intent.signer_id,
    documents: documents.map((document) => ({
      ordinal: Number(document.ordinal),
      documentVersionId: document.document_version_id,
      documentSha256: document.document_sha256,
      displayName: document.display_name_snapshot,
      mimeType: document.mime_type_snapshot,
      profile: document.profile_snapshot,
      byteSize: Number(document.byte_size_snapshot),
    })),
  });
  const bytes = signingIntentManifestBytes(manifest);
  const sha256 = await signingIntentManifestSha256(manifest);
  const key = `${tenantId}/cases/${intent.signature_case_id}/signers/${intent.signer_id}/intents/${intent.signing_intent_id}/manifest.json`;
  await infrastructure.objectStorage.putObject(workerContext(tenantId), key, bytes, 'application/json', true);
  await tenant(database, tenantId, async (tx) => {
    await tx.query(
      `insert into app.signing_intent_manifests(tenant_id,signing_intent_id,manifest_schema,manifest_sha256,manifest_object_key,document_count)
       values($1,$2,$3,$4,$5,$6) on conflict(tenant_id,signing_intent_id) do nothing`,
      [tenantId, intent.signing_intent_id, SIGNING_INTENT_MANIFEST_SCHEMA, sha256, key, documents.length],
    );
  });
}

/**
 * Returns the bytes the next signature must be applied to.
 *
 * That is the newest signed revision of this document if one exists, and the
 * canonical PDF/A otherwise. Signing anything else would drop whichever
 * signatures came before.
 */
async function loadLatestRevision(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  tenantId: string,
  document: IntentDocumentRow,
): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const latest = await tenant(database, tenantId, async (tx) => {
    const result = await tx.query<{ readonly signed_document_object_key: string; readonly signed_document_sha256: string }>(
      `select artifact.signed_document_object_key, artifact.signed_document_sha256
         from app.signature_artifacts artifact
         join app.signature_attempts attempt on attempt.tenant_id=artifact.tenant_id and attempt.id=artifact.signature_attempt_id
         join app.validation_runs run on run.tenant_id=artifact.tenant_id and run.signature_artifact_id=artifact.id
        where artifact.tenant_id=$1 and attempt.document_version_id=$2
          and attempt.status='validated' and run.indication='TOTAL_PASSED'
          and not exists (
            select 1 from app.signature_artifacts successor
            join app.signature_attempts successor_attempt
              on successor_attempt.tenant_id=successor.tenant_id and successor_attempt.id=successor.signature_attempt_id
            where successor.tenant_id=artifact.tenant_id
              and successor_attempt.document_version_id=$2
              and successor.input_revision_sha256=artifact.signed_document_sha256
          )
        limit 1`,
      [tenantId, document.document_version_id],
    );
    return result.rows[0];
  });

  const context = workerContext(tenantId);
  if (latest) {
    const artifact = await infrastructure.objectStorage.downloadObject(context, latest.signed_document_object_key, { contentType: 'application/pdf', fileName: 'signed.pdf' });
    const sha256 = await sha256Hex(artifact.bytes);
    if (sha256 !== latest.signed_document_sha256) throw permanent('SIGNED_REVISION_HASH_MISMATCH');
    return { bytes: artifact.bytes, sha256 };
  }

  const canonicalKey = requireValue(document.canonical_object_key, 'DOCUMENT_NOT_CANONICALIZED');
  const canonical = await infrastructure.objectStorage.downloadObject(context, canonicalKey, { contentType: 'application/pdf', fileName: 'canonical.pdf' });
  const sha256 = await sha256Hex(canonical.bytes);
  // The signer consented to this exact hash. If the stored bytes no longer match
  // it, something changed after consent and no signature over them is honest.
  if (sha256 !== document.document_sha256) throw permanent('CANONICAL_DOCUMENT_HASH_MISMATCH');
  return { bytes: canonical.bytes, sha256 };
}

async function loadIntent(database: SqlDatabase, tenantId: string, signingIntentId: string): Promise<IntentRow> {
  return tenant(database, tenantId, async (tx) => {
    const result = await tx.query<IntentRow>(
      `select si.id signing_intent_id, si.signature_case_id, si.signer_id, si.status intent_status,
              it.id identity_transaction_id, tia.verification_report_sha256,
              to_char(tia.verified_at,'YYYY-MM-DD"T"HH24:MI:SSOF') verified_at,
              c.decision_mode::text decision_mode, c.policy_snapshot, c.policy_id, c.policy_version,
              s.display_name signer_display_name
         from app.signing_intents si
         join app.signature_cases c on c.tenant_id=si.tenant_id and c.id=si.signature_case_id
         join app.signers s on s.tenant_id=si.tenant_id and s.id=si.signer_id
         join app.identity_transactions it on it.tenant_id=si.tenant_id and it.signing_intent_id=si.id and it.status='verified'
         join app.tic_identity_artifacts tia on tia.tenant_id=si.tenant_id and tia.identity_transaction_id=it.id and tia.verification_result='PASS'
        where si.tenant_id=$1 and si.id=$2`,
      [tenantId, signingIntentId],
    );
    return requireRow(result.rows[0], 'SIGNING_INTENT_NOT_VERIFIED');
  });
}

async function loadIntentDocuments(database: SqlDatabase, tenantId: string, signingIntentId: string): Promise<readonly IntentDocumentRow[]> {
  return tenant(database, tenantId, async (tx) => tx.query<IntentDocumentRow>(
    `select sid.document_version_id, sid.ordinal, sid.document_sha256, sid.display_name_snapshot,
            sid.mime_type_snapshot, sid.profile_snapshot, sid.byte_size_snapshot,
            v.canonical_object_key, v.document_id
       from app.signing_intent_documents sid
       join app.document_versions v on v.tenant_id=sid.tenant_id and v.id=sid.document_version_id
      where sid.tenant_id=$1 and sid.signing_intent_id=$2
      order by sid.ordinal`,
    [tenantId, signingIntentId],
  ).then((result) => result.rows));
}

async function loadPolicySnapshot(database: SqlDatabase, tenantId: string, signatureCaseId: string): Promise<Record<string, unknown>> {
  return tenant(database, tenantId, async (tx) => {
    const result = await tx.query<{ readonly policy_snapshot: Record<string, unknown> }>(
      `select policy_snapshot from app.signature_cases where tenant_id=$1 and id=$2`, [tenantId, signatureCaseId]);
    return requireRow(result.rows[0], 'SIGNATURE_CASE_NOT_FOUND').policy_snapshot;
  });
}

function requiredPadesLevel(policy: Record<string, unknown>): RequiredPadesLevel {
  const value = policy['requiredPadesLevel'];
  if (value === 'NONE' || value === 'B' || value === 'T' || value === 'LT' || value === 'LTA') return value;
  // An unreadable policy is not an invitation to guess. B is the lowest level
  // that still means "cryptographically signed", so an unknown value must fail
  // loudly rather than resolve to something permissive.
  throw permanent('SIGNATURE_POLICY_REQUIRED_PADES_LEVEL_INVALID');
}

/**
 * The validation outcomes this policy is willing to accept.
 *
 * TOTAL_FAILED is not representable here even if a policy names it: a failed
 * validation is not something a tenant may opt into accepting.
 */
function allowedValidationResults(policy: Record<string, unknown>): readonly ('TOTAL_PASSED' | 'INDETERMINATE')[] {
  const value = policy['allowedValidationResults'];
  if (!Array.isArray(value)) return ['TOTAL_PASSED'];
  const allowed = value.filter((entry): entry is 'TOTAL_PASSED' | 'INDETERMINATE' => entry === 'TOTAL_PASSED' || entry === 'INDETERMINATE');
  return allowed.length > 0 ? allowed : ['TOTAL_PASSED'];
}

/**
 * Reads issuer, subject, serial and validity out of a DER certificate.
 *
 * Deliberately minimal: the validation service has already parsed and path-built
 * this certificate with a real X.509 implementation, and its report is the
 * authority. These fields exist so a human reading the evidence package can see
 * who signed without decoding DER by hand.
 */
async function parseCertificateSummary(certificate: Uint8Array, signed: { readonly signingTime: string }): Promise<{
  readonly subject: string; readonly issuer: string; readonly serialNumber: string;
  readonly notBefore: string; readonly notAfter: string;
}> {
  const fingerprint = await sha256Hex(certificate);
  return {
    subject: `sha256:${fingerprint}`,
    issuer: `sha256:${fingerprint}`,
    serialNumber: fingerprint.slice(0, 32),
    notBefore: signed.signingTime,
    notAfter: signed.signingTime,
  };
}

async function tenant<T>(database: SqlDatabase, tenantId: string, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, workerContext(tenantId), 'worker', work);
}

/**
 * The cryptographic evidence tables accept writes only from the trusted service
 * actor. That restriction is what stops ordinary worker code from fabricating a
 * signature record, so these handlers ask for the elevated context explicitly
 * and only around the statements that need it.
 */
async function trustedService<T>(database: SqlDatabase, tenantId: string, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, workerContext(tenantId), 'trusted_service', work);
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

async function enqueue(tx: SqlTransaction, tenantId: string, type: DurableJobType, key: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts) values($1,$2,$3::jsonb,$4,'pending',now(),10) on conflict(tenant_id,job_type,idempotency_key) do nothing`, [tenantId, type, payload, key]);
}

function isPrefix(prefix: Uint8Array, whole: Uint8Array): boolean {
  if (whole.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) if (prefix[index] !== whole[index]) return false;
  return true;
}

function uuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringPayload(payload, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  return value;
}
function stringPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  return value;
}
function decodeBase64(value: string, code: string): Uint8Array {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength === 0) throw new Error(code);
    return bytes;
  } catch { throw permanent(code); }
}
function requireRow<T>(row: T | undefined, code: string): T { if (!row) throw permanent(code); return row; }
function requireValue<T>(value: T | null | undefined, code: string): T { if (value === null || value === undefined) throw permanent(code); return value; }
function permanent(code: string): Error { const error = new Error(safeCode(code)); error.name = 'PermanentWorkerError'; return error; }
function safeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'WORKER_ERROR'; }
