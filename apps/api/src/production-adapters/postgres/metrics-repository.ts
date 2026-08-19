import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { CounterSample, GaugeSample } from '../../../../../packages/observability/src/prometheus.js';

/**
 * The gauges, read from the databases at scrape time.
 *
 * These are facts about stored state, not about this process. Caching them in
 * memory would make every instance report a different answer depending on how
 * long it had been running, and an alert on certificate expiry that depends on
 * which pod answered the scrape is not an alert.
 *
 * Everything here is cross-tenant by design — it is the operator's view — so
 * the queries run outside a tenant transaction and no query returns anything
 * that identifies a person. The one label that varies is `tenant`, which is
 * already in the allowed low-cardinality set.
 */
export function createMetricsRepository(controlDatabase: SqlDatabase, dataDatabase: SqlDatabase): {
  collect(now: Date): Promise<{ readonly counters: readonly CounterSample[]; readonly gauges: readonly GaugeSample[] }>;
} {
  return {
    async collect(now) {
      const gauges: GaugeSample[] = [];
      const counters: CounterSample[] = [];

      // CertificateExpiringSoon compares this against time(). Emitting the
      // absolute expiry rather than a remaining-seconds figure is what lets the
      // alert stay correct if a scrape is late.
      const certificates = await controlDatabase.transaction(async (tx) => tx.query<{ readonly tenant_id: string; readonly not_after: string | Date }>(
        `select tenant_id, min(not_after) not_after
           from control.domain_certificate_snapshots
          where status in ('issued','renewal_required') and not_after is not null
          group by tenant_id`,
      ));
      for (const row of certificates.rows) {
        gauges.push({
          name: 'kommunsign_certificate_not_after_seconds',
          value: Math.floor(new Date(row.not_after).getTime() / 1000),
          labels: { tenant: row.tenant_id },
        });
      }

      // WebhookQueueBacklog. Age of the oldest delivery still owed, not the
      // count: a hundred deliveries a second old is healthy and one delivery
      // twenty minutes old is not.
      const webhook = await dataDatabase.transaction(async (tx) => tx.query<{ readonly oldest: string | Date | null }>(
        // next_attempt_at rather than a created timestamp: the table records
        // when a delivery is next due, and a delivery that keeps being
        // rescheduled is exactly the backlog the alert is looking for.
        `select min(next_attempt_at) oldest from app.webhook_deliveries where status in ('pending','delivering')`,
      ));
      gauges.push({
        name: 'kommunsign_webhook_queue_oldest_age_seconds',
        value: ageSeconds(webhook.rows[0]?.oldest ?? null, now),
      });

      const queue = await dataDatabase.transaction(async (tx) => tx.query<{ readonly job_type: string; readonly waiting: string; readonly oldest: string | Date | null }>(
        `select job_type, count(*)::text waiting, min(available_at) oldest
           from app.durable_jobs where status='pending' group by job_type`,
      ));
      for (const row of queue.rows) {
        gauges.push({ name: 'kommunsign_worker_queue_depth', value: Number(row.waiting), labels: { queue: row.job_type } });
        gauges.push({ name: 'kommunsign_worker_oldest_job_age_seconds', value: ageSeconds(row.oldest, now), labels: { queue: row.job_type } });
      }

      // Cases where every mandatory signer has signed but the case never
      // reached completed. That is the failure uptime monitoring cannot see:
      // nothing is erroring, the work is simply stuck one step from done.
      const stalled = await dataDatabase.transaction(async (tx) => tx.query<{ readonly stalled: string }>(
        `select count(*)::text stalled
           from app.signature_cases c
          where c.completed_at is null
            and c.status not in ('draft','cancelled','expired','completed')
            and exists (select 1 from app.signers s where s.tenant_id=c.tenant_id and s.signature_case_id=c.id and s.required)
            and not exists (
              select 1 from app.signers s
               where s.tenant_id=c.tenant_id and s.signature_case_id=c.id and s.required and s.status <> 'signed'
            )`,
      ));
      gauges.push({ name: 'kommunsign_cases_awaiting_completion', value: Number(stalled.rows[0]?.stalled ?? 0) });

      // Counters, also read from the ledger rather than accumulated in process.
      // A process-local counter restarts at zero on every deploy, which
      // increase() reads as a reset, and with several instances running each
      // would report only its own share.
      //
      // TenantIsolationFailure alerts on increase() over five minutes, so the
      // series has to exist at zero when nothing has gone wrong — a missing
      // series and a quiet one are indistinguishable to an alert that has never
      // seen the metric.
      const isolation = await dataDatabase.transaction(async (tx) => tx.query<{ readonly attempts: string }>(
        `select count(*)::text attempts from audit.audit_events
          where event_type='tenant.access.cross_tenant_attempt'`,
      ));
      counters.push({ name: 'kommunsign_tenant_isolation_failures_total', value: Number(isolation.rows[0]?.attempts ?? 0) });

      // SignatureFailureRate divides failed by total, so both label values must
      // be present even at zero or the ratio is computed against nothing.
      const attempts = await dataDatabase.transaction(async (tx) => tx.query<{ readonly result: string; readonly total: string }>(
        `select case when status='validated' then 'succeeded'
                     when status='failed' then 'failed'
                     else 'in_progress' end result,
                count(*)::text total
           from app.signature_attempts group by 1`,
      ));
      const byResult = new Map(attempts.rows.map((row) => [row.result, Number(row.total)]));
      for (const result of ['succeeded', 'failed', 'in_progress']) {
        counters.push({ name: 'kommunsign_signature_attempts_total', value: byResult.get(result) ?? 0, labels: { outcome: result } });
      }

      // The PAdES level actually attained, never the level that was requested.
      // Registering a higher level than the evidence supports is the specific
      // overclaim the signing chain exists to prevent, so the metric reports
      // what the admission gate recorded.
      const admissions = await dataDatabase.transaction(async (tx) => tx.query<{ readonly format: string; readonly total: string }>(
        `select format, count(*)::text total from app.signature_artifacts group by format`,
      ));
      for (const row of admissions.rows) {
        counters.push({ name: 'kommunsign_pades_admissions_total', value: Number(row.total), labels: { level: row.format } });
      }

      const conversions = await dataDatabase.transaction(async (tx) => tx.query<{ readonly outcome: string; readonly total: string }>(
        `select case when result='PASS' then 'passed' else 'failed' end outcome, count(*)::text total
           from app.document_processor_reports where report_type='PDFA_VALIDATION' group by 1`,
      ));
      for (const outcome of ['passed', 'failed']) {
        const row = conversions.rows.find((entry) => entry.outcome === outcome);
        counters.push({ name: 'kommunsign_pdfa_conversions_total', value: Number(row?.total ?? 0), labels: { outcome } });
      }

      const jobs = await dataDatabase.transaction(async (tx) => tx.query<{ readonly job_type: string; readonly status: string; readonly total: string }>(
        `select job_type, status::text status, count(*)::text total from app.durable_jobs
          where status in ('completed','dead_letter') group by job_type, status`,
      ));
      for (const row of jobs.rows) {
        counters.push({ name: 'kommunsign_worker_jobs_total', value: Number(row.total), labels: { queue: row.job_type, outcome: row.status } });
      }

      const providers = await dataDatabase.transaction(async (tx) => tx.query<{ readonly provider: string; readonly outcome: string; readonly total: string }>(
        `select provider, case when status='verified' then 'passed'
                              when status in ('failed','cancelled','expired') then 'failed'
                              else 'in_progress' end outcome,
                count(*)::text total
           from app.identity_transactions group by 1, 2`,
      ));
      for (const row of providers.rows) {
        counters.push({ name: 'kommunsign_provider_calls_total', value: Number(row.total), labels: { provider: row.provider, outcome: row.outcome } });
      }

      return { counters, gauges };
    },
  };
}

/**
 * Age in seconds, or zero when there is nothing waiting.
 *
 * Zero rather than absent: a missing series and an empty queue look the same to
 * an alert that has never seen the metric, and "the exporter stopped" must not
 * be indistinguishable from "there is no backlog".
 */
function ageSeconds(value: string | Date | null, now: Date): number {
  if (value === null) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000));
}
