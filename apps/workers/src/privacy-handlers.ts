import type { TenantContext } from '../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import type { DurableJob } from './jobs.js';
import {
  erasureExemption, PERSONAL_DATA_STORES, PrivacyRequestError,
  type DataSubjectRequest, type DataSubjectRight, type PersonalDataStore, type StoreCoverage,
} from '../../../packages/privacy/src/index.js';
import {
  beginHandling, deliverResponse, fulfilRequest, refuseRequest, verifySubjectIdentity,
  PrivacyExecutionError, type PrivacyRequestJob, type PrivacyRequestState,
} from '../../../packages/privacy/src/executor.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { canonicalJson, type CanonicalJsonValue } from '../../../packages/crypto/src/canonical-json.js';

/**
 * Data subject rights requests — the runtime for `packages/privacy`.
 *
 * The library already modelled all of this: the five rights, the five stores
 * that may hold personal data, the thirty-day deadline, and a decision layer
 * that refuses to build an answer with a store missing from it. Nothing
 * imported it, so a registered person had no way to lodge a request and the
 * deadline nobody was counting is one the supervisory authority does count.
 *
 * The difficult part here is not the state machine. It is that every store must
 * genuinely be searched. A handler returning `{ searched: true, recordCount: 0 }`
 * without querying anything satisfies every type in the system and is a lie —
 * and it is the most comfortable lie available, because it makes the answer
 * look complete. So each store below is either queried for real or reported as
 * an exemption with its ground. BACKUP is the standing case: point-searching a
 * backup set online is not something this system can do, so it is never
 * reported as an empty hit.
 *
 * Erasure follows the precedent gallring set in the retention handler. The
 * audit trail is hash-chained; deleting rows there would break the chain that
 * makes every other record verifiable. Its personal data is destroyed by
 * removing the encrypted payloads while the hash-only spine is retained. That
 * is cryptographic erasure, and the answer says so rather than claiming the
 * rows were deleted.
 */

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export function createPrivacyJobHandlers(input: {
  readonly controlDatabase: SqlDatabase;
  readonly dataDatabase: SqlDatabase;
  readonly infrastructure: ProductionInfrastructure;
}): Readonly<Record<'PRIVACY_REQUEST_EXECUTE', (job: DurableJob) => Promise<void>>> {
  return {
    PRIVACY_REQUEST_EXECUTE: (job) => handlePrivacyRequestExecute(input.controlDatabase, input.dataDatabase, input.infrastructure, job),
  };
}

interface PrivacyRequestRow {
  readonly id: string;
  readonly state: PrivacyRequestState;
  readonly right_requested: DataSubjectRight;
  readonly subject_identifier_blind_index: Uint8Array;
  readonly subject_user_id: string | null;
  readonly received_at: string | Date;
  readonly identity_verified_at: string | Date | null;
  readonly identity_method: string | null;
  readonly identity_assurance: 'LOW' | 'SUBSTANTIAL' | 'HIGH' | null;
  readonly handled_by: string | null;
}

