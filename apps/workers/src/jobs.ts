export type DurableJobType =
  | 'APPLICATION_NOTIFICATION'
  | 'APPLICATION_DEADLINE'
  | 'TENANT_PROVISION'
  | 'TENANT_READINESS'
  | 'TENANT_ACTIVATION'
  | 'CERTIFICATE_MONITOR'
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
  /** Number of claims including the current lease. */
  readonly attempts: number;
  readonly maximumAttempts: number;
}

export interface DurableJobRepository {
  claim(workerId: string, limit: number, leaseSeconds: number): Promise<readonly DurableJob[]>;
  complete(jobId: string, workerId: string): Promise<void>;
  retry(jobId: string, workerId: string, nextAvailableAt: string, safeErrorCode: string): Promise<void>;
  deadLetter(jobId: string, workerId: string, safeErrorCode: string): Promise<void>;
}

export function retryDelaySeconds(attemptsIncludingCurrentClaim: number): number {
  const completedFailures = Math.max(1, attemptsIncludingCurrentClaim);
  return Math.min(3600, 2 ** Math.min(completedFailures - 1, 10));
}

function safeWorkerErrorCode(cause: unknown): string {
  if (!(cause instanceof Error)) return 'UNKNOWN_WORKER_ERROR';
  const candidate = cause.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
  return candidate || 'WORKER_ERROR';
}

export async function processClaimedJob(
  repository: DurableJobRepository,
  workerId: string,
  job: DurableJob,
  handlers: Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>>,
): Promise<void> {
  if (!workerId.trim()) throw new Error('Worker identity is required');
  if (job.attempts < 1) throw new Error('Claimed jobs must include the current attempt');
  try {
    await handlers[job.type](job);
    await repository.complete(job.id, workerId);
  } catch (cause) {
    const code = safeWorkerErrorCode(cause);
    if (job.attempts >= job.maximumAttempts) await repository.deadLetter(job.id, workerId, code);
    else {
      const delaySeconds = retryDelaySeconds(job.attempts);
      await repository.retry(job.id, workerId, new Date(Date.now() + delaySeconds * 1000).toISOString(), code);
    }
  }
}
