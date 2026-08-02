import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { base64Encode, canonicalJson, sha256Hex, hmacSha256Hex, verifyHmacSha256Hex } from '../dist/packages/crypto/src/index.js';
import { resolveTenantContext, assertTenantMatch } from '../dist/packages/tenant-context/src/index.js';
import { canTransitionCase, requireServerEvidenceForCaseStatus } from '../dist/packages/domain/src/state-machines.js';
import { validatePolicyUse } from '../dist/packages/signature-policy/src/index.js';
import {
  assertTicWebhookBinding, parseTicWebhookEnvelope, verifyTicWebhook, TicBankIdProvider,
} from '../dist/packages/provider-adapters/src/tic-bankid.js';
import { bankIdEvidenceBytes } from '../dist/packages/provider-adapters/src/evidence-payload.js';
import { createEvidenceManifest, verifyEvidenceFiles } from '../dist/packages/evidence/src/index.js';
import { calculateAuditEventHash, createAuditHashMaterial, verifyAuditChain } from '../dist/packages/audit/src/index.js';
import { processClaimedJob, retryDelaySeconds } from '../dist/apps/workers/src/jobs.js';
import { createApiHandler } from '../dist/apps/api/src/router.js';
import { verifyProvenance } from '../scripts/provenance-lib.mjs';

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const completionEvidence = (overrides = {}) => ({
  decisionMode: 'ELECTRONIC_SIGNATURE',
  allRequiredParticipantsCompleted: true,
  documentVersionLocked: true,
  approvalEvidenceRecorded: false,
  cryptographicSignatureCreated: true,
  validationAccepted: true,
  archiveCompleted: false,
  ...overrides,
});

const identityInput = {
  tenantId: 't1', signatureCaseId: 'c1', documentId: 'd1', documentVersionId: 'v1',
  documentSha256: 'a'.repeat(64), signaturePolicyId: 'p1', signaturePolicyVersion: 4,
  signerId: 's1', visibleText: 'Jag skriver under', endUserIp: '127.0.0.1', userAgent: 'test',
  issuedAt: '2026-08-02T08:00:00.000Z', expiresAt: '2026-08-02T08:05:00.000Z', state: 'state', nonce: 'nonce',
};