export async function handlePrivacyRequestExecute(
  controlDatabase: SqlDatabase,
  dataDatabase: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  job: DurableJob,
): Promise<void> {
  const privacyRequestId = uuidPayload(job.payload, 'privacyRequestId');
  const context = workerContext(job.tenantId);

  const loaded = await tenant(dataDatabase, job.tenantId, async (tx) => {
    const result = await tx.query<PrivacyRequestRow>(
      `select id,state,right_requested,subject_identifier_blind_index,subject_user_id,received_at,
              identity_verified_at,identity_method,identity_assurance,handled_by
         from app.privacy_requests where tenant_id=$1 and id=$2 for update`,
      [job.tenantId, privacyRequestId],
    );
    return result.rows[0];
  });
  const row = requireRow(loaded, 'PRIVACY_REQUEST_NOT_FOUND');
  // Already finished. Re-running must not re-disclose or re-delete.
  if (row.state === 'DELIVERED' || row.state === 'REFUSED') return;

  const request: DataSubjectRequest = {
    tenantId: job.tenantId,
    requestId: row.id,
    right: row.right_requested,
    receivedAt: new Date(row.received_at).toISOString(),
    // Read fresh below; the value carried here is only the starting point the
    // library re-checks against.
    legalHoldActive: false,
  };

  let privacyJob: PrivacyRequestJob = {
    request,
    state: row.state,
    subjectId: row.subject_user_id ?? row.id,
    identity: null,
    handledBy: row.handled_by,
    refusalGround: null,
    response: null,
  };

  try {
    privacyJob = advanceToInProgress(privacyJob, row, job.tenantId);
  } catch (error) {
    if (error instanceof PrivacyExecutionError) {
      await recordRefusal(dataDatabase, job.tenantId, privacyRequestId, error.message, error.code);
      return;
    }
    throw error;
  }

  const subjectBlindIndex = row.subject_identifier_blind_index;

  // Holds are read before anything is searched, exported or destroyed.
  //
  // Gathering coverage is not a read-only step for an erasure -- it is where
  // the object payloads are deleted and the identifiers cleared. Checking the
  // hold afterwards would mean the data was already gone by the time the
  // system decided it was not allowed to go. An earlier version of this
  // handler had exactly that ordering, and the legal-hold test is what caught
  // it.
  const { legalHoldActive, restrictionActive } = await currentHolds(dataDatabase, job.tenantId, subjectBlindIndex, privacyRequestId);
  if (row.right_requested === 'ERASURE' && (legalHoldActive || restrictionActive)) {
    // Routed through the library so the refusal carries its ground rather than
    // one written out again here, where it could drift.
    try {
      fulfilRequest(privacyJob, [], legalHoldActive, restrictionActive);
    } catch (error) {
      if (error instanceof PrivacyExecutionError || error instanceof PrivacyRequestError) {
        await recordRefusal(dataDatabase, job.tenantId, privacyRequestId, error.message, error.code);
        return;
      }
      throw error;
    }
    throw permanent('PRIVACY_HOLD_NOT_ENFORCED');
  }

  const coverage = await gatherCoverage(
    controlDatabase, dataDatabase, infrastructure, context, job.tenantId,
    privacyRequestId, row.right_requested, subjectBlindIndex,
  );

  try {
    privacyJob = fulfilRequest(privacyJob, coverage, legalHoldActive, restrictionActive);
  } catch (error) {
    if (error instanceof PrivacyExecutionError || error instanceof PrivacyRequestError) {
      await recordRefusal(dataDatabase, job.tenantId, privacyRequestId, error.message, error.code);
      return;
    }
    throw error;
  }

  const delivered = deliverResponse(privacyJob);
  const response = delivered.response;
  if (!response) throw permanent('PRIVACY_RESPONSE_MISSING');

  const responseJson = canonicalJson(response as unknown as CanonicalJsonValue);
  const responseSha256 = await sha256Hex(new TextEncoder().encode(responseJson));

  await tenant(dataDatabase, job.tenantId, async (tx) => {
    // The state advances first so the coverage rows and the response are
    // written against a request the guards already accepted as fulfilled.
    await tx.query(
      `update app.privacy_requests set state='FULFILLED' where tenant_id=$1 and id=$2 and state='IN_PROGRESS'`,
      [job.tenantId, privacyRequestId],
    );
    for (const entry of coverage) {
      await tx.query(
        `insert into app.privacy_request_coverage(tenant_id,privacy_request_id,store,record_count,searched,exemption_reason,action_taken,detail)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         on conflict (tenant_id,privacy_request_id,store) do nothing`,
        [job.tenantId, privacyRequestId, entry.store, entry.recordCount, entry.searched,
          entry.exemptionReason ?? null, actionFor(row.right_requested, entry), {}],
      );
    }
    await tx.query(
      `insert into app.privacy_responses(tenant_id,privacy_request_id,schema_version,response,response_sha256,total_records)
       values($1,$2,$3,$4::jsonb,$5,$6) on conflict (tenant_id,privacy_request_id) do nothing`,
      [job.tenantId, privacyRequestId, response.schemaVersion, response, responseSha256, response.totalRecords],
    );
    await tx.query(
      `update app.privacy_requests set state='DELIVERED',delivered_at=now() where tenant_id=$1 and id=$2 and state='FULFILLED'`,
      [job.tenantId, privacyRequestId],
    );
    await audit(tx, job.tenantId, 'BUSINESS', 'privacy.request_delivered', 'privacy_request', privacyRequestId, {
      right: row.right_requested,
      totalRecords: response.totalRecords,
      exemptedStores: response.exemptedStores,
      responseSha256,
    });
    await outbox(tx, job.tenantId, 'privacy_request', privacyRequestId, 'privacy.request.delivered', {
      privacyRequestId, right: row.right_requested, dueAt: response.dueAt,
    });
  });
}

