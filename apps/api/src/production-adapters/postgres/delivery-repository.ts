import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import type { DownloadArtifact } from '../../ports.js';

/**
 * Delivering the finished document.
 *
 * The two easy options are both wrong. A permanent object URL is a bearer
 * credential with no expiry, no revocation and no record of who used it —
 * forwarded once, it stays valid forever. An email attachment puts the signed
 * original on every mail server between here and the recipient, and in their
 * mailbox backups afterwards.
 *
 * What is issued instead is a grant: one artifact of one case, with an expiry,
 * a use ceiling, revocation, and a line in the trail for every fetch. The token
 * is returned once and stored only as its hash, so a leaked database is not a
 * set of working download links.
 */

export type DeliveryArtifactKind = 'SIGNED_DOCUMENT' | 'VALIDATION_REPORT' | 'EVIDENCE_PACKAGE';

export interface IssuedDownloadGrant {
  readonly grantId: string;
  readonly artifact: DeliveryArtifactKind;
  readonly expiresAt: string;
  readonly maximumUses: number;
  /** Returned exactly once. Stored only as a hash. */
  readonly token: string;
}

export interface DeliveryRepository {
  issue(context: TenantContext, input: {
    readonly signatureCaseId: string;
    readonly artifact: DeliveryArtifactKind;
    readonly signerId?: string;
    readonly lifetimeSeconds: number;
    readonly maximumUses: number;
  }): Promise<IssuedDownloadGrant>;
  revoke(context: TenantContext, grantId: string): Promise<void>;
  /**
   * Redeems a token. Returns null for anything that is not a live grant —
   * unknown, expired, revoked or spent all look identical from outside, so a
   * caller cannot use the response to learn which case ids exist.
   */
  redeem(token: string, now: Date, client: { readonly network?: string; readonly userAgentFamily?: string }): Promise<{
    readonly tenantId: string;
    readonly signatureCaseId: string;
    readonly artifact: DeliveryArtifactKind;
  } | null>;
}

/** Long enough for a recipient who reads mail the next morning, short enough to matter. */
export const DEFAULT_GRANT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
export const MAXIMUM_GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export function createDeliveryRepository(database: SqlDatabase): DeliveryRepository {
  return {
    async issue(context, input) {
      if (input.lifetimeSeconds < 60 || input.lifetimeSeconds > MAXIMUM_GRANT_LIFETIME_SECONDS) {
        throw new DeliveryError('DOWNLOAD_GRANT_LIFETIME_INVALID', 'The requested lifetime is outside the permitted range');
      }
      // Generated here rather than accepted from the caller: a token somebody
      // chose is a token they may have chosen badly, or reused.
      const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = hexToBytes(await sha256Hex(new TextEncoder().encode(token)));

      return tenantTx(database, context, async (tx) => {
        const inserted = await tx.query<{ readonly id: string; readonly expires_at: string | Date }>(
          `insert into app.document_download_grants(
             tenant_id,signature_case_id,artifact,signer_id,token_hash,expires_at,maximum_uses,issued_by)
           values($1,$2,$3,$4,$5,now()+make_interval(secs=>$6),$7,$8)
           returning id,expires_at`,
          [context.tenantId, input.signatureCaseId, input.artifact, input.signerId ?? null,
            tokenHash, input.lifetimeSeconds, input.maximumUses, context.subjectId],
        );
        const row = inserted.rows[0];
        if (!row) throw new DeliveryError('DOWNLOAD_GRANT_NOT_ISSUED', 'The grant could not be issued');

        await audit(tx, context, 'delivery.download_grant_issued', 'signature_case', input.signatureCaseId, {
          grantId: row.id, artifact: input.artifact, maximumUses: input.maximumUses,
        });
        return {
          grantId: row.id,
          artifact: input.artifact,
          expiresAt: new Date(row.expires_at).toISOString(),
          maximumUses: input.maximumUses,
          token,
        };
      });
    },

    async revoke(context, grantId) {
      await tenantTx(database, context, async (tx) => {
        const result = await tx.query(
          `update app.document_download_grants set revoked_at=now(),revoked_by=$3
            where tenant_id=$1 and id=$2 and revoked_at is null`,
          [context.tenantId, grantId, context.subjectId],
        );
        if (result.rowCount === 0) throw new DeliveryError('DOWNLOAD_GRANT_NOT_FOUND', 'No live grant with that id');
        await audit(tx, context, 'delivery.download_grant_revoked', 'download_grant', grantId, {});
      });
    },

    async redeem(token, now, client) {
      const tokenHash = hexToBytes(await sha256Hex(new TextEncoder().encode(token)));

      // Outside a tenant transaction, because the token is what establishes the
      // tenant. Nothing else in the request is trusted for that.
      return database.transaction(async (tx) => {
        // The update is the redemption. Doing it as one conditional statement
        // rather than read-then-write is what stops two concurrent fetches from
        // both seeing the last remaining use and both taking it.
        const redeemed = await tx.query<{
          readonly id: string; readonly tenant_id: string;
          readonly signature_case_id: string; readonly artifact: DeliveryArtifactKind;
        }>(
          `update app.document_download_grants
              set use_count = use_count + 1
            where token_hash = $1
              and revoked_at is null
              and expires_at > $2
              and use_count < maximum_uses
            returning id,tenant_id,signature_case_id,artifact`,
          [tokenHash, now.toISOString()],
        );
        const row = redeemed.rows[0];
        // Unknown, expired, revoked and spent are deliberately the same answer.
        // Distinguishing them tells a probing caller which tokens once existed.
        if (!row) return null;

        await tx.query(
          `insert into app.document_download_events(tenant_id,grant_id,client_network,user_agent_family)
           values($1,$2,$3,$4)`,
          [row.tenant_id, row.id, client.network ?? null, client.userAgentFamily ?? null],
        );
        return { tenantId: row.tenant_id, signatureCaseId: row.signature_case_id, artifact: row.artifact };
      });
    },
  };
}

export class DeliveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/**
 * Truncates a client address before it is stored.
 *
 * A full address is personal data being retained for a purpose nobody stated.
 * A /24 or /48 is enough to tell "the same office fetched it twice" from "this
 * link is being passed around", which is the only question the trail has to
 * answer.
 */
export function truncateClientAddress(address: string | null | undefined): string | undefined {
  if (!address) return undefined;
  const value = address.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (value.includes(':')) {
    const groups = value.split(':').filter((group) => group !== '');
    if (groups.length < 3) return undefined;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return undefined;
}

/** A coarse family, never the full string: a user agent is a fingerprint. */
export function userAgentFamily(userAgent: string | null | undefined): string | undefined {
  if (!userAgent) return undefined;
  for (const [family, pattern] of [
    ['edge', /Edg\//], ['chrome', /Chrome\//], ['firefox', /Firefox\//],
    ['safari', /Safari\//], ['bot', /bot|crawler|spider/i],
  ] as const) {
    if (pattern.test(userAgent)) return family;
  }
  return 'other';
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function tenantTx<T>(database: SqlDatabase, context: TenantContext, work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  return withTenantTransaction(database, context, 'internal_user', work);
}

async function audit(tx: SqlTransaction, context: TenantContext, eventType: string, resourceType: string, resourceId: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await tx.query(`select audit.append_event($1,'BUSINESS',$2,$3,$4,$5,$6,$7::jsonb,now())`,
    [context.tenantId, eventType, context.authMethod, context.subjectId, resourceType, resourceId, payload]);
}

export type { DownloadArtifact };
