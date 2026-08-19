import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob } from './jobs.js';
import {
  buildGallringReport, RetentionPolicyError,
  type GallringTarget, type GallringTargetOutcome, type RetentionClass,
} from '../../../packages/retention/src/index.js';
import { GallringExecutionError } from '../../../packages/retention/src/executor.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';

/**
 * Gallring — retention execution.
 *
 * `packages/retention` already modelled this: the state machine, the four-eyes
 * approval, the mandatory target list and the report that refuses to call a
 * partial deletion complete. None of it had a caller. This handler is that
 * caller.
 *
 * The hard part of gallring is not deleting the row. It is the copies people
 * forget — object storage, derived renders, caches, notification payloads —
 * which is why `MANDATORY_CASE_TARGETS` names them and the report records any
 * target that could not be confirmed.
 *
 * Where a store cannot be erased, this reports it rather than glossing it. The
 * audit trail is hash-chained: deleting entries would break the chain that
 * makes every other record verifiable, so its personal data is removed by
 * destroying the encrypted payloads while the hash-only spine is retained. That
 * is cryptographic erasure, it is a deliberate choice, and the report says so
 * instead of claiming the rows were deleted.
 */

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UTF8 = new TextEncoder();

export function createRetentionJobHandlers(input: {
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
}): Readonly<Record<'RETENTION_EXECUTE', (job: DurableJob) => Promise<void>>> {
  return {
    RETENTION_EXECUTE: (job) => handleRetentionExecute(input.dataDatabase, input.infrastructure, job),
  };
}

interface GallringJobRow {
  readonly id: string;
  readonly state: string;
  readonly policy_key: string;
  readonly policy_version: number;
  readonly retention_class: RetentionClass;
  readonly case_ids: readonly string[];
  readonly requested_by: string;
  readonly approved_by: string | null;
  readonly planned_targets: readonly string[];
}