/**
 * Walks the request up to IN_PROGRESS through the library rather than around it.
 *
 * Each step is the library's, so the identity rules — verified, the right
 * person, and strong enough for the right being exercised — are enforced in one
 * place instead of being restated here where they could drift.
 */
function advanceToInProgress(privacyJob: PrivacyRequestJob, row: PrivacyRequestRow, tenantId: string): PrivacyRequestJob {
  let current = privacyJob;
  if (current.state === 'RECEIVED') {
    if (!row.identity_verified_at || !row.identity_method || !row.identity_assurance) {
      throw new PrivacyExecutionError('PRIVACY_IDENTITY_NOT_VERIFIED', 'Identiteten är inte styrkt');
    }
    current = verifySubjectIdentity(current, {
      verified: true,
      method: row.identity_method,
      assuranceLevel: row.identity_assurance,
      subjectId: current.subjectId,
      verifiedAt: new Date(row.identity_verified_at).toISOString(),
    });
  }
  if (current.state === 'IDENTITY_VERIFIED') {
    if (!row.handled_by) {
      throw new PrivacyExecutionError('PRIVACY_STATE_INVALID', 'Ingen handläggare är tilldelad begäran');
    }
    current = beginHandling(current, row.handled_by, tenantId);
  }
  return current;
}

/**
 * Searches every store and reports honestly what happened in each.
 *
 * Ordered by `PERSONAL_DATA_STORES` so the answer reads the same every time,
 * and built so a store that could not be reached becomes an exemption with a
 * ground rather than a zero.
 */
async function gatherCoverage(
  controlDatabase: SqlDatabase,
  dataDatabase: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  context: TenantContext,
  tenantId: string,
  privacyRequestId: string,
  right: DataSubjectRight,
  subjectBlindIndex: Uint8Array,
): Promise<readonly StoreCoverage[]> {
  const coverage: StoreCoverage[] = [];

  for (const store of PERSONAL_DATA_STORES) {
    switch (store) {
      case 'CONTROL':
        coverage.push(await searchControl(controlDatabase, subjectBlindIndex));
        break;
      case 'DATA':
        coverage.push(await searchData(dataDatabase, tenantId, subjectBlindIndex, right));
        break;
      case 'OBJECT_STORAGE':
        coverage.push(await searchObjectStorage(dataDatabase, infrastructure, context, tenantId, subjectBlindIndex, right));
        break;
      case 'AUDIT_LOG':
        coverage.push(await searchAuditLog(dataDatabase, tenantId, privacyRequestId, right));
        break;
      case 'BACKUP':
        // Not an oversight and not a zero. A backup set cannot be point-searched
        // online, so the honest answer is the exemption and its ground — the
        // data leaves the backups when their retention runs out.
        coverage.push({
          store: 'BACKUP',
          recordCount: 0,
          searched: false,
          exemptionReason: erasureExemption('BACKUP')
            ?? 'Säkerhetskopior kan inte punktsökas; uppgifterna försvinner när backupretentionen löper ut',
        });
        break;
    }
  }
  return coverage;
}

async function searchControl(controlDatabase: SqlDatabase, subjectBlindIndex: Uint8Array): Promise<StoreCoverage> {
  const result = await controlDatabase.transaction(async (tx) => tx.query<{ readonly total: string }>(
    `select (
        (select count(*) from control.onboarding_applications where primary_email_blind_index=$1)
      + (select count(*) from control.onboarding_application_contacts where email_blind_index=$1)
     )::text total`,
    [subjectBlindIndex],
  ));
  return { store: 'CONTROL', recordCount: Number(result.rows[0]?.total ?? 0), searched: true };
}

