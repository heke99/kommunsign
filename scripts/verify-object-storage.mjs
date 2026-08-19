#!/usr/bin/env node
// Exercises the S3 object storage adapter against a live S3-compatible backend.
//
// The unit tests prove the adapter computes the signature the specification
// describes. They cannot prove a real server accepts it — the whole class of
// defect here is a canonical request that is self-consistently wrong. Only a
// backend that rejects bad signatures can tell the difference, so this runs
// against the MinIO in docker-compose.
//
//   docker compose up -d minio && npm run verify:storage

import { createObjectStorageAdapter } from '../dist/apps/api/src/adapters/s3-object-storage.js';
import { createHash, randomUUID } from 'node:crypto';

const settings = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'local-only',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'local-only-change-me',
};

const tenantId = randomUUID();
const context = { tenantId, actorId: randomUUID(), actorKind: 'worker' };
const adapter = createObjectStorageAdapter(settings);

let failures = 0;
async function step(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`); }
}

const live = await fetch(`${settings.S3_ENDPOINT}/minio/health/live`).then((r) => r.ok).catch(() => false);
if (!live) {
  console.error(`object storage not reachable at ${settings.S3_ENDPOINT}`);
  console.error('start it with: docker compose up -d minio');
  process.exit(1);
}

console.log(`object storage verification against ${settings.S3_ENDPOINT}`);

const bytes = new TextEncoder().encode(`%PDF-1.7\n% kommunsign storage probe ${tenantId}\n`);
const digest = createHash('sha256').update(bytes).digest('hex');
const signedKey = `${tenantId}/signed/probe.pdf`;

await step('provisions private buckets', async () => {
  const result = await adapter.provisionTenantNamespaces({
    tenantId,
    bucketNames: ['signed-documents', 'document-quarantine'],
    idempotencyKey: randomUUID(),
  });
  if (!result.namespaceReference.startsWith('s3://')) throw new Error('namespace reference not returned');
});

await step('provisioning is idempotent', async () => {
  await adapter.provisionTenantNamespaces({ tenantId, bucketNames: ['signed-documents'], idempotencyKey: randomUUID() });
});

await step('writes an object and reports its digest', async () => {
  const result = await adapter.putObject(context, signedKey, bytes, 'application/pdf');
  if (result.sha256 !== digest) throw new Error(`digest mismatch: ${result.sha256}`);
  if (result.byteSize !== bytes.byteLength) throw new Error(`size mismatch: ${result.byteSize}`);
});

await step('reads size, type and digest back', async () => {
  const head = await adapter.headObject(context, signedKey);
  if (head.byteSize !== bytes.byteLength) throw new Error(`size mismatch: ${head.byteSize}`);
  if (head.contentType !== 'application/pdf') throw new Error(`type mismatch: ${head.contentType}`);
  if (head.sha256 !== digest) throw new Error(`digest mismatch: ${head.sha256}`);
});

await step('returns the same bytes that went in', async () => {
  const artifact = await adapter.downloadObject(context, signedKey, { contentType: 'application/pdf', fileName: 'probe.pdf' });
  const roundTrip = createHash('sha256').update(artifact.bytes).digest('hex');
  if (roundTrip !== digest) throw new Error(`round trip digest ${roundTrip}`);
});

await step('refuses to overwrite a signed document', async () => {
  const altered = new TextEncoder().encode('replacement');
  let refused = false;
  try { await adapter.putObject(context, signedKey, altered, 'application/pdf'); }
  catch (error) { refused = /STORAGE_OBJECT_ALREADY_EXISTS/.test(String(error)); if (!refused) throw error; }
  if (!refused) throw new Error('the backend accepted an overwrite of a signed document');
  const artifact = await adapter.downloadObject(context, signedKey, { contentType: 'application/pdf', fileName: 'probe.pdf' });
  if (createHash('sha256').update(artifact.bytes).digest('hex') !== digest) throw new Error('stored bytes were replaced');
});

await step('a presigned upload URL is accepted by the backend', async () => {
  const uploadKey = `${tenantId}/inbox/underlag.pdf`;
  const grant = await adapter.createUploadGrant(context, {
    fileName: 'underlag.pdf', mimeType: 'application/pdf', byteSize: bytes.byteLength, sha256: digest,
    objectKey: uploadKey, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const uploaded = await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.requiredHeaders, body: bytes });
  if (!uploaded.ok) throw new Error(`presigned PUT rejected: ${uploaded.status} ${(await uploaded.text()).slice(0, 200)}`);
  const head = await adapter.headObject(context, uploadKey);
  if (head.byteSize !== bytes.byteLength) throw new Error(`uploaded size mismatch: ${head.byteSize}`);
  await adapter.deleteObject(context, uploadKey);
});

await step('a tampered presigned URL is refused', async () => {
  const grant = await adapter.createUploadGrant(context, {
    fileName: 'underlag.pdf', mimeType: 'application/pdf', byteSize: bytes.byteLength, sha256: digest,
    objectKey: `${tenantId}/inbox/underlag.pdf`, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  // Move the grant to a different object. If the backend accepted this, the
  // signature would not be covering the path and any grant would be a
  // write-anywhere token.
  const moved = grant.uploadUrl.replace('/inbox/underlag.pdf', '/inbox/nagot-annat.pdf');
  const response = await fetch(moved, { method: 'PUT', headers: grant.requiredHeaders, body: bytes });
  if (response.ok) throw new Error('the backend accepted a presigned URL for a different object');
});

await step('an unsigned request is refused', async () => {
  const response = await fetch(`${settings.S3_ENDPOINT}/signed-documents/${signedKey}`);
  if (response.ok) throw new Error('the bucket is readable without credentials');
});

await step('deletes an object and tolerates deleting it twice', async () => {
  await adapter.deleteObject(context, signedKey);
  await adapter.deleteObject(context, signedKey);
  let missing = false;
  try { await adapter.headObject(context, signedKey); }
  catch { missing = true; }
  if (!missing) throw new Error('the object survived deletion');
});

if (failures) {
  console.error(`\nobject storage verification FAILED (${failures})`);
  process.exit(1);
}
console.log('\nobject storage verification: OK');
