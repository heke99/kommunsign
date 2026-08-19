import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import type {
  Page, PageInput, PrivacyRepository, PrivacyRequestView, RecordPrivacyRequestInput,
} from '../../ports.js';
import type { SensitiveDataAdapter } from './infrastructure.js';
import { RESPONSE_DEADLINE_DAYS } from '../../../../../packages/privacy/src/index.js';

/**
 * Rights requests, from the customer's side.
 *
 * Two things are load-bearing in the order of operations. Identity is captured
 * when the request is recorded, not when it is executed, because every step
 * after recording is either disclosure or destruction and neither may proceed
 * on an unproven claim to be someone. And recording is separated from
 * executing, so the person who logs a request is not automatically the person
 * who can destroy the record behind it.
 *
 * The subject's identifier never lands in a column in the clear: it is
 * encrypted for storage and blind-indexed for lookup, the same treatment every
 * other identifier in this schema gets. A rights request is, after all, filed
 * by someone who has just told us they care about their personal data.
 */
export function createPrivacyRepository(database: SqlDatabase, sensitiveData: SensitiveDataAdapter): PrivacyRepository {
  return {
    async record(context, input, idempotencyKey, payloadHash) {
      void idempotencyKey; void payloadHash;
      const ciphertext = await sensitiveData.encryptText(input.subjectIdentifier, 'privacy.subject_identifier');
      const blindIndex = await sensitiveData.blindIndex(input.subjectIdentifier, 'privacy.subject_identifier');

      return tenantTx(database, context, async (tx) => {
        // The unique partial index makes one open request per subject per right
        // the rule. A retry therefore returns the request that already exists
        // rather than starting a second thirty-day clock for the same person.
        const inserted = await tx.query<{ readonly id: string }>(
          `insert into app.privacy_requests(tenant_id,state,right_requested,
             subject_identifier_ciphertext,subject_identifier_blind_index,due_at,
             identity_verified_at,identity_method,identity_assurance)
           values($1,'RECEIVED',$2,$3,$4,now()+make_interval(days=>$5),now(),$6,$7)
           on conflict do nothing
           returning id`,
          [context.tenantId, input.right, ciphertext, blindIndex, RESPONSE_DEADLINE_DAYS,
            input.identityMethod, input.identityAssurance],
        );

        let privacyRequestId = inserted.rows[0]?.id;
        if (!privacyRequestId) {
          const existing = await tx.query<{ readonly id: string }>(
            `select id from app.privacy_requests
              where tenant_id=$1 and subject_identifier_blind_index=$2 and right_requested=$3
                and state not in ('DELIVERED','REFUSED')`,
            [context.tenantId, blindIndex, input.right],
          );
          privacyRequestId = existing.rows[0]?.id;
          if (!privacyRequestId) throw new PrivacyApiError('PRIVACY_REQUEST_CONFLICT', 'The request could not be recorded');
        } else {
          // The identifier itself is never audited, only that a request exists.
          await audit(tx, context, 'privacy.request_recorded', 'privacy_request', privacyRequestId, {
            right: input.right, identityAssurance: input.identityAssurance, identityMethod: input.identityMethod,
          });
        }
        return loadView(tx, context.tenantId, privacyRequestId);
      });
    },

    async execute(context, privacyRequestId) {
      return tenantTx(database, context, async (tx) => {
        const current = await tx.query<{ readonly state: string; readonly handled_by: string | null }>(
          `select state,handled_by from app.privacy_requests where tenant_id=$1 and id=$2 for update`,
          [context.tenantId, privacyRequestId],
        );
        const row = current.rows[0];
        if (!row) throw new PrivacyApiError('PRIVACY_REQUEST_NOT_FOUND', 'No such request');
        if (row.state === 'DELIVERED' || row.state === 'REFUSED') {
          throw new PrivacyApiError('PRIVACY_REQUEST_CLOSED', 'The request is already closed');
        }

        // Whoever queues the execution is the handler of record. The worker
        // refuses to proceed without one, so this is where that gets set.
        await tx.query(
          `update app.privacy_requests set handled_by=coalesce(handled_by,$3) where tenant_id=$1 and id=$2`,
          [context.tenantId, privacyRequestId, context.subjectId],
        );
        await tx.query(
          `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts)
           values($1,'PRIVACY_REQUEST_EXECUTE',$2::jsonb,$3,'pending',now(),3)
           on conflict (tenant_id,job_type,idempotency_key) do nothing`,
          [context.tenantId, { privacyRequestId }, `privacy:${privacyRequestId}`],
        );
        await audit(tx, context, 'privacy.request_execution_queued', 'privacy_request', privacyRequestId, {});
        return loadView(tx, context.tenantId, privacyRequestId);
      });
    },

    async get(context, privacyRequestId) {
      return tenantTx(database, context, async (tx) => loadView(tx, context.tenantId, privacyRequestId));
    },

    async list(context, page) {
      return tenantTx(database, context, async (tx) => {
        const limit = Math.min(Math.max(page.limit ?? 25, 1), 100);
        const result = await tx.query<RequestRow>(
          `select id,state,right_requested,received_at,due_at,identity_assurance,delivered_at,refusal_ground
             from app.privacy_requests
            where tenant_id=$1 and ($2::timestamptz is null or received_at < $2)
            order by received_at desc, id desc limit $3`,
          [context.tenantId, page.cursor ?? null, limit + 1],
        );
        const rows = result.rows.slice(0, limit);
        const views: PrivacyRequestView[] = [];
        for (const row of rows) views.push(await viewWithCoverage(tx, context.tenantId, row));
        const last = rows[rows.length - 1];
        return {
          data: views,
          ...(result.rows.length > limit && last ? { nextCursor: new Date(last.received_at).toISOString() } : {}),
        } satisfies Page<PrivacyRequestView>;
      });
    },
  };
}

