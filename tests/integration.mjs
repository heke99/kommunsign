import assert from 'node:assert/strict';
import { withTenantTransaction } from '../dist/packages/database/src/index.js';
import { createHandler } from '../dist/apps/api/src/dev-runtime.js';

const queries = [];
const database = {
  transaction: async (work) => work({ query: async (sql, parameters = []) => { queries.push([sql, parameters]); return { rows: [], rowCount: 0 }; } }),
};
const context = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  subjectId: '22222222-2222-4222-8222-222222222222',
  requestId: 'integration-request', source: 'api-client',
};
await withTenantTransaction(database, context, 'trusted_service', async () => 'ok');
assert.deepEqual(queries.map(([sql]) => sql), [
  "select set_config('app.tenant_id', $1, true)",
  "select set_config('app.actor_kind', $1, true)",
  "select set_config('app.actor_id', $1, true)",
  "select set_config('app.request_id', $1, true)",
]);

const handler = createHandler();
const baseHeaders = {
  'content-type': 'application/json',
  'x-kommunsign-tenant-id': context.tenantId,
  'x-kommunsign-subject-id': context.subjectId,
  'x-kommunsign-roles': 'tenant_admin',
};
let sequence = 0;
const key = () => `integration-key-${String(++sequence).padStart(4, '0')}`;
async function request(path, method = 'GET', body, headers = {}) {
  return handler(new Request(`https://api.example${path}`, {
    method,
    headers: { ...baseHeaders, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

const uploadResponse = await request('/v1/uploads', 'POST', {
  fileName: 'beslut.pdf', mimeType: 'application/pdf', byteSize: 1200, sha256: 'a'.repeat(64),
}, { 'idempotency-key': key() });
assert.equal(uploadResponse.status, 201);
const upload = await uploadResponse.json();

const caseResponse = await request('/v1/signature-cases', 'POST', {
  title: 'Delegationsbeslut', decisionMode: 'DIGITAL_APPROVAL', signaturePolicyId: '33333333-3333-4333-8333-333333333333',
}, { 'idempotency-key': key() });
assert.equal(caseResponse.status, 201);
const signatureCase = await caseResponse.json();
assert.equal(signatureCase.tenantId, context.tenantId);

assert.equal((await request(`/v1/signature-cases/${signatureCase.id}/documents`, 'POST', {
  uploadId: upload.id, displayName: 'Delegationsbeslut.pdf',
}, { 'idempotency-key': key() })).status, 202);
assert.equal((await request(`/v1/signature-cases/${signatureCase.id}/signers`, 'POST', {
  displayName: 'Beslutsfattare', recipientReference: 'opaque-recipient-reference-001', required: true, signingOrder: 1,
}, { 'idempotency-key': key() })).status, 201);
const sendResponse = await request(`/v1/signature-cases/${signatureCase.id}/send`, 'POST', undefined, {
  'idempotency-key': key(), 'if-match': '1',
});
assert.equal(sendResponse.status, 200);
assert.equal((await sendResponse.json()).status, 'sent');
assert.equal((await request(`/v1/signature-cases/${signatureCase.id}/remind`, 'POST', undefined, { 'idempotency-key': key() })).status, 202);
assert.equal((await request('/v1/events?limit=200')).status, 200);

const signed = await request(`/v1/signature-cases/${signatureCase.id}/signed-document`);
assert.equal(signed.status, 503);
assert.equal((await signed.json()).error.code, 'SIGN_SERVICE_NOT_CONFIGURED');

const otherTenant = await handler(new Request(`https://api.example/v1/signature-cases/${signatureCase.id}`, {
  headers: { ...baseHeaders, 'x-kommunsign-tenant-id': '44444444-4444-4444-8444-444444444444' },
}));
assert.equal(otherTenant.status, 404);

console.log('integration tests: 1 tenant-scoped API flow and transaction context passed');
