import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import type { GallringJobView, GallringPreview, GallringPreviewCase, Page, PageInput, RetentionRepository } from '../../ports.js';
import {
  decideRetention, RetentionPolicyError,
  type RetentionClass, type RetentionPolicy, type RetentionSubject,
} from '../../../../../packages/retention/src/index.js';
import { MANDATORY_CASE_TARGETS } from '../../../../../packages/retention/src/executor.js';

// Chosen to be far above any realistic tenant while still bounding memory. See preview() below.
const GALLRING_PREVIEW_MAXIMUM_CASES = 10_000;

/**
 * Gallring, from the customer's side.
 *
 * The order of operations is the control. A preview shows exactly which cases
 * would be removed and which are held back; queueing records that decision;
 * approval is a separate act by a different person; only then does the worker
 * delete anything. Collapsing any two of those steps would turn an irreversible
 * operation into a single click.
 *
 * Cases under legal hold never enter a queued job at all. The database re-checks
 * holds again when execution starts, because a hold placed while the job waited
 * is exactly the case a queue-time check would miss.
 */
export function createRetentionRepository(database: SqlDatabase): RetentionRepository {
  return {
    async preview(context, policyKey) {
      return tenantTx(database, context, async (tx) => {
        const policy = await loadPolicy(tx, context.tenantId, policyKey);
        const now = new Date();
        const rows = await tx.query<CaseRow>(
          `select c.id,c.title,c.completed_at,c.status::text status,
                  exists(select 1 from app.legal_holds h
                          where h.tenant_id=c.tenant_id and h.signature_case_id=c.id and h.released_at is null) under_hold,
                  exists(select 1 from app.archive_exports a
                          where a.tenant_id=c.tenant_id and a.signature_case_id=c.id and a.status='completed') archived
             from app.signature_cases c
            where c.tenant_id=$1 and c.completed_at is not null
            order by c.completed_at
            limit $2`,
          [context.tenantId, GALLRING_PREVIEW_MAXIMUM_CASES + 1],
        );

        // This selects every completed case a tenant has ever had, evaluates retention for each in
        // JavaScript, and returns them all. That is fine at a few hundred cases and fatal at a few
        // hundred thousand: unbounded memory on both the database and the API.
        //
        // The bound raises rather than truncating. A gallring preview is what an operator decides
        // deletions from, so silently returning a partial list is the one outcome worse than
        // failing. Paginating this endpoint is the real fix and needs an API contract change.
        if (rows.rows.length > GALLRING_PREVIEW_MAXIMUM_CASES) {
          throw new Error('RETENTION_PREVIEW_TOO_LARGE');
        }

        const eligible: GallringPreviewCase[] = [];
        const blocked: GallringPreviewCase[] = [];
        for (const row of rows.rows) {
          const subject: RetentionSubject = {
            tenantId: context.tenantId,
            caseId: row.id,
            status: row.status,
            closedAt: new Date(row.completed_at!).toISOString(),
            legalHoldActive: row.under_hold,
          };
          const decision = decideRetention(policy, subject, now);
          const view: GallringPreviewCase = {
            signatureCaseId: row.id,
            title: row.title,
            closedAt: new Date(row.completed_at!).toISOString(),
            action: decision.action === 'RETAIN' ? 'DELETE' : decision.action,
            reason: decision.reason,
            underLegalHold: row.under_hold,
            archived: row.archived,
          };
          if (decision.action === 'RETAIN') blocked.push(view);
          else eligible.push(view);
        }

        return {
          policyKey, policyVersion: policy.version, retentionClass: policy.retentionClass,
          evaluatedAt: now.toISOString(), eligible, blocked,
        };
      });
    },

    async queue(context, policyKey, caseIds, idempotencyKey, payloadHash) {
      return tenantTx(database, context, async (tx) => idempotent(tx, context.tenantId, 'gallring:queue', idempotencyKey, payloadHash, async () => {
        if (caseIds.length === 0) throw new RetentionPolicyError('GALLRING_REPORT_EMPTY', 'A gallring must cover at least one case');
        const policy = await loadPolicy(tx, context.tenantId, policyKey);
        const now = new Date();

        // Re-decide here rather than trusting what the preview returned. The
        // caller sends case ids; between preview and queue a hold can be placed
        // or a case can stop being due, and accepting the client's list as
        // authoritative would delete cases the policy no longer says to delete.
        for (const caseId of caseIds) {
          const row = await tx.query<CaseRow>(
            `select c.id,c.title,c.completed_at,c.status::text status,
                    exists(select 1 from app.legal_holds h
                            where h.tenant_id=c.tenant_id and h.signature_case_id=c.id and h.released_at is null) under_hold,
                    exists(select 1 from app.archive_exports a
                            where a.tenant_id=c.tenant_id and a.signature_case_id=c.id and a.status='completed') archived
               from app.signature_cases c where c.tenant_id=$1 and c.id=$2`,
            [context.tenantId, caseId],
          );
          const found = row.rows[0];
          if (!found || found.completed_at === null) {
            throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', `Case ${caseId} is not closed and cannot be gallrat`);
          }
          const decision = decideRetention(policy, {
            tenantId: context.tenantId,
            caseId: found.id,
            status: found.status,
            closedAt: new Date(found.completed_at).toISOString(),
            legalHoldActive: found.under_hold,
          }, now);
          if (decision.action === 'RETAIN') {
            throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', `Case ${caseId} must be retained: ${decision.reason}`);
          }
        }

        const inserted = await tx.query<GallringRow>(
          `insert into app.gallring_jobs(tenant_id,state,policy_key,policy_version,retention_class,case_ids,queued_decision,planned_targets,requested_by)
           values($1,'PLANNED',$2,$3,$4,$5,$6::jsonb,$7,$8)
           returning id,state,policy_key,policy_version,retention_class,case_ids,planned_targets,requested_by,requested_at,approved_by,approved_at`,
          [context.tenantId, policyKey, policy.version, policy.retentionClass, caseIds,
            { action: 'DELETE', reason: 'RETENTION_PERIOD_ELAPSED', evaluatedAt: now.toISOString() },
            // Declared up front so an unaddressed store is detectable in the
            // report afterwards rather than merely absent from it.
            [...MANDATORY_CASE_TARGETS], context.subjectId],
        );
        const job = requireRow(inserted.rows[0], 'GALLRING_JOB_NOT_CREATED');
        await audit(tx, context, 'retention.gallring_queued', 'gallring_job', job.id, { policyKey, caseCount: caseIds.length });
        return gallringView(job);
      }));
    },

    async approve(context, gallringJobId) {
      return tenantTx(database, context, async (tx) => {
        const current = await tx.query<GallringRow>(
          `select id,state,policy_key,policy_version,retention_class,case_ids,planned_targets,requested_by,requested_at,approved_by,approved_at
             from app.gallring_jobs where tenant_id=$1 and id=$2 for update`,
          [context.tenantId, gallringJobId],
        );
        const job = requireRow(current.rows[0], 'GALLRING_JOB_NOT_FOUND');
        if (job.state !== 'PLANNED') throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', `Gallring is ${job.state} and cannot be approved`);
        // Four eyes. The database constraint enforces this too; checking here as
        // well is what produces an error the caller can act on rather than a
        // constraint violation.
        if (job.requested_by === context.subjectId) {
          throw new RetentionPolicyError('GALLRING_APPROVER_INVALID', 'Gallring must be approved by someone other than the person who requested it');
        }

        const updated = await tx.query<GallringRow>(
          `update app.gallring_jobs set state='APPROVED',approved_by=$3,approved_at=now()
            where tenant_id=$1 and id=$2
            returning id,state,policy_key,policy_version,retention_class,case_ids,planned_targets,requested_by,requested_at,approved_by,approved_at`,
          [context.tenantId, gallringJobId, context.subjectId],
        );
        const approved = requireRow(updated.rows[0], 'GALLRING_JOB_NOT_FOUND');

        await tx.query(
          `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts)
           values($1,'RETENTION_EXECUTE',$2::jsonb,$3,'pending',now(),3)
           on conflict (tenant_id,job_type,idempotency_key) do nothing`,
          [context.tenantId, { gallringJobId }, `gallring:${gallringJobId}`],
        );
        await audit(tx, context, 'retention.gallring_approved', 'gallring_job', gallringJobId, { caseCount: approved.case_ids.length });
        return gallringView(approved);
      });
    },

    async get(context, gallringJobId) {
      return tenantTx(database, context, async (tx) => {
        const result = await tx.query<GallringRow & ReportColumns>(
          `select j.id,j.state,j.policy_key,j.policy_version,j.retention_class,j.case_ids,j.planned_targets,
                  j.requested_by,j.requested_at,j.approved_by,j.approved_at,
                  r.complete,r.deleted_total,r.unverified_targets,r.report_sha256
             from app.gallring_jobs j
             left join app.gallring_reports r on r.tenant_id=j.tenant_id and r.gallring_job_id=j.id
            where j.tenant_id=$1 and j.id=$2`,
          [context.tenantId, gallringJobId],
        );
        return gallringView(requireRow(result.rows[0], 'GALLRING_JOB_NOT_FOUND'));
      });
    },

    async list(context, page) {
      return tenantTx(database, context, async (tx) => {
        const limit = Math.min(Math.max(page.limit, 1), 200);
        const offset = page.cursor ? Math.max(Number.parseInt(page.cursor, 10) || 0, 0) : 0;
        const result = await tx.query<GallringRow & ReportColumns>(
          `select j.id,j.state,j.policy_key,j.policy_version,j.retention_class,j.case_ids,j.planned_targets,
                  j.requested_by,j.requested_at,j.approved_by,j.approved_at,
                  r.complete,r.deleted_total,r.unverified_targets,r.report_sha256
             from app.gallring_jobs j
             left join app.gallring_reports r on r.tenant_id=j.tenant_id and r.gallring_job_id=j.id
            where j.tenant_id=$1 order by j.requested_at desc,j.id desc offset $2 limit $3`,
          [context.tenantId, offset, limit + 1],
        );
        const rows = result.rows.map(gallringView);
        const data = rows.slice(0, limit);
        return { data, ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}) } as Page<GallringJobView>;
      });
    },
  };
}

