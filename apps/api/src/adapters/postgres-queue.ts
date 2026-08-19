import type { TenantContext } from '../../../../packages/contracts/src/index.js';
import { withTenantTransaction } from '../../../../packages/database/src/index.js';
import type { QueueAdapter } from '../production-adapters/postgres/infrastructure.js';
import { createPostgresDatabase } from '../production-adapters/postgres/sql-database.js';

export async function createQueueAdapter(
  configuration: Readonly<Record<string, string>>,
): Promise<QueueAdapter> {
  // This pool only ever enqueues durable jobs, so it does not need a full-size pool of its own
  // alongside the API's control and data pools.
  const database = await createPostgresDatabase(
    required(configuration, 'DATA_DATABASE_URL'),
    'kommunsign-api-queue',
    { maximumConnections: 4 },
  );
  return {
    async enqueue(input) {
      if (!/^[A-Za-z0-9._:-]{3,100}$/.test(input.jobType)) throw new Error('QUEUE_JOB_TYPE_INVALID');
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.idempotencyKey)) throw new Error('QUEUE_IDEMPOTENCY_KEY_INVALID');
      const context: TenantContext = {
        tenantId: input.tenantId,
        subjectId: '00000000-0000-0000-0000-000000000000',
        requestId: crypto.randomUUID(),
        authMethod: 'worker',
        source: 'deployment',
      };
      return withTenantTransaction(database, context, 'worker', async (transaction) => {
        const inserted = await transaction.query<{ readonly id: string }>(
          `insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status)
           values($1,$2,$3::jsonb,$4,'pending')
           on conflict(tenant_id,job_type,idempotency_key) do update set
             payload=case when app.durable_jobs.status='pending' then excluded.payload else app.durable_jobs.payload end,
             updated_at=now()
           returning id`,
          [input.tenantId, input.jobType, input.payload, input.idempotencyKey],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('QUEUE_JOB_INSERT_FAILED');
        return { jobId: row.id };
      });
    },
  };
}

function required(configuration: Readonly<Record<string, string>>, name: string): string {
  const value = configuration[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
