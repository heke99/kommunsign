import type { SqlDatabase } from '../../../../../packages/database/src/index.js';

export interface ActivationRequestView {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly readinessSnapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export function createActivationRepository(database: SqlDatabase): {
  latestForTenant(tenantId: string): Promise<ActivationRequestView | null>;
} {
  return {
    async latestForTenant(tenantId) {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{
          readonly id: string;
          readonly tenant_id: string;
          readonly application_id: string;
          readonly status: string;
          readonly requested_by: string;
          readonly readiness_snapshot: Readonly<Record<string, unknown>>;
          readonly created_at: Date | string;
        }>(
          `select id,tenant_id,application_id,status,requested_by,readiness_snapshot,created_at
             from control.tenant_activation_requests
            where tenant_id=$1
            order by created_at desc,id desc
            limit 1`,
          [tenantId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          id: row.id,
          tenantId: row.tenant_id,
          applicationId: row.application_id,
          status: row.status,
          requestedBy: row.requested_by,
          readinessSnapshot: row.readiness_snapshot,
          createdAt: new Date(row.created_at).toISOString(),
        };
      });
    },
  };
}