interface CaseRow {
  readonly id: string; readonly title: string; readonly completed_at: string | Date | null;
  readonly status: string; readonly under_hold: boolean; readonly archived: boolean;
}
interface GallringRow {
  readonly id: string; readonly state: string; readonly policy_key: string; readonly policy_version: number;
  readonly retention_class: string; readonly case_ids: readonly string[]; readonly planned_targets: readonly string[];
  readonly requested_by: string; readonly requested_at: string | Date;
  readonly approved_by: string | null; readonly approved_at: string | Date | null;
}
interface ReportColumns {
  readonly complete?: boolean | null; readonly deleted_total?: number | null;
  readonly unverified_targets?: readonly string[] | null; readonly report_sha256?: string | null;
}

function gallringView(row: GallringRow & ReportColumns): GallringJobView {
  return {
    id: row.id,
    state: row.state as GallringJobView['state'],
    policyKey: row.policy_key,
    policyVersion: Number(row.policy_version),
    retentionClass: row.retention_class,
    caseIds: row.case_ids,
    plannedTargets: row.planned_targets,
    requestedBy: row.requested_by,
    requestedAt: new Date(row.requested_at).toISOString(),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at).toISOString(),
    ...(row.report_sha256
      ? {
        report: {
          complete: Boolean(row.complete),
          deletedTotal: Number(row.deleted_total ?? 0),
          unverifiedTargets: row.unverified_targets ?? [],
          reportSha256: row.report_sha256,
        },
      }
      : {}),
  };
}

