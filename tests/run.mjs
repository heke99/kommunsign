import assert from 'node:assert/strict';
import { canonicalJson, sha256Hex, hmacSha256Hex, verifyHmacSha256Hex } from '../dist/packages/crypto/src/index.js';
import { resolveTenantContext, assertTenantMatch } from '../dist/packages/tenant-context/src/index.js';
import { canTransitionCase, requireServerEvidenceForCaseStatus } from '../dist/packages/domain/src/state-machines.js';
import { validatePolicyUse } from '../dist/packages/signature-policy/src/index.js';
import { verifyTicWebhook, TicBankIdProvider } from '../dist/packages/provider-adapters/src/tic-bankid.js';
import { bankIdEvidenceBytes } from '../dist/packages/provider-adapters/src/evidence-payload.js';
import { createEvidenceManifest, verifyEvidenceFiles } from '../dist/packages/evidence/src/index.js';

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('canonical JSON is deterministic', async () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('tenant sources must agree', () => {
  const context = resolveTenantContext({ requestId: 'r1', subjectId: 's1', verifiedDomainTenantId: 't1', membershipTenantId: 't1' });
  assert.equal(context.tenantId, 't1');
  assert.throws(() => resolveTenantContext({ requestId: 'r1', subjectId: 's1', verifiedDomainTenantId: 't1', membershipTenantId: 't2' }));
  assert.throws(() => assertTenantMatch(context, 't2'));
});
test('terminal status requires technical evidence', () => {
  assert.equal(canTransitionCase('in_progress', 'completed'), true);
  assert.throws(() => requireServerEvidenceForCaseStatus('completed', { allRequiredSignersSigned: true, validationAccepted: false, archiveCompleted: false }));
  requireServerEvidenceForCaseStatus('completed', { allRequiredSignersSigned: true, validationAccepted: true, archiveCompleted: false });
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
  const input = {
    tenantId: 't1', signatureCaseId: 'c1', documentId: 'd1', documentVersionId: 'v1',
    documentSha256: 'a'.repeat(64), signaturePolicyId: 'p1', signaturePolicyVersion: 4,
    signerId: 's1', visibleText: 'Jag skriver under', endUserIp: '127.0.0.1', userAgent: 'test',
    issuedAt: '2026-08-02T08:00:00.000Z', expiresAt: '2026-08-02T08:05:00.000Z', state: 'state', nonce: 'nonce',
  };
  assert.deepEqual(bankIdEvidenceBytes(input), bankIdEvidenceBytes(input));
  const provider = new TicBankIdProvider({ baseUrl: 'https://id.tic.io/api/v1', apiKey: 'not-used', callbackUrl: 'https://example/callback', webhookUrl: 'https://example/webhook', paths: { start: '/auth/bankid/sign' } });
  await assert.rejects(() => provider.verifyEvidence({ provider: 'TIC_BANKID', providerReference: 'r', rawPayload: {}, collectedAt: input.issuedAt }));
});

test('HMAC verification and timestamp window', async () => {
  const rawBody = new TextEncoder().encode('{"event":"ok"}');
  const timestamp = '1000';
  const combined = new Uint8Array(new TextEncoder().encode(`${timestamp}.`).length + rawBody.length);
  combined.set(new TextEncoder().encode(`${timestamp}.`)); combined.set(rawBody, new TextEncoder().encode(`${timestamp}.`).length);
  const signature = await hmacSha256Hex('secret', combined);
  assert.equal(await verifyHmacSha256Hex('secret', combined, signature), true);
  assert.equal(await verifyTicWebhook({ rawBody, timestamp, signature, secret: 'secret', nowEpochSeconds: 1100 }), true);
  assert.equal(await verifyTicWebhook({ rawBody, timestamp, signature, secret: 'secret', nowEpochSeconds: 1401 }), false);
});
test('evidence manifest detects modified file', async () => {
  const original = [{ path: 'signed_document.pdf', bytes: new TextEncoder().encode('pdf-a'), mediaType: 'application/pdf' }];
  const manifest = await createEvidenceManifest('case-1', original, { policy: 1 }, '2026-08-02T00:00:00Z');
  assert.deepEqual(await verifyEvidenceFiles(manifest, original), []);
  const failures = await verifyEvidenceFiles(manifest, [{ ...original[0], bytes: new TextEncoder().encode('pdf-b') }]);
  assert.ok(failures.some((failure) => failure.includes('Hash mismatch')));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`${tests.length} tests passed`);