test('canonical JSON is deterministic', async () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('base64 encoder is deterministic and standards-compatible', () => {
  assert.equal(base64Encode(new TextEncoder().encode('KommunSign')), 'S29tbXVuU2lnbg==');
  assert.equal(base64Encode(new Uint8Array()), '');
});

test('tenant sources must agree', () => {
  const context = resolveTenantContext({ requestId: 'r1', subjectId: 's1', verifiedDomainTenantId: 't1', membershipTenantId: 't1' });
  assert.equal(context.tenantId, 't1');
  assert.throws(() => resolveTenantContext({ requestId: 'r1', subjectId: 's1', verifiedDomainTenantId: 't1', membershipTenantId: 't2' }));
  assert.throws(() => assertTenantMatch(context, 't2'));
});

test('electronic signature completion requires cryptography and validation', () => {
  assert.equal(canTransitionCase('in_progress', 'completed'), true);
  assert.throws(() => requireServerEvidenceForCaseStatus('completed', completionEvidence({ validationAccepted: false })));
  assert.throws(() => requireServerEvidenceForCaseStatus('completed', completionEvidence({ cryptographicSignatureCreated: false })));
  requireServerEvidenceForCaseStatus('completed', completionEvidence());
});

test('digital approval completion requires locked document and approval evidence, not PAdES', () => {
  requireServerEvidenceForCaseStatus('completed', completionEvidence({
    decisionMode: 'DIGITAL_APPROVAL', approvalEvidenceRecorded: true,
    cryptographicSignatureCreated: false, validationAccepted: false,
  }));
  assert.throws(() => requireServerEvidenceForCaseStatus('completed', completionEvidence({
    decisionMode: 'DIGITAL_APPROVAL', approvalEvidenceRecorded: false,
    cryptographicSignatureCreated: false, validationAccepted: false,
  })));
});

test('electronic signature policy cannot omit cryptographic format', () => {
  const errors = validatePolicyUse({
    id: 'p1', version: 1, name: 'bad', decisionMode: 'ELECTRONIC_SIGNATURE', signatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE',
    allowedIdentityProviders: ['TIC_BANKID'], minimumAssuranceLevel: 'HIGH', requiresExpectedSubject: true, allowsQr: true,
    requiresSigningOrder: false, requiresAuthorityCheck: false, requiresTimestamp: true, requiredPadesLevel: 'NONE',
    allowedValidationResults: ['TOTAL_PASSED'], retainOriginalDocument: true, retentionDays: null, reminderIntervalHours: 24,
    validityMinutes: 60, allowsDelegation: false, allowedMimeTypes: ['application/pdf'], maximumDocumentBytes: 1000,
  }, { provider: 'TIC_BANKID', expectedSubject: 'tokenized', usesQr: true, mimeType: 'application/pdf', documentBytes: 100 });
  assert.ok(errors.some((error) => error.includes('cryptographic')));
});

test('BankID evidence bytes are reproducible and verifier fails closed', async () => {
  assert.deepEqual(bankIdEvidenceBytes(identityInput), bankIdEvidenceBytes(identityInput));
  const provider = new TicBankIdProvider({
    baseUrl: 'https://id.tic.io/api/v1', apiKey: 'not-used', callbackUrl: 'https://example/callback', webhookUrl: 'https://example/webhook',
  });
  await assert.rejects(() => provider.verifyEvidence({ provider: 'TIC_BANKID', providerReference: 'r', rawPayload: {}, collectedAt: identityInput.issuedAt }));
});

test('TIC adapter uses operation-specific methods, paths and Base64 evidence', async () => {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/bankid/sign')) {
      return new Response(JSON.stringify({
        sessionId: 'session-1', orderRef: 'order-1', status: 'started', autoStartToken: 'auto',
        qrStartSecret: 'qr-secret', subscriptionToken: 'subscription', sessionExpiresAt: '2026-08-02T08:04:00.000Z',
      }), { status: 200 });
    }
    if (String(url).endsWith('/poll')) return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
    if (String(url).endsWith('/collect')) return new Response(JSON.stringify({ sessionId: 'session-1', signature: { value: 'opaque' } }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  const provider = new TicBankIdProvider({
    baseUrl: 'https://id.tic.io/api/v1/', apiKey: 'secret', callbackUrl: 'https://example/callback', webhookUrl: 'https://example/webhook',
  }, undefined, http);
  const session = await provider.startSignature(identityInput);
  assert.equal(session.id, 'session-1');
  assert.equal(session.orderReference, 'order-1');
  assert.equal(session.qrStartSecret, 'qr-secret');
  assert.equal(session.subscriptionToken, 'subscription');
  assert.equal(session.expiresAt, '2026-08-02T08:04:00.000Z');
  const startBody = JSON.parse(calls[0].init.body);
  assert.equal(startBody.userNonVisibleData, base64Encode(bankIdEvidenceBytes(identityInput)));
  assert.equal(Array.isArray(startBody.userNonVisibleData), false);
  assert.equal(await provider.getStatus('session-1'), 'COMPLETED');
  await provider.collectEvidence('session-1');
  await provider.cancel('session-1');
  assert.deepEqual(calls.map((call) => call.init.method), ['POST', 'POST', 'GET', 'DELETE']);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/api/v1/auth/bankid/sign', '/api/v1/auth/session-1/poll', '/api/v1/auth/session-1/collect', '/api/v1/auth/session-1',
  ]);
});

test('TIC adapter rejects mismatched collect sessions and unsafe base URLs', async () => {
  assert.throws(() => new TicBankIdProvider({ baseUrl: 'http://id.tic.io/api/v1', apiKey: 'x', callbackUrl: 'https://c', webhookUrl: 'https://w' }));
  const provider = new TicBankIdProvider({ baseUrl: 'https://id.tic.io/api/v1', apiKey: 'x', callbackUrl: 'https://c', webhookUrl: 'https://w' }, undefined,
    async () => new Response(JSON.stringify({ sessionId: 'other' }), { status: 200 }));
  await assert.rejects(() => provider.collectEvidence('expected'), /session did not match/);
});

test('HMAC verification, timestamp window and webhook binding', async () => {
  const rawBody = new TextEncoder().encode('{"event":"auth.completed","data":{"sessionId":"s1","state":"state","status":"completed"}}');
  const timestamp = '1000';
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const combined = new Uint8Array(prefix.length + rawBody.length);
  combined.set(prefix); combined.set(rawBody, prefix.length);
  const signature = await hmacSha256Hex('secret', combined);
  assert.equal(await verifyHmacSha256Hex('secret', combined, signature), true);
  assert.equal(await verifyTicWebhook({ rawBody, timestamp, signature, secret: 'secret', nowEpochSeconds: 1100 }), true);
  assert.equal(await verifyTicWebhook({ rawBody, timestamp, signature, secret: 'secret', nowEpochSeconds: 1401 }), false);
  const envelope = parseTicWebhookEnvelope(rawBody);
  assertTicWebhookBinding(envelope, { sessionId: 's1', state: 'state' });
  assert.throws(() => assertTicWebhookBinding(envelope, { sessionId: 's2', state: 'state' }));
});

