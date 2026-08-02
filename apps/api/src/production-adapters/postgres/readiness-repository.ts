import type { SqlDatabase } from '../../../../../packages/database/src/index.js';

export interface ReadinessSnapshotView {
  readonly id: string;
  readonly tenantId: string;
  readonly environment: 'test' | 'production';
  readonly ready: boolean;
  readonly blockingChecks: readonly unknown[];
  readonly warningChecks: readonly unknown[];
  readonly completedChecks: readonly unknown[];
  readonly checkedBy: string;
  readonly checkedAt: string;
}

export function createReadinessRepository(database: SqlDatabase): {
  latest(tenantId: string, environment: ReadinessSnapshotView['environment']): Promise<ReadinessSnapshotView | null>;
} {
  return {
    async latest(tenantId, environment) {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{
          readonly id: string;
          readonly tenant_id: string;
          readonly environment: ReadinessSnapshotView['environment'];
          readonly ready: boolean;
          readonly blocking_checks: readonly unknown[];
          readonly warning_checks: readonly unknown[];
          readonly completed_checks: readonly unknown[];
          readonly checked_by: string;
          readonly checked_at: Date | string;
        }>(
          `select id,tenant_id,environment,ready,blocking_checks,warning_checks,
                  completed_checks,checked_by,checked_at
             from control.tenant_readiness_results
            where tenant_id=$1
              and environment=$2
            order by checked_at desc,id desc
            limit 1`,
          [tenantId, environment],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          id: row.id,
          tenantId: row.tenant_id,
          environment: row.environment,
          ready: row.ready,
          blockingChecks: row.blocking_checks,
          warningChecks: row.warning_checks,
          completedChecks: row.completed_checks,
          checkedBy: row.checked_by,
          checkedAt: new Date(row.checked_at).toISOString(),
        };
      });
    },
  };
}
