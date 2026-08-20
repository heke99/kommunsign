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
  // The two stages that turn verified identity evidence into an admitted
  // signature. They are separate jobs so that validation can fail on its own:
  // a handler that signed and then judged its own output would be the same
  // party twice, which is the opposite of independent validation.
  | 'PADES_CREATE'
  | 'PADES_VALIDATE'
  | 'TIC_EVIDENCE_COLLECT'
  | 'EVIDENCE_PACKAGE_BUILD'
  | 'EMAIL_SEND'
  | 'WEBHOOK_DELIVER'
  | 'REMINDER_SEND'
  | 'CASE_EXPIRE'
  | 'ARCHIVE_EXPORT'
  | 'RETENTION_EXECUTE'
  | 'PRIVACY_REQUEST_EXECUTE';

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
 * synchronized retry storms. Fractional seconds are preserved so the first
 * retry is jittered too.
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
  const delay = (base / 2) + ((base / 2) * fraction);
  return Math.min(3600, delay);
}

function safeWorkerErrorCode(cause: unknown): string {
  if (!(cause instanceof Error)) return 'UNKNOWN_WORKER_ERROR';
  const candidate = cause.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
  return candidate || 'WORKER_ERROR';
}

/**
 * One line per failed attempt, and nothing that could carry content.
 *
 * The row already records last_error_code, but a row is not somewhere an
 * operator is looking. A job could fail its way to the dead letter queue
 * without the worker writing anything at all, which is how a stalled pipeline
 * looks exactly like an idle one. The Postgres fields below are the same set
 * the API already treats as safe to log: they name the constraint that
 * refused, never the values it refused.
 */
function logFailure(job: DurableJob, code: string, dead: boolean, cause: unknown): void {
  const detail: Record<string, string> = {};
  const source = cause as { readonly code?: unknown; readonly constraint_name?: unknown; readonly table_name?: unknown; readonly routine?: unknown };
  for (const [key, value] of [['sqlState', source?.code], ['constraint', source?.constraint_name], ['table', source?.table_name], ['routine', source?.routine]] as const) {
    if (typeof value === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(value)) detail[key] = value;
  }

  // A built-in error carries no application code, so `code` collapses to its
  // class name and the line says RANGEERROR and nothing else — which names the
  // shape of the failure and not one thing an operator can act on. The class
  // name and the first frame inside this repository are both safe: a file name
  // and a line number cannot carry document content, and they are the
  // difference between "something threw" and "the zip builder threw".
  if (cause instanceof Error) {
    if (/^[A-Za-z]{1,40}$/.test(cause.name)) detail['errorName'] = cause.name;
    const frame = (cause.stack ?? '').split('\n')
      .map((line) => /\(?(?:file:\/\/)?(\/[^\s()]*\/(?:apps|packages|dist)\/[^\s():]+):(\d+):(\d+)\)?$/.exec(line.trim()))
      .find((match) => match !== null);
    if (frame) {
      const path = frame[1]!.replace(/^.*?\/(?:dist\/)?/, '').replace(/\.js$/, '.ts');
      if (/^[A-Za-z0-9_./-]{1,120}$/.test(path)) detail['at'] = `${path}:${frame[2]}`;
    }
  }
  globalThis.console?.error?.(JSON.stringify({
    level: 'error', service: 'kommunsign-workers', event: dead ? 'job_dead_lettered' : 'job_attempt_failed',
    jobId: job.id, jobType: job.type, attempts: job.attempts, code, ...detail,
  }));
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
    const dead = (cause instanceof Error && cause.name === 'PermanentWorkerError') || job.attempts >= job.maximumAttempts;
    logFailure(job, code, dead, cause);
    if (dead) await repository.deadLetter(job.id, workerId, code);
    else {
      const delaySeconds = jitteredRetryDelaySeconds(job.id, job.attempts);
      await repository.retry(job.id, workerId, new Date(Date.now() + delaySeconds * 1000).toISOString(), code);
    }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}
