import type { SqlDatabase, SqlTransaction } from '../../../packages/database/src/index.js';
import type { DurableJob } from './jobs.js';
import { evaluateReadiness, type ReadinessCheck } from '../../../packages/readiness/src/index.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';

/**
 * The control-plane jobs.
 *
 * All four dead-lettered on sight before this. Two of them are housekeeping that
 * quietly rots without a runner — an onboarding application that nobody ever
 * expires stays "pending" forever and keeps the applicant's contact details
 * live past their purpose. The other two are load-bearing:
 *
 * `TENANT_READINESS` is what turns the readiness model into a recorded fact
 * rather than something evaluated ad hoc at activation time, and
 * `CERTIFICATE_MONITOR` is the reason the `CertificateExpiringSoon` alert can
 * fire at all. That alert has existed in the Prometheus rules the whole time,
 * watching a series nothing produced — which is worse than no alert, because a
 * silent alert reads as "nothing is wrong".
 */

/**
 * How long an application may sit unverified before it is expired.
 *
 * Deliberately generous: an applicant who missed the email should not lose
 * their submission over a weekend. What matters is that the window ends.
 */
const APPLICATION_VERIFICATION_DEADLINE_DAYS = 30;

/**
 * How close to expiry a certificate must be to warrant renewal.
 *
 * Matches the 14-day threshold in infrastructure/monitoring/prometheus-alerts.yaml.
 * If these two drifted apart, the alert would fire on a set of certificates the
 * system had not flagged, or stay silent on ones it had.
 */
const CERTIFICATE_RENEWAL_WINDOW_DAYS = 14;

export function createPlatformJobHandlers(input: {
  readonly controlDatabase: SqlDatabase;
}): Readonly<Record<'APPLICATION_DEADLINE' | 'TENANT_READINESS' | 'TENANT_ACTIVATION' | 'CERTIFICATE_MONITOR', (job: DurableJob) => Promise<void>>> {
  return {
    APPLICATION_DEADLINE: (job) => handleApplicationDeadline(input.controlDatabase, job),
    TENANT_READINESS: (job) => handleTenantReadiness(input.controlDatabase, job),
    TENANT_ACTIVATION: (job) => handleTenantActivation(input.controlDatabase, job),
    CERTIFICATE_MONITOR: (job) => handleCertificateMonitor(input.controlDatabase, job),
  };
}

/**
 * Expires onboarding applications that were never verified in time.
 *
 * Only the pre-submission states are touched. An application under review is
 * someone's active work and a deadline job must never close it out from
 * underneath them; the point here is unattended records, not stalled decisions.
 */
export async function handleApplicationDeadline(controlDatabase: SqlDatabase, job: DurableJob): Promise<void> {
  const expired = await controlDatabase.transaction(async (tx) => {
    // 'expired' rather than 'withdrawn': withdrawal is an act by the applicant,
    // and recording an unattended timeout as one would put a decision in the
    // record that nobody made. status_version and updated_at are deliberately
    // not set here — control.guard_onboarding_application_update() owns them,
    // and setting them in the statement would be silently overwritten.
    const result = await tx.query<{ readonly id: string; readonly created_at: string | Date }>(
      `update control.onboarding_applications
          set status='expired'
        where status in ('draft','email_verification_pending')
          and created_at < now() - make_interval(days => $1)
        returning id, created_at`,
      [APPLICATION_VERIFICATION_DEADLINE_DAYS],
    );
    return result.rows;
  });

  for (const application of expired) {
    await appendControlAudit(controlDatabase, 'onboarding.application.expired', {
      applicationId: application.id,
      deadlineDays: APPLICATION_VERIFICATION_DEADLINE_DAYS,
      createdAt: new Date(application.created_at).toISOString(),
      jobId: job.id,
    });
  }
}

/**
 * Records a readiness evaluation for a tenant environment.
 *
 * The checks arrive in the job payload because they are gathered by whatever
 * probed the dependencies; this handler's contribution is to evaluate them
 * through the shared model and write the result down. Evaluating readiness in
 * two places with two rules is how a tenant gets activated against a standard
 * nobody agreed to.
 */
