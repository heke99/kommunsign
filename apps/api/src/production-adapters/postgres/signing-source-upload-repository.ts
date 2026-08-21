import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import {
  SIGNING_SOURCE_MAX_BYTES,
  SIGNING_SOURCE_MIME_TYPES,
  validateUploadMetadata,
} from '../../../../../packages/uploads/src/index.js';
import type { UploadGrantInput, UploadGrantView, UploadRepository } from '../../ports.js';
import type { ProductionInfrastructure } from './infrastructure.js';

interface UploadRow {
  readonly id: string;
  readonly object_key: string;
  readonly file_name: string;
  readonly mime_type: string;
  readonly byte_size: number | string;
  readonly expected_sha256: string;
  readonly status: string;
}

export function createSigningSourceUploadRepository(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
): UploadRepository {
  return {
    async create(context, input, idempotencyKey, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(
        transaction,
        context.tenantId,
        'upload:create',
        idempotencyKey,
        payloadHash,
        async () => {
          // The tenant's own document limit is read here rather than after the upload. The shared
          // ceiling allows 100 MB while a tenant's scan limit defaults to 50 MB, so a 60 MB file
          // was uploaded in full, confirmed, and only then rejected by the worker. Refusing before
          // a byte moves costs one column on a query this transaction already runs.
          const uploader = await requireUploader(transaction, context);
          const validated = validateUploadMetadata(input, {
            allowedMimeTypes: SIGNING_SOURCE_MIME_TYPES,
            maximumBytes: Math.min(SIGNING_SOURCE_MAX_BYTES, uploader.maximumDocumentBytes),
          });
          const userId = uploader.userId;
          const id = crypto.randomUUID();
          const fileName = cleanFileName(validated.fileName);
          const objectKey = `${context.tenantId}/quarantine/${id}/${fileName}`;
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          const grant = await infrastructure.objectStorage.createUploadGrant(context, {
            ...validated,
            fileName,
            objectKey,
            expiresAt,
          });
          await transaction.query(
            `insert into app.upload_grants
               (tenant_id,id,object_key,file_name,mime_type,byte_size,expected_sha256,status,expires_at,created_by)
             values ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9)`,
            [context.tenantId, id, objectKey, fileName, validated.mimeType, validated.byteSize, validated.sha256, expiresAt, userId],
          );
          return {
            id,
            fileName,
            mimeType: validated.mimeType,
            byteSize: validated.byteSize,
            sha256: validated.sha256,
            uploadUrl: grant.uploadUrl,
            expiresAt,
            requiredHeaders: grant.requiredHeaders,
          } satisfies UploadGrantView;
        },
      ));
    },

    async complete(context, uploadId, idempotencyKey, payloadHash) {
      return tenantTx(database, context, async (transaction) => idempotent(
        transaction,
        context.tenantId,
        `upload:${uploadId}:complete`,
        idempotencyKey,
        payloadHash,
        async () => {
          const result = await transaction.query<UploadRow>(
            `select id,object_key,file_name,mime_type,byte_size,expected_sha256,status
               from app.upload_grants
              where tenant_id=$1 and id=$2
              for update`,
            [context.tenantId, uploadId],
          );
          const grant = requireRow(result.rows[0], 'UPLOAD_GRANT_NOT_FOUND');
          if (grant.status === 'uploaded') {
            return { id: grant.id, status: 'uploaded' as const, sha256: grant.expected_sha256, byteSize: Number(grant.byte_size) };
          }
          if (grant.status !== 'issued') throw new Error('UPLOAD_GRANT_NOT_ACTIVE');

          const object = await infrastructure.objectStorage.headObject(context, grant.object_key);
          if (object.byteSize !== Number(grant.byte_size)) throw new Error('UPLOAD_OBJECT_MISMATCH');
          if (object.contentType && object.contentType.split(';', 1)[0]?.trim().toLowerCase() !== grant.mime_type) {
            throw new Error('UPLOAD_OBJECT_MISMATCH');
          }
          // The declared hash is verified against the stored bytes in DOCUMENT_SCAN, which downloads
          // the file anyway. Verifying it here meant pulling the whole object back from Stockholm
          // and hashing it inside the operator's request, while holding an advisory lock and a row
          // lock, so concurrent uploads from one tenant queued behind each other. A checksum the
          // storage backend reports for free is still compared, since that costs nothing; only the
          // download was removed, and a document still cannot reach ready without a verified hash.
          if (object.sha256 && object.sha256 !== grant.expected_sha256) throw new Error('UPLOAD_OBJECT_MISMATCH');

          await transaction.query(
            `update app.upload_grants set status='uploaded',uploaded_at=now() where tenant_id=$1 and id=$2`,
            [context.tenantId, uploadId],
          );
          await appendOutbox(transaction, context.tenantId, 'upload', uploadId, 'document.uploaded', {
            uploadId,
            sha256: grant.expected_sha256,
            byteSize: Number(grant.byte_size),
            mimeType: grant.mime_type,
          });
          return { id: grant.id, status: 'uploaded' as const, sha256: grant.expected_sha256, byteSize: Number(grant.byte_size) };
        },
      ));
    },
  };
}

