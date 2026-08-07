/**
 * Structured logging, metrics and security headers.
 *
 * Kungälv 2018-2022, 3518, 3524, 3534, 3535, 3539, 3544: traffic must be
 * protected in transit, system-sensitive data must be access-protected, and
 * security-relevant events must be logged in a way that is itself protected
 * from tampering.
 *
 * Two ideas run through this module.
 *
 * The first is that **a log line is an output channel like any other**. It is
 * shipped off the machine, retained for five years and read by operators who
 * are not the data controller. So redaction is not a courtesy applied by
 * whoever remembers — it is enforced on the way in, and a field that could
 * carry a secret or a personal number never reaches the sink at all. Relying on
 * call sites to remember is how a personal number ends up in a log that
 * outlives every access control around it (AGENTS.md rule 6).
 *
 * The second is that **uptime is not the thing worth measuring**. A signing
 * service can answer 200 to every request while no signature ever completes.
 * The metric vocabulary here is therefore built around outcomes — signings
 * started versus finished, queue age, provider failures — because those are the
 * signals that distinguish "working" from "responding".
 */

import type { UUID } from '../../contracts/src/index.js';

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/**
 * Field names that must never be logged, whatever they contain.
 *
 * A deny-list by *name* rather than by value, because by the time a value is in
 * hand it is too late to tell a password from any other string. Matching is on
 * a normalised name so `apiKey`, `api_key` and `API-KEY` all hit.
 */
const FORBIDDEN_FIELDS = [
  'password', 'passwd', 'secret', 'apikey', 'apisecret', 'token', 'accesstoken',
  'refreshtoken', 'authorization', 'cookie', 'setcookie', 'privatekey', 'clientsecret',
  'personalnumber', 'personnummer', 'ssn', 'pin', 'signature', 'documentcontent',
  'ciphertext', 'blindindex', 'qrstartsecret', 'autostarttoken', 'subscriptiontoken',
];

const REDACTED = '[redacted]';

function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isForbiddenLogField(name: string): boolean {
  const normalised = normaliseFieldName(name);
  return FORBIDDEN_FIELDS.some((forbidden) => normalised === forbidden || normalised.endsWith(forbidden));
}

/**
 * Values that look like a secret regardless of what the field is called.
 *
 * The name check catches the fields we thought of; this catches the ones we did
 * not, such as a personal number pasted into a free-text `note`. Both are
 * needed: neither is sufficient alone.
 */
const PERSONAL_NUMBER = /\b(?:19|20)?\d{6}[-+]?\d{4}\b/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

export function redactValue(value: string): string {
  return value
    .replace(PEM, REDACTED)
    .replace(JWT, REDACTED)
    .replace(BEARER, REDACTED)
    .replace(PERSONAL_NUMBER, REDACTED);
}

/**
 * Sanitises a payload before it reaches a sink.
 *
 * Recurses, because a secret nested three levels down is still a secret, and
 * caps depth so a cyclic or pathological structure cannot turn a log call into
 * an outage.
 */
export function sanitiseLogPayload(payload: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'string') return redactValue(payload);
  if (typeof payload === 'number' || typeof payload === 'boolean') return payload;
  if (Array.isArray(payload)) return payload.slice(0, 100).map((entry) => sanitiseLogPayload(entry, depth + 1));
  if (typeof payload !== 'object') return REDACTED;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    result[key] = isForbiddenLogField(key) ? REDACTED : sanitiseLogPayload(value, depth + 1);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Structured log records
 * ------------------------------------------------------------------ */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The correlation fields every record carries.
 *
 * `requestId` and `correlationId` are separate on purpose: a request is one
 * HTTP call, a correlation spans the whole business operation including the
 * worker jobs it spawns. Without the second one, tracing "this signing case
 * never completed" means joining logs by timestamp and hope.
 */
export interface LogContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly tenantId?: UUID;
  readonly actorId?: UUID;
  readonly signatureCaseId?: UUID;
  readonly signingIntentId?: UUID;
  readonly jobId?: UUID;
}

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly outcome: 'success' | 'failure' | 'pending';
  readonly durationMs?: number;
  readonly context: LogContext;
  readonly detail: Readonly<Record<string, unknown>>;
}

export function buildLogRecord(input: {
  readonly level: LogLevel;
  readonly event: string;
  readonly outcome: LogRecord['outcome'];
  readonly context: LogContext;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly durationMs?: number;
  readonly timestamp?: string;
}): LogRecord {
  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    level: input.level,
    event: input.event,
    outcome: input.outcome,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    // The context is sanitised too. An actorId is an internal UUID, but callers
    // have been known to put an email address there.
    context: sanitiseLogPayload(input.context) as LogContext,
    detail: sanitiseLogPayload(input.detail ?? {}) as Readonly<Record<string, unknown>>,
  };
}

/**
 * Security events that must always be logged (krav 3534).
 *
 * An explicit list rather than a convention, so that "we log security events"
 * is a checkable claim rather than an intention.
 */
