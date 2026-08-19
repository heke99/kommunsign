import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import { createPostgresDatabase } from '../../api/src/production-adapters/postgres/sql-database.js';
import { loadProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import { createProvisioningRepository } from '../../api/src/production-adapters/postgres/provisioning-repository.js';
import type { DurableJob, DurableJobRepository, DurableJobType } from './jobs.js';
import { createProductionJobHandlers } from './production-handlers.js';
import { createOfficeSourceJobHandlers } from './office-document-handlers.js';

const PLATFORM_JOB_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const supportedTypes: readonly DurableJobType[] = [
  'APPLICATION_NOTIFICATION', 'APPLICATION_DEADLINE', 'TENANT_PROVISION', 'TENANT_READINESS',
  'TENANT_ACTIVATION', 'CERTIFICATE_MONITOR', 'DOCUMENT_SCAN', 'DOCUMENT_CANONICALIZE',
  'IDENTITY_STATUS_POLL', 'SIGNATURE_CREATE', 'SIGNATURE_VALIDATE', 'TIC_EVIDENCE_COLLECT',
  'EVIDENCE_PACKAGE_BUILD', 'EMAIL_SEND', 'WEBHOOK_DELIVER',
  'REMINDER_SEND', 'CASE_EXPIRE', 'ARCHIVE_EXPORT', 'RETENTION_EXECUTE',
];

interface AdapterResult {
  readonly repository: DurableJobRepository;
  readonly handlers: Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>>;
  readonly close: () => Promise<void>;
}

interface DurableJobRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly job_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotency_key: string;
  readonly available_at: Date | string;
  readonly attempts: number | string;
  readonly maximum_attempts: number | string;
}

export async function createProductionWorkerAdapter(
  configuration: Readonly<Record<string, string>>,
): Promise<AdapterResult> {
  // A worker processes a bounded number of jobs at a time; it does not need an API-sized pool.
  const controlDatabase = await createPostgresDatabase(
    required(configuration, 'CONTROL_DATABASE_URL'), 'kommunsign-control-worker', { maximumConnections: 5 },
  );
  const dataDatabase = await createPostgresDatabase(
    required(configuration, 'DATA_DATABASE_URL'), 'kommunsign-data-worker', { maximumConnections: 5 },
  );
  try {
    const infrastructure = await loadProductionInfrastructure(configuration);
    const provisioning = createProvisioningRepository(controlDatabase, dataDatabase, infrastructure, {
      rootDomain: value(configuration, 'KOMMUNSIGN_ROOT_DOMAIN', 'kommunsign.se'),
      releaseVersion: value(configuration, 'KOMMUNSIGN_RELEASE_VERSION', 'development-unversioned'),
      kmsKeyReference: required(configuration, 'KMS_KEY_REFERENCE'),
      platformWildcardVerified: booleanValue(configuration, 'PLATFORM_WILDCARD_VERIFIED', false),
      bankIdRolloutEnabled: booleanValue(configuration, 'TIC_BANKID_ENABLED', false)
        && !booleanValue(configuration, 'TIC_GLOBAL_KILL_SWITCH', false),
      bucketNames: [
        value(configuration, 'STORAGE_APPLICATION_QUARANTINE_BUCKET', 'application-quarantine'),
        value(configuration, 'STORAGE_DOCUMENT_QUARANTINE_BUCKET', 'document-quarantine'),
        value(configuration, 'STORAGE_CANONICAL_DOCUMENTS_BUCKET', 'canonical-documents'),
        value(configuration, 'STORAGE_SIGNED_DOCUMENTS_BUCKET', 'signed-documents'),
        value(configuration, 'STORAGE_VALIDATION_REPORTS_BUCKET', 'validation-reports'),
        value(configuration, 'STORAGE_EVIDENCE_PACKAGES_BUCKET', 'evidence-packages'),
      ],
    });
    const repository = createDurableJobRepository(controlDatabase, dataDatabase);
    await recoverProvisioningJobs(controlDatabase, dataDatabase);
    const bankIdHandlers = createProductionJobHandlers({
      controlDatabase,
      dataDatabase,
      infrastructure,
      configuration,
    });
    const officeSourceHandlers = createOfficeSourceJobHandlers({
      dataDatabase,
      infrastructure,
      configuration,
      fallback: {
        DOCUMENT_SCAN: bankIdHandlers.DOCUMENT_SCAN,
        DOCUMENT_CANONICALIZE: bankIdHandlers.DOCUMENT_CANONICALIZE,
      },
    });
    const handlers: Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>> = {
      ...bankIdHandlers,
      ...officeSourceHandlers,
      TENANT_PROVISION: async (job) => {
        const requestId = stringPayload(job.payload, 'provisioningRequestId');
        const result = await provisioning.run(requestId, `durable-job:${job.id}`);
        if (result.status === 'failed') throw new Error(result.blockingCode ?? 'TENANT_PROVISION_FAILED');
        if (result.status === 'waiting_for_external_dependency') {
          throw new Error(result.blockingCode ?? 'TENANT_PROVISION_WAITING_FOR_DEPENDENCY');
        }
      },
    };
    return {
      repository,
      handlers,
      async close() {
        await Promise.allSettled([controlDatabase.close(), dataDatabase.close()]);
      },
    };
  } catch (cause) {
    await Promise.allSettled([controlDatabase.close(), dataDatabase.close()]);
    throw cause;
  }
}


