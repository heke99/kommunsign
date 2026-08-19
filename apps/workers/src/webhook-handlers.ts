import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob } from './jobs.js';
import { assertResolvedWebhookAddresses, assertSafeWebhookUrl, signWebhook } from '../../../packages/webhooks/src/index.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import type { CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';

/**
 * Outbox-driven webhook delivery.
 *
 * The dispatch record is created by a database trigger in the same transaction
 * as the business event, so a delivery cannot be lost by a crash between "the
 * case completed" and "we told the subscriber". This handler's job is only to
 * carry an already-recorded intent to a remote system and record what happened.
 *
 * Two properties matter more than throughput here. Deliveries are idempotent per
 * (endpoint, event), so a retry after an ambiguous failure cannot produce a
 * second event for the subscriber to process. And every delivery is signed with
 * a secret the subscriber actually holds, so a receiver can tell our POST from
 * anyone else's.
 */

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

// The repository ships no @types/node, so Node built-ins are reached the way the
// rest of the codebase reaches them: a dynamic import behind a locally declared
// shape, which also keeps the module loadable in a non-Node runtime that never
// calls this path.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
interface DnsModule {
  lookup(hostname: string, options: { readonly all: true }): Promise<readonly { readonly address: string }[]>;
}

/** A subscriber that is slow is a subscriber we stop waiting for, not one we block on. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Enough of the response to diagnose a rejection, not enough to store their data. */
const MAX_RESPONSE_BYTES = 8 * 1024;

export interface WebhookServices {
  readonly userAgent: string;
  readonly http: typeof fetch;
  readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;
}