export class PrivacyApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PrivacyApiError';
  }
}

interface RequestRow {
  readonly id: string;
  readonly state: PrivacyRequestView['state'];
  readonly right_requested: PrivacyRequestView['right'];
  readonly received_at: string | Date;
  readonly due_at: string | Date;
  readonly identity_assurance: PrivacyRequestView['identityAssurance'];
  readonly delivered_at: string | Date | null;
  readonly refusal_ground: string | null;
}

async function loadView(tx: SqlTransaction, tenantId: string, privacyRequestId: string): Promise<PrivacyRequestView> {
  const result = await tx.query<RequestRow>(
    `select id,state,right_requested,received_at,due_at,identity_assurance,delivered_at,refusal_ground
       from app.privacy_requests where tenant_id=$1 and id=$2`,
    [tenantId, privacyRequestId],
  );
  const row = result.rows[0];
  if (!row) throw new PrivacyApiError('PRIVACY_REQUEST_NOT_FOUND', 'No such request');
  return viewWithCoverage(tx, tenantId, row);
}

async function viewWithCoverage(tx: SqlTransaction, tenantId: string, row: RequestRow): Promise<PrivacyRequestView> {
  const coverage = await tx.query<{
    readonly store: PrivacyRequestView['coverage'][number]['store'];
    readonly record_count: number;
    readonly searched: boolean;
    readonly exemption_reason: string | null;
    readonly action_taken: string;
  }>(
    `select store,record_count,searched,exemption_reason,action_taken
       from app.privacy_request_coverage where tenant_id=$1 and privacy_request_id=$2 order by store`,
    [tenantId, row.id],
  );
  const dueAt = new Date(row.due_at).toISOString();
  return {
    privacyRequestId: row.id,
    state: row.state,
    right: row.right_requested,
    receivedAt: new Date(row.received_at).toISOString(),
    dueAt,
    // Overdue is a property of an open request. A delivered one that took too
    // long is a fact for the audit trail, not an outstanding obligation.
    overdue: row.state !== 'DELIVERED' && row.state !== 'REFUSED' && Date.parse(dueAt) <= Date.now(),
    identityAssurance: row.identity_assurance,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    refusalGround: row.refusal_ground,
    coverage: coverage.rows.map((entry) => ({
      store: entry.store,
      recordCount: entry.record_count,
      searched: entry.searched,
      exemptionReason: entry.exemption_reason,
      actionTaken: entry.action_taken,
    })),
  };
}

async function tenantTx<T>(database: SqlDatabase, context: TenantContext, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, context, 'internal_user', work);
}

async function audit(tx: SqlTransaction, context: TenantContext, eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`select audit.append_event($1,'BUSINESS',$2,$3,$4,$5,$6,$7::jsonb,now())`,
    [context.tenantId, eventType, context.authMethod, context.subjectId, resourceType, resourceId, payload]);
}