export async function handleTenantReadiness(controlDatabase: SqlDatabase, job: DurableJob): Promise<void> {
  const tenantId = uuidPayload(job.payload, 'tenantId');
  const environment = environmentPayload(job.payload);
  const checks = checksPayload(job.payload);
  const activationRequestId = optionalUuidPayload(job.payload, 'activationRequestId');

  const result = evaluateReadiness(environment, checks);

  await controlDatabase.transaction(async (tx) => {
    await tx.query(
      `insert into control.tenant_readiness_results(tenant_id,activation_request_id,environment,ready,blocking_checks,warning_checks,completed_checks,checked_by)
       values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'worker')`,
      [tenantId, activationRequestId ?? null, environment, result.ready,
        result.blockingChecks, result.warningChecks, result.completedChecks],
    );
  });

  await appendControlAudit(controlDatabase, 'tenant.readiness.evaluated', {
    tenantId, environment, ready: result.ready,
    blockingCodes: result.blockingChecks.map((check) => check.code),
    jobId: job.id,
  });
}

/**
 * Activates a tenant, but only against a readiness result that says it may be.
 *
 * The readiness row is re-read here rather than trusted from the job payload.
 * A payload written when the job was queued describes the world at that moment,
 * and activation is the point where being wrong means a tenant goes live with a
 * dependency that was never ready.
 */
export async function handleTenantActivation(controlDatabase: SqlDatabase, job: DurableJob): Promise<void> {
  const tenantId = uuidPayload(job.payload, 'tenantId');
  const activationRequestId = uuidPayload(job.payload, 'activationRequestId');

  const outcome = await controlDatabase.transaction(async (tx) => {
    const request = await tx.query<{ readonly status: string }>(
      `select status from control.tenant_activation_requests
        where id=$1 and tenant_id=$2 for update`,
      [activationRequestId, tenantId],
    );
    const current = request.rows[0];
    if (!current) throw permanent('TENANT_ACTIVATION_REQUEST_NOT_FOUND');
    if (current.status === 'activated') return { activated: false as const, reason: 'ALREADY_ACTIVATED' };
    if (current.status !== 'approved') throw permanent('TENANT_ACTIVATION_NOT_APPROVED');

    const readiness = await tx.query<{ readonly ready: boolean; readonly blocking_checks: readonly unknown[] }>(
      `select ready, blocking_checks from control.tenant_readiness_results
        where tenant_id=$1 and environment='production'
        order by checked_at desc limit 1`,
      [tenantId],
    );
    const latest = readiness.rows[0];
    // No readiness result at all is not the same as a failed one, but it is
    // just as disqualifying: activation must rest on evidence, not on absence
    // of contrary evidence.
    if (!latest) return { activated: false as const, reason: 'NO_PRODUCTION_READINESS_RESULT' };
    if (!latest.ready) return { activated: false as const, reason: 'READINESS_BLOCKED' };

    await tx.query(
      `update control.tenant_activation_requests set status='activated', decided_at=now() where id=$1`,
      [activationRequestId],
    );
    await tx.query(
      `update control.platform_tenants set status='active' where id=$1 and status in ('provisioning','onboarding')`,
      [tenantId],
    );
    return { activated: true as const, reason: 'READY' };
  });

  await appendControlAudit(controlDatabase, outcome.activated ? 'tenant.activated' : 'tenant.activation.refused', {
    tenantId, activationRequestId, reason: outcome.reason, jobId: job.id,
  });

  // A refusal is a decision about the world, not a transient fault, so it is
  // surfaced as a permanent error rather than retried into eventual success.
  if (!outcome.activated && outcome.reason !== 'ALREADY_ACTIVATED') {
    throw permanent(`TENANT_ACTIVATION_REFUSED_${outcome.reason}`);
  }
}

/**
 * Flags certificates approaching expiry and emits the signal the alert watches.
 *
 * A certificate that expires without warning takes a tenant's custom domain
 * offline, and the failure looks like a DNS problem to everyone who has to
 * diagnose it at the time.
 */