export const SECURITY_EVENTS = [
  'auth.login.failed',
  'auth.login.succeeded',
  'auth.password.reset_requested',
  'auth.password.changed',
  'auth.session.revoked',
  'authorization.denied',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.deleted',
  'role.assigned',
  'role.revoked',
  'tenant.access.cross_tenant_attempt',
  'protected_identity.accessed',
  'retention.executed',
  'privacy.request.fulfilled',
  'key.rotation.started',
  'key.rotation.completed',
  'api_client.created',
  'api_client.revoked',
  'webhook.signature.invalid',
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

export function isSecurityEvent(event: string): event is SecurityEvent {
  return (SECURITY_EVENTS as readonly string[]).includes(event);
}

/**
 * A security event must be traceable to a tenant and, where there is one, an
 * actor. A security log that cannot answer "who, in which organisation" is a
 * record that something happened, not evidence.
 */
export function assertSecurityEventIsTraceable(record: LogRecord): void {
  if (!isSecurityEvent(record.event)) return;
  if (!record.context.tenantId && record.event !== 'auth.login.failed') {
    throw new Error(`Security event ${record.event} must carry a tenantId`);
  }
  if (!record.context.requestId || !record.context.correlationId) {
    throw new Error(`Security event ${record.event} must carry request and correlation identifiers`);
  }
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/**
 * The metric vocabulary. `signing.started` and `signing.completed` are the pair
 * that matters: the gap between them is the failure HTTP monitoring cannot see,
 * where the service answers normally and no signature is ever produced.
 */
export const METRICS = [
  'api.request.duration_ms',
  'api.request.errors',
  'signing.started',
  'signing.completed',
  'signing.failed',
  'signing.abandoned',
  'identity.provider.failures',
  'worker.queue.depth',
  'worker.job.age_seconds',
  'worker.job.failures',
  'webhook.delivery.failures',
  'webhook.dead_lettered',
  'validation.failures',
  'storage.errors',
] as const;
export type MetricName = (typeof METRICS)[number];

export interface MetricSample {
  readonly name: MetricName;
  readonly value: number;
  /** Tenant is a label so one customer's spike is visible on its own. */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Labels are restricted to a known set of low-cardinality keys.
 *
 * Not a style rule: a label containing a case ID or an email address creates a
 * separate time series per value, which both destroys the metrics backend and
 * quietly turns the metrics pipeline into an unredacted export of personal data.
 */
const ALLOWED_LABELS = new Set(['tenant', 'environment', 'provider', 'outcome', 'endpoint', 'queue', 'level']);

export function assertMetricLabelsAreSafe(sample: MetricSample): void {
  for (const [key, value] of Object.entries(sample.labels)) {
    if (!ALLOWED_LABELS.has(key)) {
      throw new Error(`Metric label ${key} is not allowed; labels must be low cardinality`);
    }
    if (PERSONAL_NUMBER.test(value)) {
      throw new Error(`Metric label ${key} carries what looks like a personal number`);
    }
  }
}

/**
 * Detects the failure mode uptime monitoring cannot: signings that start and
 * never reach an outcome. Compares completions against starts over a window
 * rather than instantaneously, since a signing legitimately takes minutes.
 */
export function stuckSigningRatio(started: number, completed: number, failed: number): number {
  if (started <= 0) return 0;
  const resolved = completed + failed;
  return Math.max(0, (started - resolved) / started);
}

/* ------------------------------------------------------------------ *
 * Security headers
 * ------------------------------------------------------------------ */

export interface SecurityHeaderOptions {
  /** Off outside production so local development over http still works. */
  readonly enableHsts: boolean;
  /** Extra origins the page may connect to, beyond itself. */
  readonly connectSources: readonly string[];
}

/**
 * The response headers every HTML and API response carries.
 *
 * The CSP has no `unsafe-inline` and no `unsafe-eval`, which is why the portals
 * ship no inline script or style — `scripts/build-portals.mjs` fails the build
 * if one appears, so the policy and the markup cannot drift apart.
 */
export function securityHeaders(options: SecurityHeaderOptions): Readonly<Record<string, string>> {
  const connect = ["'self'", ...options.connectSources].join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    // A signing page inside an iframe is a clickjacking target, so it may not
    // be framed at all, and it may not frame anything either.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');

  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // no-referrer, not the usual same-origin: an invitation URL carries a token,
    // and a referrer header would hand it to whatever the signer clicks next.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...(options.enableHsts
      ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload' }
      : {}),
  };
}

export type CacheClass = 'PUBLIC_CACHEABLE' | 'PRIVATE_CACHEABLE' | 'PRIVATE_NO_STORE' | 'SECRET_NEVER_CACHE';

/**
 * Cache headers by data class.
 *
 * `Vary: Cookie` on the private classes is the load-bearing part: without it an
 * intermediary can serve one authenticated user's response to the next, which
 * is a cross-tenant data leak caused entirely by a missing header.
 */
export function cacheHeaders(cacheClass: CacheClass): Readonly<Record<string, string>> {
  switch (cacheClass) {
    case 'PUBLIC_CACHEABLE':
      return { 'Cache-Control': 'public, max-age=300' };
    case 'PRIVATE_CACHEABLE':
      return { 'Cache-Control': 'private, max-age=60', Vary: 'Cookie, Authorization' };
    case 'PRIVATE_NO_STORE':
      return { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie, Authorization' };
    case 'SECRET_NEVER_CACHE':
      return {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
        Pragma: 'no-cache',
        Expires: '0',
        Vary: 'Cookie, Authorization',
      };
  }
}

/**
 * TLS floor (krav 2018). Kept as data rather than prose so a deployment check
 * can assert it, and so "at least TLS 1.2" is not a claim in a document that
 * nothing verifies.
 */
export const TLS_POLICY = {
  minimumVersion: 'TLSv1.2',
  preferredVersion: 'TLSv1.3',
  // Forward secrecy only: a recorded session must not become readable later if
  // the server key is compromised.
  allowedCipherSuites: [
    'TLS_AES_256_GCM_SHA384',
    'TLS_AES_128_GCM_SHA256',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-GCM-SHA256',
  ],
  forbidRenegotiation: true,
} as const;