export function createWebhookServices(configuration: Readonly<Record<string, string>>): WebhookServices {
  return {
    userAgent: configuration.WEBHOOK_USER_AGENT?.trim() || 'Kommunsign-Webhooks/1',
    http: fetch,
    resolveAddresses: async (hostname: string) => {
      const dns = await dynamicImport('node:dns/promises') as DnsModule;
      return (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
    },
  };
}

interface EndpointRow {
  readonly id: string;
  readonly url: string;
  readonly active: boolean;
  readonly secret_current_ciphertext: Uint8Array | null;
}

interface EventRow {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly payload_sha256: string;
  readonly occurred_at: string | Date;
}

export function createWebhookJobHandlers(input: {
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
  readonly services: WebhookServices;
}): Readonly<Record<'WEBHOOK_DELIVER', (job: DurableJob) => Promise<void>>> {
  return {
    WEBHOOK_DELIVER: (job) => handleWebhookDeliver(input.dataDatabase, input.infrastructure, input.services, job),
  };
}

export async function handleWebhookDeliver(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: WebhookServices,
  job: DurableJob,
): Promise<void> {
  const outboxEventId = uuidPayload(job.payload, 'outboxEventId');

  const loaded = await tenant(database, job.tenantId, async (tx) => {
    const event = await tx.query<EventRow>(
      `select id,aggregate_type,aggregate_id,event_type,payload,payload_sha256,occurred_at
         from app.outbox_events where tenant_id=$1 and id=$2`,
      [job.tenantId, outboxEventId],
    );
    const endpoints = await tx.query<EndpointRow>(
      `select id,url,active,secret_current_ciphertext from app.webhook_endpoints
        where tenant_id=$1 and active and secret_current_ciphertext is not null
          and $2 = any(subscribed_events)
        order by created_at,id`,
      [job.tenantId, event.rows[0]?.event_type ?? ''],
    );
    return { event: event.rows[0], endpoints: endpoints.rows };
  });

  const event = requireRow(loaded.event, 'OUTBOX_EVENT_NOT_FOUND');
  if (loaded.endpoints.length === 0) {
    // Every subscriber was removed or deactivated after the event was written.
    // There is nothing to deliver and nothing wrong; the event is published.
    await markPublished(database, job.tenantId, outboxEventId);
    return;
  }

  // The last attempt is the one that must leave an accurate record. If the
  // handler simply threw here, the job would dead-letter and the delivery rows
  // would stay 'pending' forever, describing work that will never happen.
  const finalAttempt = job.attempts >= job.maximumAttempts;

  let outstanding = 0;
  for (const endpoint of loaded.endpoints) {
    const state = await claimDelivery(database, job.tenantId, endpoint.id, outboxEventId, job.attempts);
    if (state === 'terminal') continue;

    const result = await deliver(database, infrastructure, services, job.tenantId, endpoint, event);
    if (result.delivered) {
      await recordDelivered(database, job.tenantId, endpoint.id, outboxEventId, result);
      continue;
    }

    if (finalAttempt) {
      await recordDeadLetter(database, job.tenantId, endpoint.id, outboxEventId, result);
      continue;
    }
    await recordFailure(database, job.tenantId, endpoint.id, outboxEventId, result);
    outstanding += 1;
  }

  if (outstanding > 0) throw new Error(`WEBHOOK_DELIVERY_INCOMPLETE_${outstanding}`);
  await markPublished(database, job.tenantId, outboxEventId);
}

/**
 * Moves one delivery into 'delivering', creating it if this is the first attempt.
 *
 * Returns 'terminal' when the delivery already succeeded or was abandoned, so a
 * retry for one failing endpoint never re-sends to the endpoints that worked.
 */
async function claimDelivery(
  database: SqlDatabase,
  tenantId: string,
  endpointId: string,
  outboxEventId: string,
  attempt: number,
): Promise<'claimed' | 'terminal'> {
  return tenant(database, tenantId, async (tx) => {
    await tx.query(
      `insert into app.webhook_deliveries(tenant_id,webhook_endpoint_id,outbox_event_id,attempt,status,next_attempt_at)
       values($1,$2,$3,0,'pending',now())
       on conflict (tenant_id,webhook_endpoint_id,outbox_event_id) do nothing`,
      [tenantId, endpointId, outboxEventId],
    );
    const current = await tx.query<{ readonly status: string }>(
      `select status from app.webhook_deliveries
        where tenant_id=$1 and webhook_endpoint_id=$2 and outbox_event_id=$3 for update`,
      [tenantId, endpointId, outboxEventId],
    );
    const status = requireRow(current.rows[0], 'WEBHOOK_DELIVERY_NOT_FOUND').status;
    if (status === 'delivered' || status === 'dead_letter') return 'terminal';
    await tx.query(
      `update app.webhook_deliveries set status='delivering',attempt=$4
        where tenant_id=$1 and webhook_endpoint_id=$2 and outbox_event_id=$3`,
      [tenantId, endpointId, outboxEventId, attempt],
    );
    return 'claimed';
  });
}

interface DeliveryResult {
  readonly delivered: boolean;
  readonly responseStatus: number | null;
  readonly responseBodySha256: string | null;
  readonly errorCode: string;
}

async function deliver(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  services: WebhookServices,
  tenantId: string,
  endpoint: EndpointRow,
  event: EventRow,
): Promise<DeliveryResult> {
  let url;
  try {
    url = assertSafeWebhookUrl(endpoint.url);
    // The URL passed this check when it was registered. It is re-checked here
    // because DNS can be repointed at a private address long after registration,
    // which is the whole shape of a rebinding attack against an outbound sender.
    assertResolvedWebhookAddresses(await services.resolveAddresses(url.hostname));
  } catch (error) {
    return { delivered: false, responseStatus: null, responseBodySha256: null, errorCode: safeCode(error instanceof Error ? error.message : 'WEBHOOK_URL_REJECTED') };
  }

  const secret = await infrastructure.sensitiveData.decryptText(
    requireValue(endpoint.secret_current_ciphertext, 'WEBHOOK_SECRET_MISSING'), 'webhook.signing_secret');

  const envelope = {
    id: event.id,
    type: event.event_type,
    occurredAt: new Date(event.occurred_at).toISOString(),
    aggregate: { type: event.aggregate_type, id: event.aggregate_id },
    payloadSha256: event.payload_sha256,
    data: event.payload,
  };
  const signed = await signWebhook(envelope as unknown as CanonicalJsonValue, secret);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await services.http(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': services.userAgent,
        'x-kommunsign-event': event.event_type,
        'x-kommunsign-event-id': event.id,
        'x-kommunsign-timestamp': signed.timestamp,
        'x-kommunsign-signature': signed.signature,
        // Lets a receiver drop a replayed delivery without parsing the body.
        'x-kommunsign-delivery-id': `${endpoint.id}:${event.id}`,
      },
      body: signed.body,
      signal: controller.signal,
      redirect: 'manual',
    });

    const bodyBytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const truncated = bodyBytes.slice(0, MAX_RESPONSE_BYTES);
    const bodySha256 = truncated.byteLength > 0 ? await sha256Hex(truncated) : null;

    // A redirect is not followed. A subscriber that moved must update its
    // registered URL, because following a redirect would let a compromised DNS
    // or CDN entry send signed municipal events somewhere never registered.
    if (response.status >= 300 && response.status < 400) {
      return { delivered: false, responseStatus: response.status, responseBodySha256: bodySha256, errorCode: 'WEBHOOK_REDIRECT_NOT_FOLLOWED' };
    }
    if (response.ok) {
      return { delivered: true, responseStatus: response.status, responseBodySha256: bodySha256, errorCode: 'OK' };
    }
    return { delivered: false, responseStatus: response.status, responseBodySha256: bodySha256, errorCode: `WEBHOOK_HTTP_${response.status}` };
  } catch {
    // No exception text is stored: it can contain the subscriber's URL and, for
    // a TLS failure, parts of their certificate.
    return { delivered: false, responseStatus: null, responseBodySha256: null, errorCode: 'WEBHOOK_TRANSPORT_FAILED' };
  } finally {
    clearTimeout(timeout);
    void database;
    void tenantId;
  }
}

