import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { base64Encode, canonicalJson, sha256Hex, hmacSha256Hex, verifyHmacSha256Hex } from '../dist/packages/crypto/src/index.js';
import { resolveTenantContext, assertTenantMatch } from '../dist/packages/tenant-context/src/index.js';
import { canTransitionCase, requireServerEvidenceForCaseStatus } from '../dist/packages/domain/src/state-machines.js';
import { validatePolicyUse } from '../dist/packages/signature-policy/src/index.js';
import {
  assertTicWebhookBinding, parseTicWebhookEnvelope, verifyTicWebhook, TicBankIdProvider,
} from '../dist/packages/provider-adapters/src/tic-bankid.js';
import { SupabaseAuthProvider, validatePassword } from '../dist/packages/provider-adapters/src/supabase-auth.js';
import { bankIdEvidenceBytes } from '../dist/packages/provider-adapters/src/evidence-payload.js';
import { createEvidenceManifest, verifyEvidenceFiles } from '../dist/packages/evidence/src/index.js';
import { createEvidenceZip, verifyEvidenceZip } from '../dist/packages/evidence/src/zip.js';
import { normalizeSwedishPersonalNumber, maskSwedishPersonalNumber, decideIdentifierBinding } from '../dist/packages/personal-number/src/index.js';
import { calculateAuditEventHash, createAuditHashMaterial, verifyAuditChain } from '../dist/packages/audit/src/index.js';
import { processClaimedJob, retryDelaySeconds } from '../dist/apps/workers/src/jobs.js';
import { createApiHandler } from '../dist/apps/api/src/router.js';
import { createHandler as createProductionHandler } from '../dist/apps/api/src/production-runtime.js';
import { verifyProvenance } from '../scripts/provenance-lib.mjs';
import { assertApplicationTransition, assertDistinctApprovers, createEmailVerification, formatApplicationReference, verifyEmailToken } from '../dist/packages/onboarding/src/index.js';
import { evaluateReadiness } from '../dist/packages/readiness/src/index.js';
import { normalizeTenantSlug, canonicalHostname as canonicalTenantHostname, createDomainVerificationChallenge, verifyDomainChallengeValue } from '../dist/packages/custom-domains/src/index.js';
import { TenantHostnameResolver, resolveRequestHostname, resolveTenantPublicUrl, isAllowedCredentialOrigin } from '../dist/packages/tenant-gateway/src/index.js';
import { buildHostOnlySessionCookie, issueAuthorizationCode, exchangeAuthorizationCode } from '../dist/packages/auth-broker/src/index.js';
import { createSensitiveDataAdapter } from '../dist/apps/api/src/adapters/aes-gcm-sensitive-data.js';
import { expectedSupabaseAuthConfig, verifySupabaseAuthConfig } from '../scripts/supabase-auth-config-lib.mjs';
import { hasPlatformPermission } from '../dist/packages/authorization/src/index.js';

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
  tenantId: '11111111-1111-4111-8111-111111111111',
  signatureCaseId: '22222222-2222-4222-8222-222222222222',
  signingIntentId: '33333333-3333-4333-8333-333333333333',
  signerId: '44444444-4444-4444-8444-444444444444',
  signaturePolicyId: '55555555-5555-4555-8555-555555555555', signaturePolicyVersion: 4,
  identifierBindingMode: 'STRICT_PREBOUND', expectedPersonalNumber: '199001010009',
  documents: [{ ordinal: 1, documentId: '66666666-6666-4666-8666-666666666666', documentVersionId: '77777777-7777-4777-8777-777777777777', displayName: 'Beslut.pdf', mimeType: 'application/pdf', profile: 'PDF/A-2b', byteSize: 1200, sha256: 'a'.repeat(64) }],
  visibleText: 'Jag skriver under', endUserIp: '127.0.0.1', userAgent: 'test',
  issuedAt: '2026-08-02T08:00:00.000Z', expiresAt: '2026-08-02T08:05:00.000Z', state: 'state', nonce: 'nonce',
};



