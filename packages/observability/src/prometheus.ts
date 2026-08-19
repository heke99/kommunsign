import { assertMetricLabelsAreSafe, type MetricSample } from './index.js';

/**
 * Prometheus exposition for the series the alert rules already reference.
 *
 * `infrastructure/monitoring/prometheus-alerts.yaml` has five rules, and until
 * now not one of them matched anything this system emitted — there was no
 * /metrics endpoint at all. An alert watching a series nobody produces is worse
 * than no alert, because a silent alert reads as "nothing is wrong". Every name
 * below is taken from an alert expression rather than invented, and a test
 * reads the rules file and fails if the two sets drift apart.
 *
 * Every series is derived from the database at scrape time rather than
 * accumulated in process, and that is a deliberate choice. A process-local
 * counter restarts at zero on every deploy, which `increase()` reads as a
 * counter reset and silently under-reports; and with more than one instance
 * running, each would report its own share, so an alert threshold would depend
 * on how many pods happened to be up. The durable records these count — audit
 * events, signature attempts, deliveries — already are the ledger. Counting the
 * ledger is both simpler and correct across restarts and instances.
 */

/** The series the alert rules consume. Names are Prometheus-style, not dotted. */
export const PROMETHEUS_COUNTERS = [
  'kommunsign_tenant_isolation_failures_total',
  'kommunsign_signature_attempts_total',
  'kommunsign_pades_admissions_total',
  'kommunsign_pdfa_conversions_total',
  'kommunsign_provider_calls_total',
  'kommunsign_worker_jobs_total',
] as const;
export type PrometheusCounter = (typeof PROMETHEUS_COUNTERS)[number];

export const PROMETHEUS_GAUGES = [
  'kommunsign_certificate_not_after_seconds',
  'kommunsign_last_successful_backup_timestamp_seconds',
  'kommunsign_webhook_queue_oldest_age_seconds',
  'kommunsign_worker_queue_depth',
  'kommunsign_worker_oldest_job_age_seconds',
  'kommunsign_cases_awaiting_completion',
] as const;
export type PrometheusGauge = (typeof PROMETHEUS_GAUGES)[number];

const HELP: Readonly<Record<string, string>> = {
  kommunsign_tenant_isolation_failures_total: 'Requests refused because a tenant boundary would have been crossed.',
  kommunsign_signature_attempts_total: 'Signature attempts by outcome.',
  kommunsign_pades_admissions_total: 'PAdES signatures put through the admission gate, by attained level and outcome.',
  kommunsign_pdfa_conversions_total: 'Documents converted to PDF/A, by outcome.',
  kommunsign_provider_calls_total: 'Calls to an external provider, by provider and outcome.',
  kommunsign_worker_jobs_total: 'Durable jobs finished, by queue and outcome.',
  kommunsign_certificate_not_after_seconds: 'Unix time at which a certificate stops being valid.',
  kommunsign_last_successful_backup_timestamp_seconds: 'Unix time of the last backup that completed successfully.',
  kommunsign_webhook_queue_oldest_age_seconds: 'Age of the oldest webhook delivery still waiting.',
  kommunsign_worker_queue_depth: 'Durable jobs waiting to be claimed.',
  kommunsign_worker_oldest_job_age_seconds: 'Age of the oldest durable job still waiting.',
  kommunsign_cases_awaiting_completion: 'Cases where every mandatory signer has signed but the case is not completed.',
};

/**
 * Series this build declares but cannot yet produce a value for.
 *
 * Being explicit about the gap is the point. Backups are taken by the hosting
 * platform, not by this application, so nothing here knows when the last one
 * succeeded — and the BackupFailed rule alerts on the *absence* of a recent
 * timestamp, which means an un-fed series looks exactly like a healthy one to
 * anyone who has not checked. Listing it here lets the tests hold the line: a
 * series may be alerted on and unfed, but only if it says so out loud.
 *
 * Feeding it is an operator integration, not a code change: the backup job
 * writes the timestamp through the same scrape endpoint's push path or through
 * the platform's own exporter.
 */
export const PROMETHEUS_UNFED_SERIES: readonly string[] = [
  'kommunsign_last_successful_backup_timestamp_seconds',
];

const TYPE: Readonly<Record<string, 'counter' | 'gauge'>> = Object.fromEntries([
  ...PROMETHEUS_COUNTERS.map((name) => [name, 'counter' as const]),
  ...PROMETHEUS_GAUGES.map((name) => [name, 'gauge' as const]),
]);

export interface CounterSample {
  readonly name: PrometheusCounter;
  readonly value: number;
  readonly labels?: Readonly<Record<string, string>>;
}
export interface GaugeSample {
  readonly name: PrometheusGauge;
  readonly value: number;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Renders the exposition format.
 *
 * Sorted and deterministic so a diff between two scrapes is about the values
 * and not about map iteration order. HELP and TYPE are emitted once per metric
 * family, which Prometheus requires — repeating them per series makes the
 * whole scrape fail rather than dropping the duplicate.
 */
export function renderPrometheus(
  counters: readonly CounterSample[],
  gauges: readonly GaugeSample[],
): string {
  const families = new Map<string, string[]>();

  for (const sample of [...counters, ...gauges]) {
    // A NaN or Infinity in the exposition fails the whole scrape, so a metric
    // that could not be computed is omitted rather than emitted as garbage.
    if (!Number.isFinite(sample.value)) continue;
    const labels = sample.labels ?? {};
    // The label allow-list is the real control here: a label carrying a case ID
    // or an email creates one time series per value, which both destroys the
    // metrics backend and quietly turns the scrape into an unredacted export
    // of personal data.
    assertMetricLabelsAreSafe({ name: 'api.request.errors', value: sample.value, labels } satisfies MetricSample);
    appendTo(families, sample.name, `${seriesKey(sample.name, labels)} ${formatValue(sample.value)}`);
  }

  const lines: string[] = [];
  for (const name of [...families.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    const help = HELP[name];
    if (help) lines.push(`# HELP ${name} ${help}`);
    const type = TYPE[name];
    if (type) lines.push(`# TYPE ${name} ${type}`);
    lines.push(...(families.get(name) ?? []).sort((left, right) => left.localeCompare(right, 'en')));
  }
  lines.push('');
  return lines.join('\n');
}

function appendTo(families: Map<string, string[]>, name: string, line: string): void {
  const existing = families.get(name);
  if (existing) existing.push(line);
  else families.set(name, [line]);
}

function seriesKey(name: string, labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right, 'en'));
  if (entries.length === 0) return name;
  const rendered = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `${name}{${rendered}}`;
}

/**
 * Escapes a label value for the exposition format.
 *
 * Without this a value containing a quote or newline ends the label early and
 * the rest is parsed as further labels — a scrape that silently reports the
 * wrong series, or fails the whole endpoint.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Integers render without a decimal point, which keeps scrapes byte-stable. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