test('API rejects malformed and unsupported JSON without leaking internals', async () => {
  const context = { tenantId: 'tenant', source: 'api-client', subjectId: 'subject', requestId: 'ctx' };
  let reported = null;
  const handler = createApiHandler({
    resolveContext: async () => context,
    authorize: () => {},
    reportError: (cause) => { reported = cause; },
    cases: {
      create: async () => { throw new Error('database-password-should-never-leak'); },
      get: async () => null, list: async () => [], send: async () => { throw new Error('unused'); }, cancel: async () => { throw new Error('unused'); },
    },
  });
  const malformed = await handler(new Request('https://api.example/v1/signature-cases', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'request-12345678' }, body: '{',
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');

  const unsupported = await handler(new Request('https://api.example/v1/signature-cases', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'request-12345678' },
    body: JSON.stringify({ title: 'A', decisionMode: 'DIGITAL_APPROVAL', signaturePolicyId: '11111111-1111-4111-8111-111111111111', tenantId: 'escape' }),
  }));
  assert.equal(unsupported.status, 422);

  const internal = await handler(new Request('https://api.example/v1/signature-cases', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'request-12345678' },
    body: JSON.stringify({ title: 'A', decisionMode: 'DIGITAL_APPROVAL', signaturePolicyId: '11111111-1111-4111-8111-111111111111' }),
  }));
  const internalBody = await internal.text();
  assert.equal(internal.status, 500);
  assert.equal(internalBody.includes('database-password'), false);
  assert.ok(reported instanceof Error);
});

test('API hashes semantically identical create payloads canonically', async () => {
  const hashes = [];
  const context = { tenantId: 'tenant', source: 'api-client', subjectId: 'subject', requestId: 'ctx' };
  const view = { id: '22222222-2222-4222-8222-222222222222', tenantId: 'tenant', status: 'draft', decisionMode: 'DIGITAL_APPROVAL', title: 'A', createdAt: '2026-08-02T00:00:00Z' };
  const handler = createApiHandler({
    resolveContext: async () => context, authorize: () => {},
    cases: {
      create: async (_context, _input, _key, hash) => { hashes.push(hash); return view; },
      get: async () => null, list: async () => [], send: async () => view, cancel: async () => view,
    },
  });
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'request-12345678' };
  const one = '{"title":"A","decisionMode":"DIGITAL_APPROVAL","signaturePolicyId":"11111111-1111-4111-8111-111111111111"}';
  const two = '{ "signaturePolicyId": "11111111-1111-4111-8111-111111111111", "decisionMode": "DIGITAL_APPROVAL", "title": "A" }';
  assert.equal((await handler(new Request('https://api.example/v1/signature-cases', { method: 'POST', headers, body: one }))).status, 201);
  assert.equal((await handler(new Request('https://api.example/v1/signature-cases', { method: 'POST', headers, body: two }))).status, 201);
  assert.equal(hashes[0], hashes[1]);
});

test('API authorizes every case operation', async () => {
  const permissions = [];
  const context = { tenantId: 'tenant', source: 'api-client', subjectId: 'subject', requestId: 'ctx' };
  const view = { id: '22222222-2222-4222-8222-222222222222', tenantId: 'tenant', status: 'draft', decisionMode: 'DIGITAL_APPROVAL', title: 'A', createdAt: '2026-08-02T00:00:00Z' };
  const handler = createApiHandler({
    resolveContext: async () => context, authorize: (_context, permission) => { permissions.push(permission); },
    cases: { create: async () => view, get: async () => view, list: async () => [view], send: async () => view, cancel: async () => view },
  });
  await handler(new Request('https://api.example/v1/signature-cases'));
  await handler(new Request(`https://api.example/v1/signature-cases/${view.id}`));
  await handler(new Request(`https://api.example/v1/signature-cases/${view.id}/send`, { method: 'POST', headers: { 'idempotency-key': 'request-12345678' } }));
  await handler(new Request(`https://api.example/v1/signature-cases/${view.id}/cancel`, { method: 'POST', headers: { 'idempotency-key': 'request-12345678' } }));
  assert.deepEqual(permissions, ['case:read', 'case:read', 'case:send', 'case:cancel']);
});