test('managed account authentication is invite-only and supports password recovery', async () => {
  validatePassword('Kommunsign!2026');
  assert.throws(() => validatePassword('short'), /PASSWORD_POLICY_FAILED/);
  const calls = [];
  const provider = new SupabaseAuthProvider({
    projectUrl: 'https://example.supabase.co',
    anonKey: 'anon-key',
    serviceRoleKey: 'service-role-key',
    http: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/token?grant_type=password')) {
        return new Response(JSON.stringify({
          access_token: 'a'.repeat(64), expires_in: 3600,
          user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@kommun.se', user_metadata: {} },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/recover?')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const session = await provider.signInWithPassword('ADMIN@KOMMUN.SE', 'Kommunsign!2026');
  assert.equal(session.user.email, 'admin@kommun.se');
  await provider.sendPasswordRecovery('admin@kommun.se', 'https://app.kommunsign.se/aterstall/?destination=admin.kommunsign.se');
  assert.ok(calls.some((call) => call.url.includes('/auth/v1/recover?redirect_to=')));
  assert.ok(calls.every((call) => !String(call.init?.body ?? '').includes('service-role-key')));
});

test('email action links are verified from token hashes only when the password form is submitted', async () => {
  const calls = [];
  const provider = new SupabaseAuthProvider({
    projectUrl: 'https://example.supabase.co', anonKey: 'anon-key', serviceRoleKey: 'service-role-key',
    http: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/auth/v1/verify')) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body, { token_hash: 'h'.repeat(64), type: 'invite' });
        return new Response(JSON.stringify({ access_token: 'a'.repeat(64), expires_in: 3600, user: { id: '33333333-3333-4333-8333-333333333333', email: 'admin@kommun.se', user_metadata: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const verified = await provider.verifyEmailOtp('h'.repeat(64), 'invite');
  assert.equal(verified.user.email, 'admin@kommun.se');
  assert.equal(verified.accessToken, 'a'.repeat(64));
  assert.equal(calls.length, 1);
  const portalSource = await readFile('apps/auth-portal/public/app.js', 'utf8');
  assert.match(portalSource, /token_hash/);
  assert.match(portalSource, /emailCredential\(\)/);
  assert.match(portalSource, /history\.replaceState/);
});

test('login, password recovery and activation require no organization address and route after identity verification', async () => {
  const portalHtml = await readFile('apps/auth-portal/public/index.html', 'utf8');
  const portalSource = await readFile('apps/auth-portal/public/app.js', 'utf8');
  const routerSource = await readFile('apps/api/src/auth-router.ts', 'utf8');
  const repositorySource = await readFile('apps/api/src/production-adapters/postgres/authentication-repository.ts', 'utf8');
  const openApi = await readFile('docs/api/openapi.yaml', 'utf8');
  assert.doesNotMatch(portalHtml, /Organisationsadress|id="organization"/);
  assert.match(portalHtml, /e-postadress och lösenord/);
  assert.doesNotMatch(portalSource, /organizationSlug|destinationInput|normalizeOrganizationSlug/);
  assert.match(portalSource, /password\/forgot',{email:/);
  assert.match(portalSource, /auth\/login',{email:.*password:/);
  assert.match(portalSource, /password\/complete',{\.\.\.credential,password}/);
  assert.match(portalSource, /destinationFromEmailLink/);
  assert.match(portalSource, /destinationHostname/);
  assert.match(routerSource, /allowed\(body, \['email','password'\]\)/);
  assert.match(routerSource, /allowed\(body, \['email'\]\)/);
  assert.match(routerSource, /allowed\(body, \['accessToken','tokenHash','type','destinationHostname','password'\]\)/);
  assert.doesNotMatch(routerSource, /organizationSlug/);
  assert.match(repositorySource, /provider\.signInWithPassword[\s\S]*resolveSubjectDestination\(session\.user\.id\)/);
  assert.match(repositorySource, /verifyEmailOtp[\s\S]*resolvePasswordCompletionDestination\(verified\.user\.id, input\.destinationHostname\)/);
  assert.match(repositorySource, /platform_role_assignments/);
  assert.match(openApi, /LoginRequest:[\s\S]*required: \[email, password\]/);
  assert.match(openApi, /PasswordRecoveryRequest:[\s\S]*required: \[email\]/);
  assert.doesNotMatch(openApi, /organizationSlug/);
});

test('password completion preserves the exact organization destination from the invite link', async () => {
  let captured = null;
  const sessionToken = 's'.repeat(64);
  const compliantPassword = ['Kommunsign', '!', '2026'].join('');
  const handler = createApiHandler({
    resolveContext: async () => ({ tenantId: 'unused', source: 'api-client', subjectId: 'unused', requestId: 'unused', authMethod: 'development' }),
    authorize: () => {},
    authentication: {
      completePassword: async (input) => {
        captured = input;
        return {
          sessionToken,
          subjectId: '11111111-1111-4111-8111-111111111111',
          boundary: 'tenant',
          destinationUrl: 'https://direktkommunen.kommunsign.se/',
          expiresAt: '2026-08-05T12:00:00.000Z',
          csrfToken: 'c'.repeat(64),
          tenantId: '22222222-2222-4222-8222-222222222222',
          displayName: 'Anna Admin',
        };
      },
    },
  });
  const response = await handler(new Request('https://api.kommunsign.se/v1/auth/password/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'password-complete-test' },
    body: JSON.stringify({ tokenHash: 'h'.repeat(64), type: 'invite', destinationHostname: 'Direktkommunen.Kommunsign.SE', password: compliantPassword }),
  }));
  assert.equal(response.status, 200);
  assert.equal(captured.destinationHostname, 'direktkommunen.kommunsign.se');
  assert.match(response.headers.get('set-cookie') ?? '', /__Host-ks_api_session=/);
});

test('async portal forms retain their form element across awaited requests', async () => {
  const adminSource = await readFile('apps/platform-admin/public/app.js', 'utf8');
  const tenantSource = await readFile('apps/tenant-portal/public/app.js', 'utf8');
  const onboardingSource = await readFile('apps/onboarding-portal/public/app.js', 'utf8');
  assert.doesNotMatch(adminSource, /event\.currentTarget\.reset\(\)/);
  assert.doesNotMatch(tenantSource, /event\.currentTarget\.reset\(\)/);
  assert.doesNotMatch(onboardingSource, /event\.currentTarget\.reset\(\)/);
  assert.match(adminSource, /const form=event\.currentTarget[\s\S]*Organisationen .* är skapad, men listan kunde inte uppdateras automatiskt/);
  assert.match(adminSource, /Kontot är skapat, men kontolistan kunde inte uppdateras automatiskt/);
});

test('password recovery exposes rate limits instead of reporting a false accepted result', async () => {
  const provider = new SupabaseAuthProvider({
    projectUrl: 'https://example.supabase.co', anonKey: 'anon-key',
    http: async () => new Response(JSON.stringify({ error_code: 'over_email_send_rate_limit' }), { status: 429, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    () => provider.sendPasswordRecovery('admin@kommun.se', 'https://app.kommunsign.se/aterstall/'),
    (error) => error?.code === 'AUTH_RATE_LIMITED' && error?.status === 429,
  );
});

test('Railway API allows the canonical Vercel origins even when a CORS variable is omitted', async () => {
  const serverSource = await readFile('apps/api/server.mjs', 'utf8');
  assert.match(serverSource, /https:\/\/app\.kommunsign\.se/);
  assert.match(serverSource, /STATIC_ALLOWED_ORIGINS/);
  assert.match(serverSource, /TENANT_DISCOVERY_URL/);
  assert.match(serverSource, /access-control-allow-credentials/);
});

test('an unconfirmed account receives a new activation link without a duplicate identity', async () => {
  const calls = [];
  const provider = new SupabaseAuthProvider({
    projectUrl: 'https://example.supabase.co', anonKey: 'anon-key', serviceRoleKey: 'service-role-key',
    http: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/admin/users?')) {
        return new Response(JSON.stringify({ users: [{ id: '22222222-2222-4222-8222-222222222222', email: 'ny@kommun.se', user_metadata: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/recover?')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected ${url}`);
    },
  });
  const result = await provider.inviteOrFindUser('ny@kommun.se', 'https://app.kommunsign.se/aktivera/?destination=kommun.kommunsign.se', { displayName: 'Ny Admin' });
  assert.equal(result.user.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(result.invited, true);
  assert.ok(calls.some((call) => call.url.includes('/auth/v1/recover?redirect_to=')));
  assert.ok(!calls.some((call) => call.url.includes('/auth/v1/invite?')));
});

test('Supabase Auth production configuration is machine-verifiable', async () => {
  const expected = await expectedSupabaseAuthConfig({
    SUPABASE_AUTH_SITE_URL: 'https://app.kommunsign.se',
    SUPABASE_AUTH_ALLOWED_REDIRECT_URLS: 'https://app.kommunsign.se/aktivera/,https://app.kommunsign.se/aterstall/',
    AUTH_SMTP_PORT: '465', AUTH_SMTP_SENDER_EMAIL: 'konto@notify.kommunsign.se',
    AUTH_SMTP_HOST: 'smtp.resend.com', AUTH_SMTP_USERNAME: 'resend', AUTH_SMTP_SENDER_NAME: 'Kommunsign',
  });
  assert.equal(expected.site_url, 'https://app.kommunsign.se');
  assert.deepEqual(verifySupabaseAuthConfig({ ...expected }, expected), []);
  assert.ok(verifySupabaseAuthConfig({ ...expected, disable_signup: false }, expected).some((problem) => problem.startsWith('disable_signup:')));
  assert.match(expected.mailer_templates_invite_content, /TokenHash/);
  assert.match(expected.mailer_templates_invite_content, /RedirectTo/);
  assert.doesNotMatch(expected.mailer_templates_invite_content, /ConfirmationURL/);
  assert.match(expected.mailer_templates_recovery_content, /\{\{ \.SiteURL \}\}\/aterstall\//);
  await assert.rejects(() => expectedSupabaseAuthConfig({
    SUPABASE_AUTH_SITE_URL: 'https://app.kommunsign.se/login/',
    SUPABASE_AUTH_ALLOWED_REDIRECT_URLS: 'https://app.kommunsign.se/aterstall/',
    AUTH_SMTP_PORT: '465', AUTH_SMTP_SENDER_EMAIL: 'konto@notify.kommunsign.se',
    AUTH_SMTP_HOST: 'smtp.resend.com', AUTH_SMTP_USERNAME: 'resend', AUTH_SMTP_SENDER_NAME: 'Kommunsign',
  }), /SUPABASE_AUTH_SITE_URL_INVALID/);
});

test('shared SaaS provisioning has a ready data plane and worker recovery', async () => {
  const migration = await readFile('migrations/control/0015_shared_saas_data_plane_runtime.sql', 'utf8');
  const worker = await readFile('apps/workers/src/postgres-production-adapter.ts', 'utf8');
  const onboarding = await readFile('apps/api/src/production-adapters/postgres/onboarding-repository.ts', 'utf8');
  assert.match(migration, /'shared_saas',[\s\S]*'ready',[\s\S]*'se-central'/);
  assert.match(migration, /DATA_PLANE_NOT_READY/);
  assert.match(worker, /recoverProvisioningJobs/);
  assert.match(worker, /waiting_for_external_dependency/);
  assert.match(worker, /tenant-provision-recovery:/);
  assert.match(onboarding, /'create_tenant','assign_data_plane','create_environment'/);
  assert.match(onboarding, /deployment\.mode==='shared_saas'\?'se-central'/);
  assert.doesNotMatch(onboarding, /'create_tenant','create_environment','assign_data_plane'/);
});

test('organization provisioning never creates an applicant login automatically', async () => {
  const source = await readFile('apps/api/src/production-adapters/postgres/provisioning-repository.ts', 'utf8');
  assert.doesNotMatch(source, /pending-invite:/);
  assert.doesNotMatch(source, /TENANT_ADMIN_INVITATION/);
  assert.match(source, /create_first_organization_admin/);
  assert.match(source, /applicantAccountCreated: false/);
});

test('onboarding state machine, reference and email tokens fail closed', async () => {
  assertApplicationTransition('email_verification_pending', 'email_verified');
  assertApplicationTransition('submitted', 'approved');
  assertApplicationTransition('submitted', 'rejected');
  assertApplicationTransition('additional_information_requested', 'approved');
  assertApplicationTransition('additional_information_requested', 'rejected');
  assertApplicationTransition('approved', 'provisioning');
  assert.throws(() => assertApplicationTransition('submitted', 'active'), /INVALID_APPLICATION_STATE_TRANSITION/);
  assert.equal(formatApplicationReference(2026, 1), 'ONB-2026-000001');
  const created = await createEmailVerification({ applicationId: 'a1', email: 'IT@Kommun.SE', expiresAt: '2026-08-02T12:30:00.000Z', now: new Date('2026-08-02T12:00:00.000Z') });
  await verifyEmailToken(created.record, created.token, 'it@kommun.se', new Date('2026-08-02T12:05:00.000Z'));
  await assert.rejects(() => verifyEmailToken(created.record, `${created.token}0`, 'it@kommun.se', new Date('2026-08-02T12:05:00.000Z')));
  assert.throws(() => assertDistinctApprovers('actor-1', 'actor-1'), /TWO_PERSON_APPROVAL_REQUIRED/);
});

test('production JSONB parameters are passed as native objects instead of double-encoded strings', async () => {
  const onboardingSource = await readFile('apps/api/src/production-adapters/postgres/onboarding-repository.ts', 'utf8');
  const queueSource = await readFile('apps/api/src/adapters/postgres-queue.ts', 'utf8');
  const provisioningSource = await readFile('apps/api/src/production-adapters/postgres/provisioning-repository.ts', 'utf8');
  assert.doesNotMatch(onboardingSource, /JSON\.stringify\(profile\)/);
  assert.match(onboardingSource, /applicant_visible_profile,assigned_to[\s\S]*profile,context\.subjectId/);
  assert.doesNotMatch(queueSource, /JSON\.stringify\(input\.payload\)/);
  assert.doesNotMatch(provisioningSource, /JSON\.stringify\(permissions\)|JSON\.stringify\(policy\)|JSON\.stringify\(\{ identityAndAccess/);
});

test('production API bootstrap never falls back to development repositories', async () => {
  const previousEnvironment = process.env.APP_ENV;
  const previousModule = process.env.KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE;
  process.env.APP_ENV = 'production';
  delete process.env.KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE;
  try {
    await assert.rejects(() => createProductionHandler(), /CONTROL_DATABASE_URL_MISSING/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previousEnvironment;
    if (previousModule === undefined) delete process.env.KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE; else process.env.KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE = previousModule;
  }
});

test('domain gateway derives tenant only from an active canonical hostname', async () => {
  assert.equal(normalizeTenantSlug('Region Östergötland'), 'region-ostergotland');
  assert.throws(() => normalizeTenantSlug('admin'), /TENANT_SLUG_RESERVED/);
  assert.equal(canonicalTenantHostname('SIGNERING.KUNGALV.SE.'), 'signering.kungalv.se');
  assert.equal(canonicalTenantHostname('münchen.example'), 'xn--mnchen-3ya.example');
  const events = [];
  const domain = {
    domainId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
    environmentId: '33333333-3333-4333-8333-333333333333', environment: 'production', dataPlaneId: '44444444-4444-4444-8444-444444444444',
    hostname: 'kungalv.kommunsign.se', primaryHostname: 'signering.kungalv.se', defaultHostname: 'kungalv.kommunsign.se', status: 'active',
  };
  const resolver = new TenantHostnameResolver({
    findActiveByHostname: async (hostname) => hostname === domain.hostname ? domain : null,
    recordRoutingEvent: async (event) => { events.push(event); },
  }, { trustProxy: false, trustedProxyProvider: 'none', requireVerifiedForwardedHost: true, now: () => 1_000, cacheTtlMs: 5_000 });
  const resolved = await resolver.resolve(new Request('https://kungalv.kommunsign.se/app', { headers: { host: 'kungalv.kommunsign.se' } }), '55555555-5555-4555-8555-555555555555');
  assert.equal(resolved.tenantId, domain.tenantId);
  assert.equal(resolveTenantPublicUrl(domain, 'signer_invitation', 'a'.repeat(32)).href, `https://signering.kungalv.se/sign/${'a'.repeat(32)}`);
  assert.equal(isAllowedCredentialOrigin('https://signering.kungalv.se', new Set(['signering.kungalv.se'])), true);
  await assert.rejects(() => resolver.resolve(new Request('https://unknown.kommunsign.se', { headers: { host: 'unknown.kommunsign.se' } })), /TENANT_DOMAIN_NOT_FOUND/);
  assert.ok(events.some((event) => event.eventType === 'unknown_host_rejected'));
});


test('Railway forwarded host is trusted only with Railway edge headers', () => {
  const options = { trustProxy: true, trustedProxyProvider: 'railway', requireVerifiedForwardedHost: true };
  const trusted = new Request('http://api.railway.internal/v1/auth/session', { headers: {
    host: 'api.railway.internal',
    'x-forwarded-host': 'app.kommunsign.se',
    'x-forwarded-proto': 'https',
    'x-real-ip': '192.0.2.10',
    'x-railway-edge': 'arn1',
    'x-railway-request-id': 'request-1',
  } });
  assert.equal(resolveRequestHostname(trusted, options), 'app.kommunsign.se');
  const spoofed = new Request('http://api.railway.internal/v1/auth/session', { headers: {
    host: 'api.railway.internal',
    'x-forwarded-host': 'app.kommunsign.se',
    'x-forwarded-proto': 'https',
  } });
  assert.throws(() => resolveRequestHostname(spoofed, options), /UNVERIFIED_FORWARDED_HOST/);
});

test('domain challenge and auth exchange are single-use and host-bound', async () => {
  const challengeTenantId = '11111111-1111-4111-8111-111111111111';
  const challenge = await createDomainVerificationChallenge({ tenantId: challengeTenantId, hostname: 'signering.kungalv.se', expiresAt: '2026-08-02T10:30:00Z', now: new Date('2026-08-02T10:00:00Z') });
  assert.equal(await verifyDomainChallengeValue({ tenantId: challengeTenantId, hostname: 'signering.kungalv.se', expectedRecordValueHash: challenge.recordValueHash, observedValues: [challenge.recordValue] }), true);
  assert.equal(await verifyDomainChallengeValue({ tenantId: challengeTenantId, hostname: 'signering.kungalv.se', expectedRecordValueHash: challenge.recordValueHash, observedValues: [`${challenge.recordValue}x`] }), false);
  const records = new Map();
  const store = {
    create: async (record) => { records.set(record.codeHash, record); },
    consume: async (codeHash, now) => {
      const record = records.get(codeHash);
      if (!record || record.usedAt) return null;
      const consumed = { ...record, usedAt: now.toISOString() };
      records.set(codeHash, consumed);
      return { ...record };
    },
  };
  const issued = await issueAuthorizationCode({ store, tenantId: 't1', subjectId: 's1', destinationHostname: 'signering.kungalv.se', authMethod: 'oidc', signingKey: 'k'.repeat(32), now: new Date('2026-08-02T10:00:00Z') });
  const exchanged = await exchangeAuthorizationCode({ store, code: issued.code, destinationHostname: 'signering.kungalv.se', signingKey: 'k'.repeat(32), now: new Date('2026-08-02T10:00:30Z') });
  assert.equal(exchanged.tenantId, 't1');
  await assert.rejects(() => exchangeAuthorizationCode({ store, code: issued.code, destinationHostname: 'signering.kungalv.se', signingKey: 'k'.repeat(32), now: new Date('2026-08-02T10:00:31Z') }));
  const cookie = buildHostOnlySessionCookie('tenant', 'o'.repeat(32), { secure: true, maxAgeSeconds: 3600 });
  assert.match(cookie, /^__Host-ks_tenant_session=/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(cookie, /HttpOnly/);
});

test('production sensitive-data adapter authenticates ciphertext and purpose', async () => {
  const encryptionKey = base64Encode(new Uint8Array(32).fill(7));
  const blindIndexKey = base64Encode(new Uint8Array(32).fill(9));
  const adapter = await createSensitiveDataAdapter({
    SENSITIVE_DATA_ENCRYPTION_KEY_BASE64: encryptionKey,
    SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64: blindIndexKey,
  });
  const ciphertext = await adapter.encryptText('it@kommun.se', 'onboarding.primary_email');
  assert.notEqual(new TextDecoder().decode(ciphertext), 'it@kommun.se');
  assert.equal(await adapter.decryptText(ciphertext, 'onboarding.primary_email'), 'it@kommun.se');
  await assert.rejects(() => adapter.decryptText(ciphertext, 'tenant.user_email'), /SENSITIVE_DATA_DECRYPTION_FAILED/);
  assert.deepEqual(
    await adapter.blindIndex(' IT@Kommun.SE ', 'onboarding.primary_email'),
    await adapter.blindIndex('it@kommun.se', 'onboarding.primary_email'),
  );
});

test('production adapter module paths resolve to built files', async () => {
  const environment = await readFile('.env.example', 'utf8');
  assert.match(environment, /KOMMUNSIGN_OBJECT_STORAGE_ADAPTER_MODULE=\.\.\/\.\.\/adapters\/supabase-storage\.js/);
  assert.match(environment, /KOMMUNSIGN_QUEUE_ADAPTER_MODULE=\.\.\/\.\.\/adapters\/postgres-queue\.js/);
  assert.match(environment, /KOMMUNSIGN_SENSITIVE_DATA_ADAPTER_MODULE=\.\.\/\.\.\/adapters\/aes-gcm-sensitive-data\.js/);
  await Promise.all([
    import('../dist/apps/api/src/adapters/supabase-storage.js'),
    import('../dist/apps/api/src/adapters/postgres-queue.js'),
    import('../dist/apps/api/src/adapters/aes-gcm-sensitive-data.js'),
    import('../dist/apps/workers/src/postgres-production-adapter.js'),
  ]);
});

test('readiness separates blocking, warnings and completed checks', () => {
  const checkedAt = '2026-08-02T12:00:00.000Z';
  const result = evaluateReadiness('production', [
    { code: 'DATABASE', passed: true, severity: 'blocking', checkedAt },
    { code: 'SIGN_SERVICE_NOT_CONFIGURED', passed: false, severity: 'blocking', checkedAt },
    { code: 'ARCHIVE_OPTIONAL', passed: false, severity: 'warning', checkedAt },
  ]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingChecks.map((item) => item.code), ['SIGN_SERVICE_NOT_CONFIGURED']);
  assert.deepEqual(result.warningChecks.map((item) => item.code), ['ARCHIVE_OPTIONAL']);
});

test('Swedish personal number policy validates, masks and authorizes exceptions', () => {
  assert.equal(normalizeSwedishPersonalNumber('1990-01-01-0009'), '199001010009');
  assert.equal(maskSwedishPersonalNumber('199001010009'), '1990••••-0009');
  assert.throws(() => normalizeSwedishPersonalNumber('199001011234'), /PERSONAL_NUMBER_INVALID/);
  assert.deepEqual(decideIdentifierBinding({ personalNumber: '199001010009', requirePersonalNumberMatch: true, tenantAllowsException: false, actorHasExceptionPermission: false }), { mode: 'STRICT_PREBOUND', normalizedPersonalNumber: '199001010009' });
  assert.throws(() => decideIdentifierBinding({ personalNumber: null, requirePersonalNumberMatch: false, exception: { code: 'UNKNOWN_AT_INVITATION' }, tenantAllowsException: true, actorHasExceptionPermission: false }), /PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED/);
  assert.deepEqual(decideIdentifierBinding({ personalNumber: null, requirePersonalNumberMatch: false, exception: { code: 'UNKNOWN_AT_INVITATION' }, tenantAllowsException: true, actorHasExceptionPermission: true }), { mode: 'BANKID_DISCOVERED', exception: { code: 'UNKNOWN_AT_INVITATION' } });
});

test('canonical JSON is deterministic', async () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('base64 encoder is deterministic and standards-compatible', () => {
  assert.equal(base64Encode(new TextEncoder().encode('KommunSign')), 'S29tbXVuU2lnbg==');
  assert.equal(base64Encode(new Uint8Array()), '');
});

test('tenant sources must agree', () => {
  const context = resolveTenantContext({ requestId: 'r1', subjectId: 's1', authMethod: 'development', verifiedDomainTenantId: 't1', membershipTenantId: 't1' });
  assert.equal(context.tenantId, 't1');
  assert.throws(() => resolveTenantContext({ requestId: 'r1', subjectId: 's1', authMethod: 'development', verifiedDomainTenantId: 't1', membershipTenantId: 't2' }));
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

test('TIC adapter uses operation-specific methods, paths and canonical evidence', async () => {
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
  assert.equal(startBody.userNonVisibleData, new TextDecoder().decode(bankIdEvidenceBytes(identityInput)));
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
  const signature = await hmacSha256Hex('secret', rawBody);
  assert.equal(await verifyHmacSha256Hex('secret', rawBody, signature), true);
  assert.equal(await verifyTicWebhook({ rawBody, timestamp, signature, secret: 'secret', nowEpochSeconds: 1100 }), true);
  assert.equal(await verifyTicWebhook({ rawBody, timestamp, signature, secret: 'secret', nowEpochSeconds: 1401 }), false);
  const envelope = parseTicWebhookEnvelope(rawBody);
  assertTicWebhookBinding(envelope, { sessionId: 's1', state: 'state' });
  assert.throws(() => assertTicWebhookBinding(envelope, { sessionId: 's2', state: 'state' }));
});

test('API rejects malformed and unsupported JSON without leaking internals', async () => {
  const context = { tenantId: 'tenant', source: 'api-client', subjectId: 'subject', requestId: 'ctx', authMethod: 'development' };
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
  const context = { tenantId: 'tenant', source: 'api-client', subjectId: 'subject', requestId: 'ctx', authMethod: 'development' };
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
  const context = { tenantId: 'tenant', source: 'api-client', subjectId: 'subject', requestId: 'ctx', authMethod: 'development' };
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

test('evidence ZIP is deterministic and rejects modified archive bytes', async () => {
  const file = { path: 'documents/001-beslut.pdf', bytes: new TextEncoder().encode('%PDF-test'), mediaType: 'application/pdf' };
  const manifest = await createEvidenceManifest('case-zip', [file], { packageType: 'case' }, '2026-08-03T00:00:00.000Z');
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const checksums = new TextEncoder().encode(`${manifest.entries[0].sha256}  ${manifest.entries[0].path}\n`);
  const first = createEvidenceZip([{ path: file.path, bytes: file.bytes }, { path: 'manifest.json', bytes: manifestBytes }, { path: 'checksums.sha256', bytes: checksums }]);
  const second = createEvidenceZip([{ path: 'checksums.sha256', bytes: checksums }, { path: 'manifest.json', bytes: manifestBytes }, { path: file.path, bytes: file.bytes }]);
  assert.deepEqual(first, second);
  assert.equal((await verifyEvidenceZip(first)).verified, true);
  const changed = first.slice(); changed[Math.floor(changed.length / 3)] ^= 1;
  assert.equal((await verifyEvidenceZip(changed)).verified, false);
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

test('direct organization creation is reserved for platform superadmin', () => {
  assert.equal(hasPlatformPermission(['platform_super_admin'], 'organization:create'), true);
  for (const role of ['platform_operations','onboarding_manager','provisioning_operator','platform_support']) {
    assert.equal(hasPlatformPermission([role], 'organization:create'), false, `${role} must not bypass onboarding review`);
  }
});

test('superadmin organization management and tenant agreement flow are connected end to end', async () => {
  const adminHtml = await readFile('apps/platform-admin/public/index.html', 'utf8');
  const adminSource = await readFile('apps/platform-admin/public/app.js', 'utf8');
  const tenantHtml = await readFile('apps/tenant-portal/public/index.html', 'utf8');
  const tenantSource = await readFile('apps/tenant-portal/public/app.js', 'utf8');
  const authRepository = await readFile('apps/api/src/production-adapters/postgres/authentication-repository.ts', 'utf8');
  const openApi = await readFile('docs/api/openapi.yaml', 'utf8');
  assert.match(adminHtml, /Skapa organisation/);
  assert.match(adminHtml, /Organisationer/);
  assert.match(adminSource, /\/v1\/platform\/organizations/);
  assert.match(adminSource, /Bjud in huvudadmin/);
  assert.match(adminSource, /organizationReady/);
  assert.match(adminSource, /domainReady/);
  assert.doesNotMatch(adminSource, /domainReady:true/);
  assert.match(authRepository, /inviteOrFindUser/);
  assert.match(authRepository, /provisionTenantUser/);
  assert.match(authRepository, /resolveSubjectDestination/);
  assert.match(tenantHtml, /Nytt signeringsärende/);
  assert.match(tenantSource, /\/v1\/signature-policies/);
  assert.match(tenantSource, /\/v1\/signature-cases/);
  assert.doesNotMatch(tenantSource, /value=["']33333333-3333-4333-8333-333333333333/);
  assert.match(openApi, /operationId: listPlatformOrganizations/);
  assert.match(openApi, /operationId: createPlatformOrganization/);
  assert.match(openApi, /operationId: listSignaturePolicies/);
});

test('unified Vercel deployment builds all portals and uses customer-facing production language', async () => {
  const html = await readFile('apps/public-website/public/index.html', 'utf8');
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.match(html, /Säker signering med BankID/);
  assert.doesNotMatch(html, /inte produktionsklar|under utveckling|tenantseparerad/i);
  assert.match(html, /Kommunsign/i);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.equal(config.buildCommand, 'npm run build:vercel');
  assert.equal(config.outputDirectory, 'build/vercel');
  assert.ok(config.routes.some((entry) => entry.has?.some((condition) => condition.type === 'host' && condition.value === 'admin.kommunsign.se')));
  assert.ok(config.routes.some((entry) => entry.dest === '/__portals/tenant/index.html'));
  assert.ok(config.routes.some((entry) => entry.headers?.['Content-Security-Policy']));
  assert.ok(config.routes.some((entry) => entry.handle === 'filesystem'));
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
