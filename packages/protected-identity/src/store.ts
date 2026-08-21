import type { SqlTransaction } from '../../database/src/index.js';
import type { ConfidentialityAssessment } from './index.js';

/**
 * The recorded menprövning for a signer, or null.
 *
 * `decideDisclosure` takes an assessment rather than looking one up, because it
 * has to stay a pure decision that a test can drive. This is the one place that
 * turns the table into that argument, so that every channel asks the same
 * question of the same rows: not revoked, not expired, and with a ground.
 *
 * The expiry is checked in the database rather than after loading, so a caller
 * cannot accidentally hold an assessment across a long job and keep disclosing
 * on it after it lapsed.
 */
export async function loadActiveAssessment(
  transaction: SqlTransaction,
  tenantId: string,
  signerId: string | null,
  now: Date = new Date(),
): Promise<ConfidentialityAssessment | null> {
  if (signerId === null) return null;
  const result = await transaction.query<{
    readonly assessed_by: string; readonly ground: string;
    readonly assessed_at: string | Date; readonly expires_at: string | Date;
  }>(
    `select assessed_by, ground, assessed_at, expires_at
       from app.protected_identity_assessments
      where tenant_id=$1 and signer_id=$2 and revoked_at is null and expires_at > $3
      order by expires_at desc limit 1`,
    [tenantId, signerId, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId,
    subjectId: signerId,
    assessedBy: row.assessed_by,
    assessedAt: new Date(row.assessed_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    ground: row.ground,
  };
}
