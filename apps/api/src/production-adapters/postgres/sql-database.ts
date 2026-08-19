import type { QueryResult, SqlDatabase, SqlTransaction } from '../../../../../packages/database/src/index.js';

interface PostgresResult<Row> extends Array<Row> { readonly count?: number; }
interface PostgresTransaction {
  unsafe<Row = Readonly<Record<string, unknown>>>(query: string, parameters?: readonly unknown[]): Promise<PostgresResult<Row>>;
}
interface PostgresClient extends PostgresTransaction {
  begin<T>(work: (transaction: PostgresTransaction) => Promise<T>): Promise<T>;
  end(options?: { readonly timeout?: number }): Promise<void>;
}
type PostgresFactory = (connection: string, options?: Readonly<Record<string, unknown>>) => PostgresClient;

export interface PostgresDatabase extends SqlDatabase {
  readonly close: () => Promise<void>;
  readonly healthCheck: () => Promise<void>;
}

export interface PostgresPoolOptions {
  /** Maximum pooled connections. Right-size this: a pool that only enqueues does not need 20. */
  readonly maximumConnections?: number;
  /** Seconds an idle connection is kept. Too low and every poll re-authenticates against the pooler. */
  readonly idleTimeoutSeconds?: number;
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('POSTGRES_POOL_OPTION_INVALID');
  return value;
}

export async function createPostgresDatabase(
  connectionUrl: string,
  applicationName: string,
  poolOptions: PostgresPoolOptions = {},
): Promise<PostgresDatabase> {
  if (!/^postgres(?:ql)?:\/\//.test(connectionUrl)) throw new Error('POSTGRES_CONNECTION_URL_INVALID');
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ readonly default?: PostgresFactory }>;
  let factory: PostgresFactory;
  try {
    const module = await dynamicImport('postgres');
    if (typeof module.default !== 'function') throw new Error('POSTGRES_DRIVER_EXPORT_INVALID');
    factory = module.default;
  } catch (cause) {
    throw new Error('POSTGRES_DRIVER_NOT_INSTALLED', { cause });
  }
  const client = factory(connectionUrl, {
    max: boundedOption(poolOptions.maximumConnections, 20, 1, 100),
    // A 20 second idle timeout meant connections were continuously dropped and re-established,
    // which is what produced 77k pgbouncer.get_auth calls per database in production. Holding
    // them for five minutes keeps the pool warm without outliving max_lifetime credential rotation.
    idle_timeout: boundedOption(poolOptions.idleTimeoutSeconds, 300, 5, 1800),
    connect_timeout: 15,
    max_lifetime: 60 * 30,
    application_name: applicationName,
    prepare: true,
    transform: { undefined: null },
  });

  const database: PostgresDatabase = {
    async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
      return client.begin(async (transaction) => work({
        async query<Row = Readonly<Record<string, unknown>>>(query: string, parameters: readonly unknown[] = []): Promise<QueryResult<Row>> {
          const rows = await transaction.unsafe<Row>(query, parameters);
          return { rows, rowCount: rows.count ?? rows.length };
        },
      }));
    },
    async healthCheck(): Promise<void> {
      const rows = await client.unsafe<{ readonly ok: number }>('select 1::int as ok');
      if (rows[0]?.ok !== 1) throw new Error('POSTGRES_HEALTH_CHECK_FAILED');
    },
    async close(): Promise<void> { await client.end({ timeout: 5 }); },
  };
  await database.healthCheck();
  return database;
}
