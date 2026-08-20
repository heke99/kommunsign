import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOidcTransaction, verifyOidcCallback } from '../dist/packages/auth/src/index.js';
import { contrastRatio, validateAndNormalizeBranding } from '../dist/packages/branding/src/index.js';
import { assertDomainTransition, canonicalHostname } from '../dist/packages/custom-domains/src/index.js';
import { createInvitationToken, verifyInvitationToken } from '../dist/packages/invitations/src/index.js';
import { assertMagicBytesMatch, storedBytesMatchGrant, validateUploadMetadata } from '../dist/packages/uploads/src/index.js';
import { assertResolvedWebhookAddresses, assertSafeWebhookUrl } from '../dist/packages/webhooks/src/index.js';

assert.throws(() => validateAndNormalizeBranding({ productName: '<script>x</script>', primaryColor: '#174a7e', accentColor: '#f2b705' }));
const branding = validateAndNormalizeBranding({ productName: 'Kungälvs kommun', primaryColor: '#174a7e', accentColor: '#f2b705', logoUrl: 'https://cdn.example/logo.svg' });
assert.ok(contrastRatio(branding.primaryColor, branding.primaryTextColor) >= 4.5);
assert.throws(() => assertSafeWebhookUrl('http://example.com/hook'));
assert.throws(() => assertSafeWebhookUrl('https://127.0.0.1/hook'));
assert.throws(() => assertResolvedWebhookAddresses(['10.0.0.2']));
assert.equal(assertSafeWebhookUrl('https://hooks.example.com/kommunsign').hostname, 'hooks.example.com');
assert.equal(canonicalHostname('SIGN.KUNGALV.SE.'), 'sign.kungalv.se');
assert.throws(() => canonicalHostname('tenant.kommunsign.se'));
assertDomainTransition('requested', 'dns_challenge_created');
assert.throws(() => assertDomainTransition('requested', 'active'));
validateUploadMetadata({ fileName: 'beslut.pdf', mimeType: 'application/pdf', byteSize: 100, sha256: 'f'.repeat(64) }, { allowedMimeTypes: ['application/pdf'], maximumBytes: 1000 });
assertMagicBytesMatch('application/pdf', new TextEncoder().encode('%PDF-1.7'));
assert.throws(() => assertMagicBytesMatch('application/pdf', new TextEncoder().encode('<html>')));

const invitation = await createInvitationToken({
  tenantId: 't1', signatureCaseId: 'c1', signerId: 's1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
await verifyInvitationToken(invitation.record, invitation.token);
await assert.rejects(() => verifyInvitationToken(invitation.record, `${invitation.token}0`));

const oidc = await createOidcTransaction('https://app.example/callback', new Date('2026-08-02T10:00:00Z'));
verifyOidcCallback(oidc, { state: oidc.state, nonce: oidc.nonce, redirectUri: oidc.redirectUri, now: new Date('2026-08-02T10:01:00Z') });
assert.throws(() => verifyOidcCallback(oidc, { state: 'wrong', nonce: oidc.nonce, redirectUri: oidc.redirectUri, now: new Date('2026-08-02T10:01:00Z') }));

// The hash of an uploaded file is verified against what the uploader committed to. That check used
// to run while confirming the upload and now runs in the scan, which already holds the bytes. The
// move is only safe if the check itself still refuses everything it refused before, so the cases
// that must fail are pinned here rather than left to the handler that happens to call it today.
const CLEAN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
assert.equal(storedBytesMatchGrant({ expectedSha256: CLEAN, actualSha256: CLEAN, expectedByteSize: 10, actualByteSize: 10 }), true);
// A different file of exactly the same length is the case the size check alone cannot catch.
assert.equal(storedBytesMatchGrant({ expectedSha256: CLEAN, actualSha256: OTHER, expectedByteSize: 10, actualByteSize: 10 }), false);
assert.equal(storedBytesMatchGrant({ expectedSha256: CLEAN, actualSha256: CLEAN, expectedByteSize: 10, actualByteSize: 11 }), false);
// A missing or malformed hash must not read as "nothing to compare, so it passes".
for (const value of ['', '   ', 'not-a-hash', CLEAN.slice(0, 63), `${CLEAN}0`, CLEAN.replaceAll('a', 'z')]) {
  assert.equal(storedBytesMatchGrant({ expectedSha256: value, actualSha256: CLEAN, expectedByteSize: 10, actualByteSize: 10 }), false);
  assert.equal(storedBytesMatchGrant({ expectedSha256: CLEAN, actualSha256: value, expectedByteSize: 10, actualByteSize: 10 }), false);
}
// Case and surrounding whitespace are presentation, not a mismatch.
assert.equal(storedBytesMatchGrant({ expectedSha256: ` ${CLEAN.toUpperCase()} `, actualSha256: CLEAN, expectedByteSize: 10, actualByteSize: 10 }), true);
// A size that is not a whole number of bytes is not a size.
assert.equal(storedBytesMatchGrant({ expectedSha256: CLEAN, actualSha256: CLEAN, expectedByteSize: 10.5, actualByteSize: 10.5 }), false);
assert.equal(storedBytesMatchGrant({ expectedSha256: CLEAN, actualSha256: CLEAN, expectedByteSize: Number.NaN, actualByteSize: Number.NaN }), false);

// The scan handler is the only place this now runs, and a document that fails it must be rejected
// rather than allowed onward. Reading the source is a blunt check, but the alternative is no check
// at all until someone runs the worker against a real database.
const scanSource = await readFile(new URL('../apps/workers/src/production-handlers.ts', import.meta.url), 'utf8');
assert.match(scanSource, /storedBytesMatchGrant\(\{[\s\S]{0,400}?DOCUMENT_HASH_MISMATCH/);

console.log('security tests: branding, SSRF, domains, uploads, invitations and OIDC passed');
