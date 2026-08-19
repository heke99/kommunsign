import type { TenantContext } from '../../contracts/src/index.js';

export interface QueryResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number; }
export interface SqlTransaction {
  query<Row = Readonly<Record<string, unknown>>>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<Row>>;
}
export interface SqlDatabase {
  transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}

export const TENANT_CONTEXT_SQL =
  "select set_config('app.tenant_id', $1, true), set_config('app.actor_kind', $2, true), " +
  "set_config('app.actor_id', $3, true), set_config('app.request_id', $4, true), " +
  "set_config('app.auth_method', $5, true)";

export async function withTenantTransaction<T>(
  database: SqlDatabase,
  context: TenantContext,
  actorKind: 'internal_user' | 'external_client' | 'worker' | 'trusted_service',
  work: (transaction: SqlTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    // One round trip instead of five. Every setting stays transaction-local (is_local = true)
    // and is applied before work() runs, so RLS policies and audit guards read the same values
    // through current_setting() as they did when these were issued separately.
    await transaction.query(TENANT_CONTEXT_SQL, [
      context.tenantId,
      actorKind,
      context.subjectId,
      context.requestId,
      context.authMethod,
    ]);
    return work(transaction);
  });
}

export async function assertIdempotency(
  transaction: SqlTransaction,
  tenantId: string,
  apiClientId: string,
  key: string,
  method: string,
  path: string,
  payloadSha256: string,
): Promise<'created' | 'replay'> {
  const inserted = await transaction.query<{ request_payload_sha256: string }>(
    `insert into app.api_idempotency_keys
      (tenant_id,api_client_id,idempotency_key,request_method,request_path,request_payload_sha256,expires_at)
     values ($1,$2,$3,$4,$5,$6,now()+interval '24 hours')
     on conflict (tenant_id,api_client_id,idempotency_key) do nothing
     returning request_payload_sha256`,
    [tenantId, apiClientId, key, method, path, payloadSha256],
  );
  if (inserted.rowCount === 1) return 'created';

  const existing = await transaction.query<{ request_payload_sha256: string; request_method: string; request_path: string }>(
    `select request_payload_sha256, request_method, request_path from app.api_idempotency_keys
     where tenant_id = $1 and api_client_id = $2 and idempotency_key = $3 for update`,
    [tenantId, apiClientId, key],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('IDEMPOTENCY_STATE_LOST');
  if (row.request_payload_sha256 !== payloadSha256 || row.request_method !== method || row.request_path !== path) {
    throw new Error('IDEMPOTENCY_CONFLICT');
  }
  return 'replay';
}