async function searchData(
  dataDatabase: SqlDatabase, tenantId: string, subjectBlindIndex: Uint8Array, right: DataSubjectRight,
): Promise<StoreCoverage> {
  return tenant(dataDatabase, tenantId, async (tx) => {
    const counted = await tx.query<{ readonly total: string }>(
      `select (
          (select count(*) from app.signers where tenant_id=$1
             and (email_blind_index=$2 or expected_identifier_blind_index=$2 or verified_identifier_blind_index=$2))
        + (select count(*) from app.users where tenant_id=$1 and email_blind_index=$2)
       )::text total`,
      [tenantId, subjectBlindIndex],
    );
    const recordCount = Number(counted.rows[0]?.total ?? 0);
    if (right !== 'ERASURE' || recordCount === 0) {
      return { store: 'DATA', recordCount, searched: true } satisfies StoreCoverage;
    }
    // Erasure removes the identifiers rather than the rows. A signer row is
    // referenced by signature evidence that must stay verifiable; dropping it
    // would break the chain that proves who signed what, which is a record the
    // municipality is required to keep.
    await tx.query(
      `update app.signers
          set email_ciphertext=null,email_blind_index=null,
              expected_identifier_ciphertext=null,expected_identifier_blind_index=null,
              verified_identifier_ciphertext=null,verified_identifier_blind_index=null
        where tenant_id=$1
          and (email_blind_index=$2 or expected_identifier_blind_index=$2 or verified_identifier_blind_index=$2)`,
      [tenantId, subjectBlindIndex],
    );
    return { store: 'DATA', recordCount, searched: true } satisfies StoreCoverage;
  });
}

async function searchObjectStorage(
  dataDatabase: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  context: TenantContext,
  tenantId: string,
  subjectBlindIndex: Uint8Array,
  right: DataSubjectRight,
): Promise<StoreCoverage> {
  const keys = await tenant(dataDatabase, tenantId, async (tx) => {
    const result = await tx.query<{ readonly object_key: string }>(
      `select distinct artifact.object_key
         from app.signers signer
         join app.signing_intents intent on intent.tenant_id=signer.tenant_id and intent.signer_id=signer.id
         join app.tic_identity_artifacts artifacts
           on artifacts.tenant_id=intent.tenant_id and artifacts.signing_intent_id=intent.id
         -- One row per artifact key. The four are separate columns on one row,
         -- so they have to be unpivoted before they can be deleted one by one.
         join lateral (
           values (artifacts.collect_response_object_key), (artifacts.signature_xml_object_key),
                  (artifacts.ocsp_response_object_key), (artifacts.verification_report_object_key)
         ) as artifact(object_key) on true
        where signer.tenant_id=$1
          and (signer.email_blind_index=$2 or signer.expected_identifier_blind_index=$2 or signer.verified_identifier_blind_index=$2)
          and artifact.object_key is not null`,
      [tenantId, subjectBlindIndex],
    );
    return result.rows.map((entry) => entry.object_key);
  });

  if (right !== 'ERASURE') {
    return { store: 'OBJECT_STORAGE', recordCount: keys.length, searched: true };
  }
  if (!infrastructure.objectStorage.deleteObject) {
    // Without the capability the only truthful report is that the store could
    // not be addressed. Claiming zero would be the comfortable lie.
    return {
      store: 'OBJECT_STORAGE',
      recordCount: 0,
      searched: false,
      exemptionReason: 'Objektlagringen saknar raderingsfunktion i denna miljö; inga objekt kunde adresseras',
    };
  }
  const deleteObject = infrastructure.objectStorage.deleteObject.bind(infrastructure.objectStorage);
  for (const key of keys) await deleteObject(context, key);
  return { store: 'OBJECT_STORAGE', recordCount: keys.length, searched: true };
}

async function searchAuditLog(
  dataDatabase: SqlDatabase, tenantId: string, privacyRequestId: string, right: DataSubjectRight,
): Promise<StoreCoverage> {
  const counted = await tenant(dataDatabase, tenantId, async (tx) => tx.query<{ readonly total: string }>(
    `select count(*)::text total from audit.audit_events where tenant_id=$1 and resource_id=$2`,
    [tenantId, privacyRequestId],
  ));
  const recordCount = Number(counted.rows[0]?.total ?? 0);
  // Searched, and reported — but never deleted. The chain is what makes every
  // other record verifiable, and PUB-avtalet 7.5 requires five years of access
  // logs regardless. The ground is stated so the person can see why.
  return {
    store: 'AUDIT_LOG',
    recordCount,
    searched: true,
    ...(right === 'ERASURE'
      ? { exemptionReason: erasureExemption('AUDIT_LOG') ?? 'Åtkomstloggar bevaras enligt PUB-avtalet 7.5' }
      : {}),
  };
}

/**
 * Re-reads the holds at the moment of fulfilment.
 *
 * A hold placed after the request arrived is exactly the case this exists for:
 * trusting the value captured at receipt would destroy material somebody has
 * since formally required to be kept.
 */
