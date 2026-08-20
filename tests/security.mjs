import assert from 'node:assert/strict';
import { contrastRatio, validateAndNormalizeBranding } from '../dist/packages/branding/src/index.js';
import { assertDomainTransition, canonicalHostname } from '../dist/packages/custom-domains/src/index.js';
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

// Invitation tokens and the federated login handshake were exercised here
// against packages no application reached. Both exist in the running service:
// invitation tokens are minted, blind-indexed, expired and revoked by
// data-database.ts, signing-groups.ts and public-signing-repository.ts, and
// tests/sql/document-delivery.sql covers the token guards in the database;
// the SAML and OIDC handshake, including replay, lives in federation-router.ts
// and is covered by tests/sql/federation-replay.sql.

console.log('security tests: branding, SSRF, domains and uploads passed');
