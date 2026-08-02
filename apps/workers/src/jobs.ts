export type DurableJobType =
  | 'DOCUMENT_SCAN'
  | 'DOCUMENT_CANONICALIZE'
  | 'IDENTITY_STATUS_POLL'
  | 'SIGNATURE_CREATE'
  | 'SIGNATURE_VALIDATE'
  | 'WEBHOOK_DELIVER'
  | 'REMINDER_SEND'
  | 'CASE_EXPIRE'
  | 'ARCHIVE_EXPORT'
  | 'RETENTION_EXECUTE';

export interface DurableJob<T = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly tenantId: string;
  readonly type: DurableJobType;
  readonly payload: T;
  readonly idempotencyKey: string;
  readonly availableAt: string;
  readonly attempts: number;
  readonly maximumAttempts: number;
}

export interface DurableJobRepository {
  claim(workerId: string, limit: number, leaseSeconds: number): Promise<readonly DurableJob[]>;
  complete(jobId: string, workerId: string): Promise<void>;
  retry(jobId: string, workerId: string, nextAvailableAt: string, safeErrorCode: string): Promise<void>;
  deadLetter(jobId: string, workerId: string, safeErrorCode: string): Promise<void>;
}

export async function processClaimedJob(
  repository: DurableJobRepository,
  workerId: string,
  job: DurableJob,
  handlers: Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>>,
): Promise<void> {
  try {
    await handlers[job.type](job);
    await repository.complete(job.id, workerId);
  } catch (cause) {
    const code = cause instanceof Error ? cause.name : 'UNKNOWN_WORKER_ERROR';
    if (job.attempts + 1 >= job.maximumAttempts) await repository.deadLetter(job.id, workerId, code);
    else {
      const delaySeconds = Math.min(3600, 2 ** Math.min(job.attempts, 10));
      await repository.retry(job.id, workerId, new Date(Date.now() + delaySeconds * 1000).toISOString(), code);
    }
  }
}