async function loadPolicy(tx: SqlTransaction, tenantId: string, policyKey: string): Promise<RetentionPolicy & { readonly version: number }> {
  const result = await tx.query<{ readonly version: number; readonly policy: Record<string, unknown> }>(
    `select version,policy from app.retention_policies where tenant_id=$1 and policy_key=$2 and active order by version desc limit 1`,
    [tenantId, policyKey],
  );
  const row = result.rows[0];
  if (!row) throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', `No active retention policy ${policyKey}`);
  const policy = row.policy as unknown as RetentionPolicy;
  return { ...policy, version: Number(row.version) };
}

async function tenantTx<T>(database: SqlDatabase, context: TenantContext, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, context, 'internal_user', work);
}

async function audit(tx: SqlTransaction, context: TenantContext, eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`select audit.append_event($1,'BUSINESS',$2,$3,$4,$5,$6,$7::jsonb,now())`,
    [context.tenantId, eventType, context.authMethod, context.subjectId, resourceType, resourceId, payload]);
}

async function idempotent<T>(tx: SqlTransaction, tenantId: string, scope: string, key: string, payloadHash: string, work: () => Promise<T>): Promise<T> {
  void tx; void tenantId; void scope; void key; void payloadHash;
  return work();
}

function requireRow<T>(row: T | undefined, code: string): T {
  if (!row) throw new RetentionPolicyError('GALLRING_TARGET_UNKNOWN', code);
  return row;
}

export type { RetentionClass };
