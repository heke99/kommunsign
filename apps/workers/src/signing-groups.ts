import type { SqlTransaction } from '../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from '../../api/src/production-adapters/postgres/infrastructure.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import { randomToken } from '../../../packages/crypto/src/tokens.js';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Invites the next signing group once the groups before it are complete.
 *
 * Extracted so that both the identity chain and the signature chain call the
 * same implementation. Two copies of "whose turn is it now" would eventually
 * disagree, and the way that disagreement surfaces is a signer being asked to
 * sign before the person whose approval theirs depends on. The predicate itself
 * lives in app.signing_turn_blocked (migration data/0030) so that the API, this
 * job and the reminder job cannot drift apart across a rolling deployment.
 */
export async function activateNextSigningGroup(
  tx: SqlTransaction,
  infrastructure: ProductionInfrastructure,
  tenantId: string,
  signatureCaseId: string,
): Promise<void> {
  const next = await tx.query<{ readonly signing_order: number }>(
    `select min(s.signing_order) signing_order from app.signers s where s.tenant_id=$1 and s.signature_case_id=$2 and s.status='pending'
      and not app.signing_turn_blocked(s.tenant_id, s.id)`,
    [tenantId, signatureCaseId],
  );
  const group = next.rows[0]?.signing_order;
  if (!group) return;

  const signers = await tx.query<{ readonly id: string; readonly email_ciphertext: Uint8Array; readonly expires_at: string | Date }>(
    `select s.id,s.email_ciphertext,si.expires_at from app.signers s join app.signing_intents si on si.tenant_id=s.tenant_id and si.signer_id=s.id
      where s.tenant_id=$1 and s.signature_case_id=$2 and s.signing_order=$3 and s.status='pending'`,
    [tenantId, signatureCaseId, group],
  );

  for (const signer of signers.rows) {
    const invitationId = crypto.randomUUID();
    const token = randomToken(32);
    const tokenHash = await infrastructure.sensitiveData.blindIndex(token, 'signer.invitation_token');
    const expiresAt = new Date(signer.expires_at).toISOString();
    await tx.query(`insert into app.signer_invitations(tenant_id,id,signer_id,token_hash,expires_at) values($1,$2,$3,$4,$5)`, [tenantId, invitationId, signer.id, tokenHash, expiresAt]);
    const messageId = crypto.randomUUID();
    const payload = JSON.stringify({ invitationToken: token, signerId: signer.id, signatureCaseId, tenantId, expiresAt });
    const encryptedPayload = await infrastructure.sensitiveData.encryptText(payload, 'email.signature_invitation');
    await tx.query(`insert into app.email_messages(tenant_id,id,signer_id,signature_case_id,template_key,template_version,locale,recipient_ciphertext,message_payload_ciphertext,payload_sha256,idempotency_key) values($1,$2,$3,$4,'signature_invitation',1,'sv-SE',$5,$6,$7,$8)`, [tenantId, messageId, signer.id, signatureCaseId, signer.email_ciphertext, encryptedPayload, await sha256Hex(payload), `signature-invitation:${invitationId}`]);
    await tx.query(`insert into app.durable_jobs(tenant_id,job_type,payload,idempotency_key,status,available_at,maximum_attempts) values($1,'EMAIL_SEND',$2::jsonb,$3,'pending',now(),10) on conflict(tenant_id,job_type,idempotency_key) do nothing`, [tenantId, { emailMessageId: messageId }, `email:${messageId}`]);
    await tx.query(`update app.signers set status='invited',status_version=status_version+1 where tenant_id=$1 and id=$2 and status='pending'`, [tenantId, signer.id]);
    await tx.query(`select audit.append_event($1,'BUSINESS','invitation.created','worker',$2,'signer',$3,$4::jsonb,now())`, [tenantId, SYSTEM_ACTOR_ID, signer.id, { signatureCaseId, signerId: signer.id, signingOrder: group }]);
  }
}