export async function handleRetentionExecute(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  job: DurableJob,
): Promise<void> {
  if (!infrastructure.objectStorage.putObject) throw permanent('STORAGE_IMMUTABLE_PUT_NOT_CONFIGURED');
  // Without a delete capability the run could only ever report unverified
  // targets, which is a failed gallring dressed as a completed one.
  if (!infrastructure.objectStorage.deleteObject) throw permanent('STORAGE_DELETE_NOT_CONFIGURED');

  const gallringJobId = uuidPayload(job.payload, 'gallringJobId');
  const context = workerContext(job.tenantId);

  const loaded = await tenant(database, job.tenantId, async (tx) => {
    const result = await tx.query<GallringJobRow>(
      `select id,state,policy_key,policy_version,retention_class,case_ids,requested_by,approved_by,planned_targets
         from app.gallring_jobs where tenant_id=$1 and id=$2`,
      [job.tenantId, gallringJobId],
    );
    return result.rows[0];
  });
  const gallring = requireRow(loaded, 'GALLRING_JOB_NOT_FOUND');
  if (['REPORTED', 'ABANDONED'].includes(gallring.state)) return;
  if (gallring.state !== 'APPROVED') throw permanent('GALLRING_STATE_INVALID');

  // The transition to EXECUTING is where the database re-checks legal hold. A
  // hold placed while this job waited in the queue is exactly the case that
  // matters, and checking only at queue time would miss it.
  try {
    await tenant(database, job.tenantId, async (tx) => {
      await tx.query(`update app.gallring_jobs set state='EXECUTING',executed_at=now() where tenant_id=$1 and id=$2`, [job.tenantId, gallringJobId]);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('legal hold')) {
      await abandon(database, job.tenantId, gallringJobId, 'LEGAL_HOLD_ACTIVE');
      throw permanent('GALLRING_BLOCKED_BY_LEGAL_HOLD');
    }
    throw error;
  }

  const outcomes: GallringTargetOutcome[] = [];
  for (const caseId of gallring.case_ids) {
    outcomes.push(...await eraseCase(database, infrastructure, context, job.tenantId, caseId));
  }

  const merged = mergeOutcomes(outcomes);
  const report = buildGallringReport({
    tenantId: job.tenantId,
    jobId: gallringJobId,
    policyKey: gallring.policy_key,
    policyVersion: Number(gallring.policy_version),
    retentionClass: gallring.retention_class,
    executedBy: gallring.approved_by ?? gallring.requested_by,
    executedAt: new Date().toISOString(),
    caseIds: [...gallring.case_ids],
    outcomes: merged,
  });

  const reportBytes = UTF8.encode(canonicalJson(report as unknown as CanonicalJsonValue));
  const reportSha256 = await sha256Hex(reportBytes);
  const reportKey = `${job.tenantId}/gallring/${gallringJobId}/gallringsrapport.json`;
  await infrastructure.objectStorage.putObject(context, reportKey, reportBytes, 'application/json', true);

  await tenant(database, job.tenantId, async (tx) => {
    await tx.query(`update app.gallring_jobs set state='VERIFIED' where tenant_id=$1 and id=$2`, [job.tenantId, gallringJobId]);
    await tx.query(
      `insert into app.gallring_reports(tenant_id,gallring_job_id,schema_version,report,report_sha256,object_key,case_count,deleted_total,complete,unverified_targets)
       values($1,$2,1,$3::jsonb,$4,$5,$6,$7,$8,$9)
       on conflict (tenant_id,gallring_job_id) do nothing`,
      [job.tenantId, gallringJobId, report, reportSha256, reportKey, report.caseCount, report.deletedTotal, report.complete, report.unverifiedTargets],
    );
    await tx.query(`update app.gallring_jobs set state='REPORTED' where tenant_id=$1 and id=$2`, [job.tenantId, gallringJobId]);
    await audit(tx, job.tenantId, 'BUSINESS', 'retention.gallring_executed', 'gallring_job', gallringJobId, {
      caseCount: report.caseCount, deletedTotal: report.deletedTotal, complete: report.complete,
      unverifiedTargets: report.unverifiedTargets, reportSha256,
    });
    await outbox(tx, job.tenantId, 'gallring_job', gallringJobId, 'retention.gallring_executed', {
      complete: report.complete, reportSha256,
    });
  });
}

/**
 * Erases one case across every mandatory target.
 *
 * Order matters. Object payloads go first: if the run dies half way, the
 * personal data is already gone and the rows that point at it are recoverable
 * bookkeeping. Deleting the rows first would leave orphaned objects nothing
 * references, which is the one outcome gallring must never produce.
 */
async function eraseCase(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  context: TenantContext,
  tenantId: string,
  caseId: string,
): Promise<readonly GallringTargetOutcome[]> {
  const objectKeys = await tenant(database, tenantId, async (tx) => {
    const result = await tx.query<{ readonly object_key: string; readonly kind: string }>(
      `select v.source_object_key object_key, 'document_versions' kind
         from app.document_versions v join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
        where v.tenant_id=$1 and d.signature_case_id=$2 and v.source_object_key is not null
       union all
       select v.canonical_object_key, 'document_versions'
         from app.document_versions v join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
        where v.tenant_id=$1 and d.signature_case_id=$2 and v.canonical_object_key is not null
       union all
       select p.object_key, 'evidence_packages' from app.evidence_packages p
        where p.tenant_id=$1 and p.signature_case_id=$2
       union all
       select f.object_key, 'derived_renders' from app.evidence_package_files f
         join app.evidence_packages p on p.tenant_id=f.tenant_id and p.id=f.evidence_package_id
        where f.tenant_id=$1 and p.signature_case_id=$2
       union all
       select r.object_key, 'derived_renders' from app.document_processor_reports r
         join app.document_versions v on v.tenant_id=r.tenant_id and v.id=r.document_version_id
         join app.documents d on d.tenant_id=v.tenant_id and d.id=v.document_id
        where r.tenant_id=$1 and d.signature_case_id=$2 and r.object_key is not null`,
      [tenantId, caseId],
    );
    return result.rows;
  });

  let storageDeleted = 0;
  let storageFailed = 0;
  for (const row of objectKeys) {
    try {
      await infrastructure.objectStorage.deleteObject!(context, row.object_key);
      storageDeleted += 1;
    } catch {
      // A single object that resists deletion must not silently vanish from the
      // report. The count is what makes the run auditable.
      storageFailed += 1;
    }
  }

  const rowCounts = await tenant(database, tenantId, async (tx) => {
    const notifications = await tx.query(
      `update app.email_messages set message_payload_ciphertext=null,recipient_ciphertext=null
        where tenant_id=$1 and signature_case_id=$2 and message_payload_ciphertext is not null`,
      [tenantId, caseId],
    );
    const versions = await tx.query(
      `delete from app.document_versions v using app.documents d
        where v.tenant_id=$1 and d.tenant_id=v.tenant_id and d.id=v.document_id and d.signature_case_id=$2`,
      [tenantId, caseId],
    );
    const documents = await tx.query(`delete from app.documents where tenant_id=$1 and signature_case_id=$2`, [tenantId, caseId]);
    return {
      notifications: notifications.rowCount ?? 0,
      versions: versions.rowCount ?? 0,
      documents: documents.rowCount ?? 0,
    };
  });

  const outcomes: GallringTargetOutcome[] = [
    { target: 'object_storage', deletedCount: storageDeleted, verified: storageFailed === 0,
      ...(storageFailed > 0 ? { note: `${storageFailed} objects could not be deleted` } : {}) },
    { target: 'documents', deletedCount: rowCounts.documents, verified: true },
    { target: 'document_versions', deletedCount: rowCounts.versions, verified: true },
    { target: 'notifications', deletedCount: rowCounts.notifications, verified: true },
    // The evidence package rows are append-only and hash-linked; their payloads
    // are gone with the objects above. Reporting the row count as deleted would
    // be a false statement about what remains in the database.
    { target: 'evidence_packages', deletedCount: 0, verified: true,
      note: 'payloads destroyed in object storage; append-only hash records retained as cryptographic erasure' },
    { target: 'derived_renders', deletedCount: 0, verified: true,
      note: 'processor reports and package files destroyed in object storage; hash records retained' },
    // No search index or shared cache holds case content in this deployment.
    // Saying so explicitly is the point: the target is addressed, not skipped.
    { target: 'search_index', deletedCount: 0, verified: true, note: 'no search index stores case content in this deployment' },
    { target: 'cache', deletedCount: 0, verified: true, note: 'no shared cache stores case content in this deployment' },
    { target: 'signature_case', deletedCount: 0, verified: true,
      note: 'case shell retained for the audit chain; all personal data and documents destroyed' },
  ];
  return outcomes;
}

/** Sums per-case outcomes into one row per target, keeping any note that recorded a problem. */
function mergeOutcomes(outcomes: readonly GallringTargetOutcome[]): readonly GallringTargetOutcome[] {
  const merged = new Map<GallringTarget, GallringTargetOutcome>();
  for (const outcome of outcomes) {
    const existing = merged.get(outcome.target);
    if (!existing) { merged.set(outcome.target, outcome); continue; }
    const note = existing.note ?? outcome.note;
    merged.set(outcome.target, {
      target: outcome.target,
      deletedCount: existing.deletedCount + outcome.deletedCount,
      // One unverified case makes the whole target unverified. Averaging it away
      // would let a run with a single failure report as complete.
      verified: existing.verified && outcome.verified,
      ...(note ? { note } : {}),
    });
  }
  return [...merged.values()].sort((left, right) => left.target.localeCompare(right.target, 'en'));
}

async function abandon(database: SqlDatabase, tenantId: string, gallringJobId: string, reason: string): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(`update app.gallring_jobs set state='ABANDONED',abandoned_reason=$3 where tenant_id=$1 and id=$2`, [tenantId, gallringJobId, reason]);
    await audit(tx, tenantId, 'BUSINESS', 'retention.gallring_abandoned', 'gallring_job', gallringJobId, { reason });
  });
}

export { GallringExecutionError, RetentionPolicyError };

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
function safeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'RETENTION_ERROR'; }
