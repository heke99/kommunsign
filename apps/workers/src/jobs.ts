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
  | 'TIC_EVIDENCE_COLLECT'
  | 'EXTERNAL_SIGNATURE_RECONCILE'
  | 'EVIDENCE_PACKAGE_BUILD'
  | 'EMAIL_SEND'
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
  heartbeat?(jobId: string, workerId: string, leaseSeconds: number): Promise<void>;
}

/** Exponential retry base retained as a stable public helper for callers/tests. */
export function retryDelaySeconds(attemptsIncludingCurrentClaim: number): number {
  const completedFailures = Math.max(1, attemptsIncludingCurrentClaim);
  return Math.min(3600, 2 ** Math.min(completedFailures - 1, 10));
}

/**
 * Equal-jitter delay in [base/2, base]. The seed is stable per job/attempt so a
 * restarted worker does not reshuffle the schedule, while different jobs avoid
 * synchronized retry storms.
 */
export function jitteredRetryDelaySeconds(jobId: string, attemptsIncludingCurrentClaim: number): number {
  const base = retryDelaySeconds(attemptsIncludingCurrentClaim);
  let hash = 2166136261;
  const seed = `${jobId}:${Math.max(1, attemptsIncludingCurrentClaim)}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const fraction = hash / 0xffffffff;
  return Math.max(1, Math.min(3600, Math.round((base / 2) + ((base / 2) * fraction))));
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
  const leaseSeconds = 60;
  const heartbeat = repository.heartbeat
    ? setInterval(() => { void repository.heartbeat?.(job.id, workerId, leaseSeconds); }, 20_000)
    : undefined;
  try {
    await repository.heartbeat?.(job.id, workerId, leaseSeconds);
    await handlers[job.type](job);
    await repository.complete(job.id, workerId);
  } catch (cause) {
    const messageCode = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/.test(cause.message) ? cause.message : undefined;
    const code = messageCode ?? safeWorkerErrorCode(cause);
    if ((cause instanceof Error && cause.name === 'PermanentWorkerError') || job.attempts >= job.maximumAttempts) await repository.deadLetter(job.id, workerId, code);
    else {
      const delaySeconds = jitteredRetryDelaySeconds(job.id, job.attempts);
      await repository.retry(job.id, workerId, new Date(Date.now() + delaySeconds * 1000).toISOString(), code);
    }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}
