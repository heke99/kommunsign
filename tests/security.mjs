import assert from 'node:assert/strict';
import { createOidcTransaction, verifyOidcCallback } from '../dist/packages/auth/src/index.js';
import { contrastRatio, validateAndNormalizeBranding } from '../dist/packages/branding/src/index.js';
import { assertDomainTransition, canonicalHostname } from '../dist/packages/custom-domains/src/index.js';
import { createInvitationToken, verifyInvitationToken } from '../dist/packages/invitations/src/index.js';
import { assertMagicBytesMatch, validateUploadMetadata } from '../dist/packages/uploads/src/index.js';
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

console.log('security tests: branding, SSRF, domains, uploads, invitations and OIDC passed');