async function recoverProvisioningJobs(
  controlDatabase: SqlDatabase,
  dataDatabase: SqlDatabase,
): Promise<void> {
  const recoverable = await controlDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{
      readonly id: string;
      readonly application_id: string;
    }>(
      `select request.id,request.application_id
         from control.tenant_provisioning_requests request
        where request.status in ('queued','retry_scheduled','partially_completed')
           or (
             request.status='running'
             and request.updated_at < now() - interval '15 minutes'
           )
           or (
             request.status='waiting_for_external_dependency'
             and request.blocking_code in ('DATA_PLANE_NOT_READY','DATA_PLANE_STORAGE_SECRET_MISSING')
             and exists (
               select 1
                 from control.data_planes plane
                where plane.deployment_mode=request.deployment_mode
                  and plane.status='ready'
                  and plane.region=request.region
                  and plane.storage_secret_reference is not null
             )
           )
        order by request.created_at,request.id`,
    );
    return result.rows;
  });

  for (const request of recoverable) {
    const context = workerContext(PLATFORM_JOB_TENANT_ID);
    await withTenantTransaction(dataDatabase, context, 'worker', async (transaction) => {
      const existing = await transaction.query<{
        readonly id: string;
        readonly status: string;
        readonly lease_active: boolean;
      }>(
        `select id,status::text as status,
                status='leased' and coalesce(lease_expires_at,now()+interval '1 minute')>now() as lease_active
           from app.durable_jobs
          where tenant_id=$1
            and job_type='TENANT_PROVISION'
            and payload->>'provisioningRequestId'=$2
          order by created_at desc,id desc
          limit 1`,
        [PLATFORM_JOB_TENANT_ID, request.id],
      );
      const job = existing.rows[0];
      if (job && !job.lease_active) {
        await transaction.query(
          `update app.durable_jobs
              set status='pending',available_at=now(),lease_owner=null,lease_expires_at=null,
                  last_error_code=null,attempts=case when status='dead_letter' then 0 else attempts end,
                  updated_at=now()
            where tenant_id=$1
              and id=$2`,
          [PLATFORM_JOB_TENANT_ID, job.id],
        );
      } else if (!job) {
        await transaction.query(
          `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status)
           values($1,'TENANT_PROVISION',$2::jsonb,$3,'pending')`,
          [
            PLATFORM_JOB_TENANT_ID,
            { provisioningRequestId: request.id, applicationId: request.application_id },
            `tenant-provision-recovery:${request.id}`,
          ],
        );
      }
    });
    await controlDatabase.transaction(async (transaction) => {
      await transaction.query(
        `update control.tenant_provisioning_requests
            set status='queued',blocking_code=null,updated_at=now()
          where id=$1
            and status<>'completed'`,
        [request.id],
      );
    });
  }
}