test('audit chain covers actor, resource and payload fields', async () => {
  const firstInput = {
    previousEventHash: '0'.repeat(64), tenantId: 'tenant-1', sequence: 1, category: 'BUSINESS',
    eventType: 'case_created', actorType: 'user', actorId: 'user-1', resourceType: 'signature_case',
    resourceId: 'case-1', payload: { status: 'draft' }, occurredAt: '2026-08-02T10:00:00.000Z',
  };
  const first = { ...firstInput, hashMaterial: createAuditHashMaterial(firstInput), hash: await calculateAuditEventHash(firstInput) };
  delete first.previousEventHash;
  const secondInput = { ...firstInput, previousEventHash: first.hash, sequence: 2, eventType: 'case_sent', payload: { status: 'sent' } };
  const second = { ...secondInput, hashMaterial: createAuditHashMaterial(secondInput), hash: await calculateAuditEventHash(secondInput) };
  delete second.previousEventHash;
  assert.equal(await verifyAuditChain([first, second]), true);
  assert.equal(await verifyAuditChain([{ ...first, actorId: 'attacker' }, second]), false);
});

test('durable worker attempt count matches database lease semantics', async () => {
  assert.equal(retryDelaySeconds(1), 1);
  assert.equal(retryDelaySeconds(3), 4);
  const actions = [];
  const repository = {
    claim: async () => [], complete: async () => actions.push('complete'),
    retry: async (_id, _worker, _next, code) => actions.push(`retry:${code}`),
    deadLetter: async (_id, _worker, code) => actions.push(`dead:${code}`),
  };
  const handlers = { DOCUMENT_SCAN: async () => { const error = new Error('timeout'); error.name = 'ProviderTimeout'; throw error; } };
  const base = { id: 'job-1', tenantId: 'tenant', type: 'DOCUMENT_SCAN', payload: {}, idempotencyKey: 'job', availableAt: '2026-08-02T00:00:00Z' };
  await processClaimedJob(repository, 'worker-1', { ...base, attempts: 1, maximumAttempts: 3 }, handlers);
  await processClaimedJob(repository, 'worker-1', { ...base, attempts: 3, maximumAttempts: 3 }, handlers);
  assert.deepEqual(actions, ['retry:PROVIDERTIMEOUT', 'dead:PROVIDERTIMEOUT']);
});

test('evidence manifest detects modified file', async () => {
  const original = [{ path: 'signed_document.pdf', bytes: new TextEncoder().encode('pdf-a'), mediaType: 'application/pdf' }];
  const manifest = await createEvidenceManifest('case-1', original, { policy: 1 }, '2026-08-02T00:00:00Z');
  assert.deepEqual(await verifyEvidenceFiles(manifest, original), []);
  const failures = await verifyEvidenceFiles(manifest, [{ ...original[0], bytes: new TextEncoder().encode('pdf-b') }]);
  assert.ok(failures.some((failure) => failure.includes('Hash mismatch')));
});

test('database hardening migration includes lease recovery and same-case guards', async () => {
  const migration = await readFile('migrations/data/0009_integrity_and_worker_recovery.sql', 'utf8');
  assert.match(migration, /status = 'leased' AND candidate\.lease_expires_at < now\(\)/);
  assert.match(migration, /attempts = j\.attempts \+ 1/);
  assert.match(migration, /assert_signature_attempt_consistency/);
  assert.match(migration, /assert_valid_status_transition/);
  assert.match(migration, /assert_case_completion_evidence/);
  assert.match(migration, /digital_approval_evidence/);
  const immutability = await readFile('migrations/data/0010_immutability_and_evidence_states.sql', 'utf8');
  assert.match(immutability, /locked document versions are immutable/);
  assert.match(immutability, /require_trusted_cryptographic_service/);
});

test('provenance gate pins donors and reports zero unverified imports', async () => {
  const report = await verifyProvenance('.');
  assert.equal(report.sources.length, 8);
  assert.equal(report.totalReused, 0);
  assert.ok(report.sources.every((source) => /^[0-9a-f]{40}$/.test(source.pinned_commit)));
  assert.ok(report.sources.every((source) => source.imported === false));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`${tests.length} tests passed`);