async function tenantTx<T>(
  database: SqlDatabase,
  context: TenantContext,
  work: (transaction: SqlTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(database, context, actorKind(context), work);
}

function actorKind(context: TenantContext): 'internal_user' | 'external_client' | 'worker' | 'trusted_service' {
  if (context.authMethod === 'oauth2_client_credentials' || context.authMethod === 'mtls') return 'external_client';
  if (context.authMethod === 'worker') return 'worker';
  if (context.authMethod === 'trusted_service') return 'trusted_service';
  return 'internal_user';
}

/** The uploading user and the tenant's document size limit, in one round trip rather than two. */
async function requireUploader(
  transaction: SqlTransaction,
  context: TenantContext,
): Promise<{ readonly userId: string; readonly maximumDocumentBytes: number }> {
  const result = await transaction.query<{ readonly id: string; readonly maximum_document_bytes: number | string }>(
    `select u.id, coalesce(s.maximum_document_bytes, 52428800) as maximum_document_bytes
       from app.users u
       left join app.tenant_signing_settings s on s.tenant_id = u.tenant_id
      where u.tenant_id=$1 and u.external_subject=$2 and u.disabled_at is null limit 1`,
    [context.tenantId, context.subjectId],
  );
  const row = requireRow(result.rows[0], 'TENANT_SUBJECT_NOT_PROVISIONED');
  return { userId: row.id, maximumDocumentBytes: Number(row.maximum_document_bytes) };
}

async function idempotent<T>(
  transaction: SqlTransaction,
  tenantId: string,
  operation: string,
  key: string,
  payloadHash: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error('IDEMPOTENCY_KEY_INVALID');
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error('PAYLOAD_HASH_INVALID');
  await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`${tenantId}:${operation}:${key}`]);
  const existing = await transaction.query<{ readonly payload_sha256: string; readonly response_body: T | null }>(
    `select payload_sha256,response_body
       from app.operation_idempotency
      where tenant_id=$1 and operation=$2 and idempotency_key=$3 and expires_at>now()
      for update`,
    [tenantId, operation, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.payload_sha256 !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
    if (row.response_body === null) throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
    return row.response_body;
  }
  await transaction.query(
    `insert into app.operation_idempotency(tenant_id,operation,idempotency_key,payload_sha256) values($1,$2,$3,$4)`,
    [tenantId, operation, key, payloadHash],
  );
  const response = await work();
  const responseJson = JSON.stringify(response);
  await transaction.query(
    `update app.operation_idempotency
        set response_body=$4::jsonb,response_body_sha256=$5
      where tenant_id=$1 and operation=$2 and idempotency_key=$3`,
    [tenantId, operation, key, response, await sha256Hex(responseJson)],
  );
  return response;
}

async function appendOutbox(
  transaction: SqlTransaction,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const payloadJson = JSON.stringify(payload);
  await transaction.query(
    `insert into app.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,payload_sha256)
     values($1,$2,$3,$4,$5::jsonb,$6)`,
    [tenantId, aggregateType, aggregateId, eventType, payload, await sha256Hex(payloadJson)],
  );
}

function cleanFileName(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, '_').slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('FILE_NAME_INVALID');
  return cleaned;
}

function requireRow<T>(row: T | undefined, code: string): T {
  if (!row) throw new Error(code);
  return row;
}