function createDurableJobRepository(
  controlDatabase: SqlDatabase,
  dataDatabase: SqlDatabase,
): DurableJobRepository {
  const claimedTenants = new Map<string, string>();
  return {
    async claim(workerId, limit, leaseSeconds) {
      validateClaim(workerId, limit, leaseSeconds);
      const tenantIds = await claimableTenantIds(controlDatabase);
      const jobs: DurableJob[] = [];
      for (const tenantId of tenantIds) {
        if (jobs.length >= limit) break;
        const remaining = limit - jobs.length;
        const context = workerContext(tenantId);
        const claimed = await withTenantTransaction(dataDatabase, context, 'worker', async (transaction) => {
          const result = await transaction.query<DurableJobRow>(
            `select tenant_id,id,job_type,payload,idempotency_key,available_at,attempts,maximum_attempts
               from app.claim_durable_jobs($1,$2,$3)`,
            [workerId, remaining, leaseSeconds],
          );
          return result.rows;
        });
        for (const row of claimed) {
          const type = durableJobType(row.job_type);
          claimedTenants.set(row.id, row.tenant_id);
          jobs.push({
            id: row.id,
            tenantId: row.tenant_id,
            type,
            payload: row.payload,
            idempotencyKey: row.idempotency_key,
            availableAt: new Date(row.available_at).toISOString(),
            attempts: Number(row.attempts),
            maximumAttempts: Number(row.maximum_attempts),
          });
        }
      }
      return jobs;
    },

    async complete(jobId, workerId) {
      const tenantId = requiredClaimedTenant(claimedTenants, jobId);
      await updateJob(dataDatabase, tenantId, jobId, workerId, async (transaction) => {
        await transaction.query(
          `update app.durable_jobs
              set status='completed',lease_owner=null,lease_expires_at=null,updated_at=now()
            where tenant_id=$1
              and id=$2
              and status='leased'
              and lease_owner=$3`,
          [tenantId, jobId, workerId],
        );
      });
      claimedTenants.delete(jobId);
    },

    async retry(jobId, workerId, nextAvailableAt, safeErrorCode) {
      const tenantId = requiredClaimedTenant(claimedTenants, jobId);
      await updateJob(dataDatabase, tenantId, jobId, workerId, async (transaction) => {
        await transaction.query(
          `update app.durable_jobs
              set status='pending',available_at=$4,lease_owner=null,lease_expires_at=null,
                  last_error_code=$5,updated_at=now()
            where tenant_id=$1
              and id=$2
              and status='leased'
              and lease_owner=$3`,
          [tenantId, jobId, workerId, nextAvailableAt, cleanErrorCode(safeErrorCode)],
        );
      });
      claimedTenants.delete(jobId);
    },

    async deadLetter(jobId, workerId, safeErrorCode) {
      const tenantId = requiredClaimedTenant(claimedTenants, jobId);
      await updateJob(dataDatabase, tenantId, jobId, workerId, async (transaction) => {
        await transaction.query(
          `update app.durable_jobs
              set status='dead_letter',lease_owner=null,lease_expires_at=null,
                  last_error_code=$4,updated_at=now()
            where tenant_id=$1
              and id=$2
              and status='leased'
              and lease_owner=$3`,
          [tenantId, jobId, workerId, cleanErrorCode(safeErrorCode)],
        );
      });
      claimedTenants.delete(jobId);
    },

    async heartbeat(jobId, workerId, leaseSeconds) {
      const tenantId = requiredClaimedTenant(claimedTenants, jobId);
      validateClaim(workerId, 1, leaseSeconds);
      await updateJob(dataDatabase, tenantId, jobId, workerId, async (transaction) => {
        const result = await transaction.query<{ readonly id: string }>(
          `update app.durable_jobs
              set lease_expires_at=now()+make_interval(secs=>$4),updated_at=now()
            where tenant_id=$1 and id=$2 and status='leased' and lease_owner=$3
            returning id`,
          [tenantId, jobId, workerId, leaseSeconds],
        );
        if (!result.rows[0]) throw new Error('WORKER_LEASE_LOST');
      });
    },
  };
}

async function claimableTenantIds(controlDatabase: SqlDatabase): Promise<readonly string[]> {
  return controlDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ readonly id: string }>(
      `select id
         from control.platform_tenants
        where status in ('provisioning','onboarding','active')
        order by created_at,id`,
    );
    return [PLATFORM_JOB_TENANT_ID, ...result.rows.map((row) => row.id)];
  });
}

async function updateJob(
  database: SqlDatabase,
  tenantId: string,
  jobId: string,
  workerId: string,
  work: (transaction: SqlTransaction) => Promise<void>,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('WORKER_JOB_ID_INVALID');
  if (!workerId.trim()) throw new Error('WORKER_ID_INVALID');
  await withTenantTransaction(database, workerContext(tenantId), 'worker', work);
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

function requiredClaimedTenant(claimed: ReadonlyMap<string, string>, jobId: string): string {
  const tenantId = claimed.get(jobId);
  if (!tenantId) throw new Error('WORKER_JOB_NOT_CLAIMED_BY_PROCESS');
  return tenantId;
}

function durableJobType(valueToCheck: string): DurableJobType {
  if (!supportedTypes.includes(valueToCheck as DurableJobType)) throw new Error(`WORKER_JOB_TYPE_UNSUPPORTED:${valueToCheck}`);
  return valueToCheck as DurableJobType;
}

function validateClaim(workerId: string, limit: number, leaseSeconds: number): void {
  if (!/^[A-Za-z0-9._:-]{3,200}$/.test(workerId)) throw new Error('WORKER_ID_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('WORKER_CLAIM_LIMIT_INVALID');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error('WORKER_LEASE_SECONDS_INVALID');
}

function stringPayload(payload: Readonly<Record<string, unknown>>, name: string): string {
  const result = payload[name];
  if (typeof result !== 'string' || !result.trim()) throw new Error(`WORKER_PAYLOAD_${name.toUpperCase()}_INVALID`);
  return result;
}

function cleanErrorCode(valueToClean: string): string {
  return valueToClean.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 120) || 'WORKER_ERROR';
}

function booleanValue(configuration: Readonly<Record<string, string>>, name: string, fallback: boolean): boolean {
  const raw = configuration[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name}_INVALID`);
}

function value(configuration: Readonly<Record<string, string>>, name: string, fallback: string): string {
  return configuration[name]?.trim() || fallback;
}

function required(configuration: Readonly<Record<string, string>>, name: string): string {
  const result = configuration[name]?.trim();
  if (!result) throw new Error(`${name}_MISSING`);
  return result;
}