async function recordFailure(database: SqlDatabase, tenantId: string, endpointId: string, outboxEventId: string, result: DeliveryResult): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(
      `update app.webhook_deliveries
          set status='failed',response_status=$4,response_body_sha256=$5,next_attempt_at=now()
        where tenant_id=$1 and webhook_endpoint_id=$2 and outbox_event_id=$3`,
      [tenantId, endpointId, outboxEventId, result.responseStatus, result.responseBodySha256],
    );
    await audit(tx, tenantId, 'TECHNICAL', 'webhook.delivery_failed', 'webhook_endpoint', endpointId, {
      outboxEventId, responseStatus: result.responseStatus, errorCode: result.errorCode,
    });
  });
}

async function recordDeadLetter(database: SqlDatabase, tenantId: string, endpointId: string, outboxEventId: string, result: DeliveryResult): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(
      `update app.webhook_deliveries
          set status='dead_letter',response_status=$4,response_body_sha256=$5
        where tenant_id=$1 and webhook_endpoint_id=$2 and outbox_event_id=$3`,
      [tenantId, endpointId, outboxEventId, result.responseStatus, result.responseBodySha256],
    );
    await audit(tx, tenantId, 'TECHNICAL', 'webhook.dead_lettered', 'webhook_endpoint', endpointId, {
      outboxEventId, responseStatus: result.responseStatus, errorCode: result.errorCode,
    });
  });
}

async function recordDelivered(database: SqlDatabase, tenantId: string, endpointId: string, outboxEventId: string, result: DeliveryResult): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(
      `update app.webhook_deliveries
          set status='delivered',response_status=$4,response_body_sha256=$5,delivered_at=now()
        where tenant_id=$1 and webhook_endpoint_id=$2 and outbox_event_id=$3`,
      [tenantId, endpointId, outboxEventId, result.responseStatus, result.responseBodySha256],
    );
    await audit(tx, tenantId, 'TECHNICAL', 'webhook.delivered', 'webhook_endpoint', endpointId, {
      outboxEventId, responseStatus: result.responseStatus,
    });
  });
}

/**
 * Marks the event published once no endpoint is still waiting on it.
 *
 * published_at means "we are done trying", not "everyone accepted it". A
 * dead-lettered delivery is a finished attempt, and leaving the event unpublished
 * because one subscriber is permanently broken would make the outbox grow
 * without bound.
 */
async function markPublished(database: SqlDatabase, tenantId: string, outboxEventId: string): Promise<void> {
  await tenant(database, tenantId, async (tx) => {
    await tx.query(
      `update app.outbox_events set published_at=now()
        where tenant_id=$1 and id=$2 and published_at is null
          and not exists (
            select 1 from app.webhook_deliveries d
            where d.tenant_id=$1 and d.outbox_event_id=$2 and d.status in ('pending','delivering','failed')
          )`,
      [tenantId, outboxEventId],
    );
  });
}

async function tenant<T>(database: SqlDatabase, tenantId: string, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, workerContext(tenantId), 'worker', work);
}
function workerContext(tenantId: string): TenantContext {
  return { tenantId, subjectId: SYSTEM_ACTOR_ID, requestId: crypto.randomUUID(), authMethod: 'worker', source: 'deployment' };
}
async function audit(tx: SqlTransaction, tenantId: string, category: 'TECHNICAL' | 'BUSINESS', eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`select audit.append_event($1,$2,$3,'worker',$4,$5,$6,$7::jsonb,now())`, [tenantId, category, eventType, SYSTEM_ACTOR_ID, resourceType, resourceId, payload]);
}
function uuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  }
  return value;
}
function requireRow<T>(row: T | undefined, code: string): T { if (!row) throw permanent(code); return row; }
function requireValue<T>(value: T | null | undefined, code: string): T { if (value === null || value === undefined) throw permanent(code); return value; }
function permanent(code: string): Error { const error = new Error(safeCode(code)); error.name = 'PermanentWorkerError'; return error; }
function safeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'WEBHOOK_ERROR'; }
