import type { TenantContext } from '../../contracts/src/index.js';

export interface QueryResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number; }
export interface SqlTransaction {
  query<Row = Readonly<Record<string, unknown>>>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<Row>>;
}
export interface SqlDatabase {
  transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}

/**
 * The key version new ciphertext is written under, for the `key_version` column
 * that migration data/0029 put on every table holding a ciphertext or a blind
 * index.
 *
 * Process-wide rather than per-request, because that is what it is: the active
 * key is a property of the deployment, not of whoever is calling. Set once at
 * startup from the sensitive-data adapter's ring; 1 until then, which is both
 * the column default and what every row written before the ring existed
 * carries.
 *
 * It is stamped by the database rather than by each INSERT on purpose. There
 * are dozens of write paths across the API and the workers, and a rotation that
 * is wrong because one of them forgot the column is a rotation that reports
 * itself complete while rows still hold the old key — the exact failure the
 * column was added to make impossible.
 */
let writingKeyVersion = 1;

export function setWritingKeyVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) throw new Error('WRITING_KEY_VERSION_INVALID');
  writingKeyVersion = version;
}

export function currentWritingKeyVersion(): number {
  return writingKeyVersion;
}

export async function withTenantTransaction<T>(
  database: SqlDatabase,
  context: TenantContext,
  actorKind: 'internal_user' | 'external_client' | 'worker' | 'trusted_service',
  work: (transaction: SqlTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.query("select set_config('app.tenant_id', $1, true)", [context.tenantId]);
    await transaction.query("select set_config('app.actor_kind', $1, true)", [actorKind]);
    await transaction.query("select set_config('app.actor_id', $1, true)", [context.subjectId]);
    await transaction.query("select set_config('app.request_id', $1, true)", [context.requestId]);
    await transaction.query("select set_config('app.auth_method', $1, true)", [context.authMethod]);
    await transaction.query("select set_config('app.key_version', $1, true)", [String(writingKeyVersion)]);
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