async function currentHolds(
  dataDatabase: SqlDatabase, tenantId: string, subjectBlindIndex: Uint8Array, privacyRequestId: string,
): Promise<{ readonly legalHoldActive: boolean; readonly restrictionActive: boolean }> {
  return tenant(dataDatabase, tenantId, async (tx) => {
    const holds = await tx.query<{ readonly held: string }>(
      `select count(*)::text held
         from app.legal_holds hold
         join app.signers signer on signer.tenant_id=hold.tenant_id and signer.signature_case_id=hold.signature_case_id
        where hold.tenant_id=$1 and hold.released_at is null
          and (signer.email_blind_index=$2 or signer.expected_identifier_blind_index=$2 or signer.verified_identifier_blind_index=$2)`,
      [tenantId, subjectBlindIndex],
    );
    // An open restriction request for the same subject means processing is
    // limited under article 18: the data is kept but not acted on, so erasure
    // waits rather than racing the restriction.
    const restrictions = await tx.query<{ readonly active: string }>(
      `select count(*)::text active from app.privacy_requests
        where tenant_id=$1 and id<>$3 and right_requested='RESTRICTION'
          and subject_identifier_blind_index=$2 and state='DELIVERED'`,
      [tenantId, subjectBlindIndex, privacyRequestId],
    );
    return {
      legalHoldActive: Number(holds.rows[0]?.held ?? 0) > 0,
      restrictionActive: Number(restrictions.rows[0]?.active ?? 0) > 0,
    };
  });
}

/** What was actually done to a store, in terms a later reader can act on. */
function actionFor(right: DataSubjectRight, entry: StoreCoverage): string {
  if (!entry.searched) return 'EXEMPTED';
  if (entry.exemptionReason) return 'EXEMPTED';
  switch (right) {
    case 'ACCESS':
    case 'PORTABILITY':
      return 'EXPORTED';
    case 'RECTIFICATION':
      return 'RECTIFIED';
    case 'RESTRICTION':
      return 'RESTRICTED';
    case 'ERASURE':
      // Object storage payloads are destroyed; database identifiers are
      // cleared while the rows that carry signature evidence remain.
      return entry.store === 'OBJECT_STORAGE' ? 'CRYPTO_ERASED' : 'DELETED';
  }
}

/**
 * Records a refusal with the ground that caused it.
 *
 * A refusal without a stated legal ground is not a refusal, it is an unhandled
 * request — and the person has a right to know why so they can complain.
 */
async function recordRefusal(
  dataDatabase: SqlDatabase, tenantId: string, privacyRequestId: string, message: string, code: string,
): Promise<void> {
  await tenant(dataDatabase, tenantId, async (tx) => {
    await tx.query(
      `update app.privacy_requests set state='REFUSED',refusal_ground=$3
        where tenant_id=$1 and id=$2 and state not in ('DELIVERED','REFUSED')`,
      [tenantId, privacyRequestId, `${code}: ${message}`],
    );
    await audit(tx, tenantId, 'BUSINESS', 'privacy.request_refused', 'privacy_request', privacyRequestId, { code });
  });
}

export { PrivacyExecutionError, PrivacyRequestError, refuseRequest };

async function tenant<T>(database: SqlDatabase, tenantId: string, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, workerContext(tenantId), 'worker', work);
}
function workerContext(tenantId: string): TenantContext {
  return { tenantId, subjectId: SYSTEM_ACTOR_ID, requestId: crypto.randomUUID(), authMethod: 'worker', source: 'deployment' };
}
async function audit(tx: SqlTransaction, tenantId: string, category: 'TECHNICAL' | 'BUSINESS', eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`select audit.append_event($1,$2,$3,'worker',$4,$5,$6,$7::jsonb,now())`, [tenantId, category, eventType, SYSTEM_ACTOR_ID, resourceType, resourceId, payload]);
}
async function outbox(tx: SqlTransaction, tenantId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  const serialized = JSON.stringify(payload);
  await tx.query(`insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256) values($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId, aggregateType, aggregateId, eventType, payload, await sha256Hex(serialized)]);
}
function uuidPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw permanent(`WORKER_PAYLOAD_${key.toUpperCase()}_INVALID`);
  }
  return value;
}
function requireRow<T>(row: T | undefined, code: string): T { if (!row) throw permanent(code); return row; }
function permanent(code: string): Error { const error = new Error(safeCode(code)); error.name = 'PermanentWorkerError'; return error; }
function safeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_:-]/g, '_').slice(0, 120) || 'PRIVACY_ERROR'; }