export async function handleCertificateMonitor(controlDatabase: SqlDatabase, job: DurableJob): Promise<void> {
  const flagged = await controlDatabase.transaction(async (tx) => {
    const result = await tx.query<{ readonly id: string; readonly tenant_id: string; readonly not_after: string | Date }>(
      `update control.domain_certificate_snapshots
          set status='renewal_required'
        where status='issued'
          and not_after is not null
          and not_after < now() + make_interval(days => $1)
        returning id, tenant_id, not_after`,
      [CERTIFICATE_RENEWAL_WINDOW_DAYS],
    );
    return result.rows;
  });

  // Reported even when nothing was flagged. "No certificates near expiry" is a
  // different statement from "the monitor did not run", and only one of them is
  // reassuring.
  await appendControlAudit(controlDatabase, 'certificate.monitor.completed', {
    windowDays: CERTIFICATE_RENEWAL_WINDOW_DAYS,
    flaggedCount: flagged.length,
    flagged: flagged.map((row) => ({ certificateSnapshotId: row.id, tenantId: row.tenant_id, notAfter: new Date(row.not_after).toISOString() })),
    jobId: job.id,
  });
}

/**
 * Appends to the hash-chained control audit log.
 *
 * The advisory lock serialises appenders. Without it two workers can read the
 * same previous hash and write two events claiming the same predecessor, which
 * silently forks the chain and makes every later verification ambiguous.
 */
export async function appendControlAudit(controlDatabase: SqlDatabase, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await controlDatabase.transaction(async (tx: SqlTransaction) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('control-audit-chain',0))`);
    const previous = await tx.query<{ readonly event_hash: string }>(
      `select event_hash from control.control_audit_events order by occurred_at desc,id desc limit 1`);
    const previousHash = previous.rows[0]?.event_hash ?? '0'.repeat(64);
    const eventHash = await sha256Hex(JSON.stringify({ tenantId: null, actorId: null, eventType, payload, previousHash }));
    await tx.query(
      `insert into control.control_audit_events(tenant_id,actor_id,event_type,payload,previous_event_hash,event_hash)
       values(null,null,$1,$2::jsonb,$3,$4)`,
      [eventType, payload, previousHash, eventHash],
    );
  });
}

function environmentPayload(payload: Readonly<Record<string, unknown>>): 'test' | 'production' {
  const value = payload['environment'];
  if (value !== 'test' && value !== 'production') throw permanent('WORKER_PAYLOAD_ENVIRONMENT_INVALID');
  return value;
}

/**
 * Reads the readiness checks out of the job payload.
 *
 * Strict on shape: a malformed check silently dropped here would make a tenant
 * look readier than it is, which is the one direction this must never fail in.
 */
function checksPayload(payload: Readonly<Record<string, unknown>>): readonly ReadinessCheck[] {
  const value = payload['checks'];
  if (!Array.isArray(value) || value.length === 0) throw permanent('WORKER_PAYLOAD_CHECKS_INVALID');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw permanent('WORKER_PAYLOAD_CHECKS_INVALID');
    const record = entry as Record<string, unknown>;
    const code = record['code'];
    const passed = record['passed'];
    const severity = record['severity'];
    const checkedAt = record['checkedAt'];
    if (typeof code !== 'string' || !code) throw permanent('WORKER_PAYLOAD_CHECKS_INVALID');
    if (typeof passed !== 'boolean') throw permanent('WORKER_PAYLOAD_CHECKS_INVALID');
    if (severity !== 'blocking' && severity !== 'warning') throw permanent('WORKER_PAYLOAD_CHECKS_INVALID');
    if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) throw permanent('WORKER_PAYLOAD_CHECKS_INVALID');
    const evidence = record['evidence'];
    return {
      code, passed, severity, checkedAt,
      ...(evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? { evidence: evidence as Record<string, unknown> } : {}),
    };
  });
}

function uuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  }
  return value;
}
function optionalUuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return payload[key] === undefined ? undefined : uuidPayload(payload, key);
}
function permanent(code: string): Error { const error = new Error(safeCode(code)); error.name = 'PermanentWorkerError'; return error; }
function safeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'PLATFORM_ERROR'; }
