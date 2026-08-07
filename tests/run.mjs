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
import { createAuthenticationRepository } from '../dist/apps/api/src/production-adapters/postgres/authentication-repository.js';
import { expectedSupabaseAuthConfig, verifySupabaseAuthConfig } from '../scripts/supabase-auth-config-lib.mjs';
import { hasPlatformPermission, hasPermission } from '../dist/packages/authorization/src/index.js';
import {
  ACCESS_LOG_MINIMUM_RETENTION_DAYS, assertPolicyIsLawful, buildGallringReport, decideRetention,
} from '../dist/packages/retention/src/index.js';
import {
  assuranceAtLeast, availableMethods, capabilitiesFor, resolveIdentityMethod,
} from '../dist/packages/identity-registry/src/index.js';
import {
  admitPadesSignature, attainedPadesLevel, describePadesLevel,
} from '../dist/packages/pades/src/index.js';
import {
  buildDataSubjectResponse, erasureExemption, isOverdue,
} from '../dist/packages/privacy/src/index.js';
import {
  assertSigningRuntimeUsable, beginSigningPipeline, collectSignatureEvidence, describeStage,
  NotConfiguredSignatureValidator, NotConfiguredSigningEngine, NotConfiguredTimestampProvider,
  pipelineIsComplete, recordAdmitted, recordIdentityVerified, recordPolicyResolved,
  recordSignatureCreated, recordTimestamped, recordValidated,
} from '../dist/packages/signing-engine/src/index.js';
import {
  frejaAssuranceLevel, FrejaProvider, InMemoryFrejaNonceLedger, RejectingFrejaSignatureVerifier,
  toVerifiedIdentityEvidence, verifyFrejaSignatureClaims,
} from '../dist/packages/provider-adapters/src/freja.js';
import {
  InMemoryAssertionLedger, mapWorkforceIdentity, resolveLogoutTargets, verifyWorkforceAssertion,
} from '../dist/packages/federation/src/index.js';
import {
  applyGroupMembership, applyScimPatch, assertScimTenant, createScimUser, deprovisionScimUser,
  matchesScimFilter, paginateScim, parseScimFilter, resolveScimRoles, SCIM_MAXIMUM_PAGE_SIZE,
  ScimError, toScimUserResource,
} from '../dist/packages/scim/src/index.js';
import {
  buildArchivePackage, buildDescriptiveMetadata, verifyArchivePackage,
} from '../dist/packages/archive/src/index.js';
import {
  abandonGallring, approveGallring, beginGallringExecution, completeGallring,
  MANDATORY_CASE_TARGETS, planGallring, selectDueCases, verifyGallringExecution,
} from '../dist/packages/retention/src/executor.js';
import {
  beginHandling, deadlineFor, deliverResponse, fulfilRequest, overdueRequests,
  refuseRequest, verifySubjectIdentity,
} from '../dist/packages/privacy/src/executor.js';

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

test('an unconfirmed account is reused without duplicate identity or duplicate email', async () => {
  const calls = [];
  const provider = new SupabaseAuthProvider({
    projectUrl: 'https://example.supabase.co', anonKey: 'anon-key', serviceRoleKey: 'service-role-key',
    http: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/admin/users?')) {
        return new Response(JSON.stringify({ users: [{ id: '22222222-2222-4222-8222-222222222222', email: 'ny@kommun.se', user_metadata: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const result = await provider.inviteOrFindUser('ny@kommun.se', 'https://app.kommunsign.se/aktivera/?destination=kommun.kommunsign.se', { displayName: 'Ny Admin' });
  assert.equal(result.user.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(result.state, 'pending');
  assert.ok(!calls.some((call) => call.url.includes('/auth/v1/recover?')));
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

test('organization invitation does not contact Supabase before the tenant data environment is ready', async () => {
  let providerCalls = 0;
  const controlDatabase = {
    transaction: async (work) => work({
      query: async (sql) => {
        if (sql.includes('from control.organization_account_invitations') && sql.includes('idempotency_key')) return { rows: [], rowCount: 0 };
        if (sql.includes('from control.platform_tenants t')) return {
          rows: [{ tenant_status: 'provisioning', provisioning_completed: false, environment_ready: false }], rowCount: 1,
        };
        throw new Error(`unexpected control query: ${sql}`);
      },
    }),
  };
  const dataDatabase = { transaction: async () => { throw new Error('data database must not be contacted'); } };
  const infrastructure = {
    sensitiveData: {
      encryptText: async () => new Uint8Array([1, 2, 3]),
      decryptText: async () => 'admin@kommun.se',
      blindIndex: async () => new Uint8Array([4, 5, 6]),
    },
  };
  const provider = {
    inviteOrFindUser: async () => { providerCalls += 1; throw new Error('provider must not be contacted'); },
  };
  const repository = createAuthenticationRepository(controlDatabase, dataDatabase, infrastructure, provider, {
    rootDomain: 'kommunsign.se', platformAdminHostname: 'admin.kommunsign.se',
    tenantDiscoveryHostname: 'app.kommunsign.se', authPortalUrl: 'https://app.kommunsign.se', sessionLifetimeSeconds: 3600,
  });
  await assert.rejects(
    () => repository.inviteOrganizationUser(
      { subjectId: '99999999-9999-4999-8999-999999999999', requestId: 'invite-readiness-test', roles: ['platform_super_admin'] },
      '22222222-2222-4222-8222-222222222222',
      { displayName: 'Anna Admin', email: 'admin@kommun.se', roleKey: 'tenant_admin' },
      'invite-readiness-test-0001',
      'a'.repeat(64),
    ),
    /ORGANIZATION_PROVISIONING_NOT_COMPLETED/,
  );
  assert.equal(providerCalls, 0);
});

test('an existing confirmed identity receives a fresh password link only after local access exists', async () => {
  const events = [];
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const providerUserId = '33333333-3333-4333-8333-333333333333';
  const invitationId = '44444444-4444-4444-8444-444444444444';
  const controlDatabase = {
    transaction: async (work) => work({
      query: async (sql) => {
        if (sql.includes('from control.organization_account_invitations') && sql.includes('idempotency_key')) return { rows: [], rowCount: 0 };
        if (sql.includes('from control.platform_tenants t')) return { rows: [{ tenant_status: 'onboarding', provisioning_completed: true, environment_ready: true }], rowCount: 1 };
        if (sql.includes('select normalized_hostname from control.tenant_domains')) return { rows: [], rowCount: 0 };
        if (sql.includes('select legal_name from control.platform_tenants')) return { rows: [{ legal_name: 'Testkommunen' }], rowCount: 1 };
        if (sql.includes('insert into control.organization_account_invitations')) return {
          rows: [{ id: invitationId, tenant_id: tenantId, provider_user_id: providerUserId, display_name: 'Anna Admin', email_ciphertext: new Uint8Array([1]), role_key: 'tenant_admin', status: 'active', created_at: new Date().toISOString() }], rowCount: 1,
        };
        if (sql.includes('set invite_sent_at=now()')) { events.push('control:invite-sent'); return { rows: [], rowCount: 1 }; }
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('select event_hash from control.control_audit_events')) return { rows: [], rowCount: 0 };
        if (sql.includes('insert into control.control_audit_events')) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected control query: ${sql}`);
      },
    }),
  };
  const dataDatabase = {
    transaction: async (work) => work({
      query: async (sql) => {
        if (sql.includes("select set_config('app.")) return { rows: [], rowCount: 1 };
        if (sql.includes('select exists(select 1 from app.organizations')) return { rows: [{ organization_ready: true, role_ready: true }], rowCount: 1 };
        if (sql.includes('select id from app.users')) return { rows: [], rowCount: 0 };
        if (sql.includes('insert into app.users')) return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 };
        if (sql.includes('select id from app.memberships')) return { rows: [], rowCount: 0 };
        if (sql.includes('insert into app.memberships')) return { rows: [{ id: '66666666-6666-4666-8666-666666666666' }], rowCount: 1 };
        if (sql.includes('select id from app.roles')) return { rows: [{ id: '77777777-7777-4777-8777-777777777777' }], rowCount: 1 };
        if (sql.includes('delete from app.role_assignments')) return { rows: [], rowCount: 1 };
        if (sql.includes('insert into app.role_assignments')) { events.push('data:role-assigned'); return { rows: [], rowCount: 1 }; }
        if (sql.includes('select audit.append_event')) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected data query: ${sql}`);
      },
    }),
  };
  const infrastructure = {
    sensitiveData: {
      encryptText: async () => new Uint8Array([1]),
      decryptText: async () => 'admin@kommun.se',
      blindIndex: async () => new Uint8Array([2]),
    },
  };
  const provider = {
    inviteOrFindUser: async () => ({ user: { id: providerUserId, email: 'admin@kommun.se', emailConfirmedAt: new Date().toISOString(), userMetadata: {} }, state: 'active' }),
    sendPasswordRecovery: async () => { events.push('provider:recovery-sent'); },
  };
  const repository = createAuthenticationRepository(controlDatabase, dataDatabase, infrastructure, provider, {
    rootDomain: 'kommunsign.se', platformAdminHostname: 'admin.kommunsign.se', tenantDiscoveryHostname: 'app.kommunsign.se',
    authPortalUrl: 'https://app.kommunsign.se', sessionLifetimeSeconds: 3600,
  });
  const result = await repository.inviteOrganizationUser(
    { subjectId: '99999999-9999-4999-8999-999999999999', requestId: 'existing-reinvite-test', roles: ['platform_super_admin'] },
    tenantId,
    { displayName: 'Anna Admin', email: 'admin@kommun.se', roleKey: 'tenant_admin' },
    'existing-reinvite-test-0001',
    'b'.repeat(64),
  );
  assert.equal(result.status, 'active');
  assert.ok(events.indexOf('data:role-assigned') >= 0);
  assert.ok(events.indexOf('provider:recovery-sent') > events.indexOf('data:role-assigned'));
  assert.ok(events.indexOf('control:invite-sent') > events.indexOf('provider:recovery-sent'));
});

test('organization invitation waits for a complete tenant and remains retry-safe after provider delivery', async () => {
  const repository = await readFile('apps/api/src/production-adapters/postgres/authentication-repository.ts', 'utf8');
  const provider = await readFile('packages/provider-adapters/src/supabase-auth.ts', 'utf8');
  const provisioning = await readFile('apps/api/src/production-adapters/postgres/provisioning-repository.ts', 'utf8');
  const migration = await readFile('migrations/control/0016_consistent_tenant_and_account_activation.sql', 'utf8');
  const activationPage = await readFile('apps/auth-portal/public/aktivera/index.html', 'utf8');
  assert.match(repository, /assertOrganizationAccountProvisionable[\s\S]*provider\.inviteOrFindUser/);
  assert.match(repository, /existingRow[\s\S]*status !== 'failed'[\s\S]*provisionTenantUser/);
  assert.match(repository, /providerState: invitation\.state/);
  assert.match(repository, /provisionTenantUser[\s\S]*invitation\.state !== 'invited'[\s\S]*sendPasswordRecovery/);
  assert.match(provider, /state: 'invited' \| 'pending' \| 'active'/);
  assert.match(provider, /existing\) \{[\s\S]*state: 'pending'/);
  assert.doesNotMatch(provider, /existing\)[\s\S]{0,300}sendPasswordRecovery/);
  assert.match(provisioning, /update control\.platform_tenants[\s\S]*status='onboarding'/);
  assert.match(migration, /request\.status='completed'[\s\S]*tenant\.status='provisioning'/);
  assert.match(activationPage, /Välj ett personligt lösenord/);
  assert.match(activationPage, /minlength="12"/);
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

test('new applications start with simple shared SaaS defaults and a derived email domain', async () => {
  const repository = await readFile('apps/api/src/production-adapters/postgres/onboarding-repository.ts', 'utf8');
  const portal = await readFile('apps/onboarding-portal/public/index.html', 'utf8');
  const portalRuntime = await readFile('apps/onboarding-portal/public/app.js', 'utf8');
  assert.match(repository, /const officialEmailDomain = primaryEmail\.split\('@'\)\[1\]/);
  assert.match(repository, /initialProfile[\s\S]*mode: 'shared_saas'[\s\S]*region: 'se-central'/);
  assert.match(portal, /fylls automatiskt från kontaktadressen/);
  assert.match(portalRuntime, /profileForm\.elements\.officialEmailDomain\.value = profile\.officialEmailDomain/);
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

const retentionPolicy = (overrides = {}) => ({
  policyKey: 'signature-cases', version: 1, retentionClass: 'business_data',
  mode: 'delete_after_period', periodDays: 30, active: true, ...overrides,
});
const retentionSubject = (overrides = {}) => ({
  tenantId: '00000000-0000-4000-8000-000000000001', caseId: '00000000-0000-4000-8000-000000000002',
  status: 'completed', closedAt: '2026-01-01T00:00:00.000Z', legalHoldActive: false, ...overrides,
});
const AFTER_PERIOD = new Date('2026-06-01T00:00:00.000Z');

test('gallring never touches a case under legal hold or still running', () => {
  // Legal hold outranks an otherwise long-elapsed retention period.
  const held = decideRetention(retentionPolicy(), retentionSubject({ legalHoldActive: true }), AFTER_PERIOD);
  assert.equal(held.action, 'RETAIN');
  assert.equal(held.reason, 'LEGAL_HOLD');

  // A policy in legal_hold mode holds even without a per-case hold.
  assert.equal(decideRetention(retentionPolicy({ mode: 'legal_hold', periodDays: null }), retentionSubject(), AFTER_PERIOD).reason, 'LEGAL_HOLD');

  // The retention clock starts at closure, so an open case is never eligible
  // however old it is.
  const open = decideRetention(retentionPolicy(), retentionSubject({ status: 'in_progress', closedAt: null }), AFTER_PERIOD);
  assert.equal(open.action, 'RETAIN');
  assert.equal(open.reason, 'CASE_NOT_CLOSED');

  assert.equal(decideRetention(retentionPolicy({ active: false }), retentionSubject(), AFTER_PERIOD).reason, 'POLICY_INACTIVE');
  assert.equal(decideRetention(retentionPolicy({ mode: 'retain_forever', periodDays: null }), retentionSubject(), AFTER_PERIOD).action, 'RETAIN');
});

test('gallring becomes due only after the period elapses and distinguishes automatic from minimum retention', () => {
  const beforeDue = decideRetention(retentionPolicy({ periodDays: 30 }), retentionSubject(), new Date('2026-01-15T00:00:00.000Z'));
  assert.equal(beforeDue.action, 'RETAIN');
  assert.equal(beforeDue.reason, 'PERIOD_NOT_ELAPSED');
  assert.equal(beforeDue.eligibleAt, '2026-01-31T00:00:00.000Z');

  const due = decideRetention(retentionPolicy({ periodDays: 30 }), retentionSubject(), AFTER_PERIOD);
  assert.equal(due.action, 'DELETE');
  assert.equal(due.reason, 'DUE_FOR_DELETION');

  assert.equal(decideRetention(retentionPolicy({ mode: 'archive_then_delete' }), retentionSubject(), AFTER_PERIOD).action, 'ARCHIVE_THEN_DELETE');

  // retain_for_period is a minimum retention, not an instruction to delete:
  // it must never produce an automatic DELETE.
  assert.equal(decideRetention(retentionPolicy({ mode: 'retain_for_period' }), retentionSubject(), AFTER_PERIOD).action, 'RETAIN');
});

test('access log retention below the PUB floor requires a documented instruction', () => {
  const short = { policyKey: 'access-log', version: 1, retentionClass: 'access_log', mode: 'delete_after_period', periodDays: 90, active: true };
  assert.throws(() => assertPolicyIsLawful(short), (error) => error.code === 'RETENTION_BELOW_PUB_FLOOR');

  // PUB-avtalet 7.5 allows a shorter period only when the Instruktion says so.
  assertPolicyIsLawful({ ...short, instructionReference: 'Instruktion 2026-08-01 §4' });
  assertPolicyIsLawful({ ...short, periodDays: ACCESS_LOG_MINIMUM_RETENTION_DAYS });

  // Business data carries no such floor.
  assertPolicyIsLawful(retentionPolicy({ periodDays: 1 }));
  // Modes that need a period must carry one, and those that don't must not.
  assert.throws(() => assertPolicyIsLawful(retentionPolicy({ periodDays: null })), (error) => error.code === 'RETENTION_PERIOD_REQUIRED');
  assert.throws(() => assertPolicyIsLawful(retentionPolicy({ mode: 'retain_forever' })), (error) => error.code === 'RETENTION_PERIOD_FORBIDDEN');
});

test('gallring report is only complete when every copy is verified deleted', () => {
  const base = {
    tenantId: '00000000-0000-4000-8000-000000000001', jobId: '00000000-0000-4000-8000-000000000003',
    policyKey: 'signature-cases', policyVersion: 1, retentionClass: 'business_data',
    executedBy: '00000000-0000-4000-8000-000000000004', executedAt: '2026-06-01T00:00:00.000Z',
    caseIds: ['00000000-0000-4000-8000-000000000002'],
  };
  const complete = buildGallringReport({ ...base, outcomes: [
    { target: 'signature_case', deletedCount: 1, verified: true },
    { target: 'object_storage', deletedCount: 3, verified: true },
  ] });
  assert.equal(complete.complete, true);
  assert.equal(complete.deletedTotal, 4);
  assert.equal(complete.caseCount, 1);
  assert.equal(complete.schemaVersion, 1);

  // Krav 2070: gallrad information must not be recoverable. A target that could
  // not be confirmed deleted makes the gallring incomplete rather than passing.
  const partial = buildGallringReport({ ...base, outcomes: [
    { target: 'signature_case', deletedCount: 1, verified: true },
    { target: 'object_storage', deletedCount: 0, verified: false, note: 'storage timeout' },
  ] });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.unverifiedTargets, ['object_storage']);

  assert.throws(() => buildGallringReport({ ...base, caseIds: [], outcomes: [] }), (error) => error.code === 'GALLRING_REPORT_EMPTY');
  assert.throws(() => buildGallringReport({ ...base, outcomes: [
    { target: 'signature_case', deletedCount: 1, verified: true },
    { target: 'signature_case', deletedCount: 1, verified: true },
  ] }), (error) => error.code === 'GALLRING_TARGET_DUPLICATE');
});

test('gallring is permission controlled and reserved for the customer', () => {
  // Krav 2071: only authorised roles may gallra.
  assert.ok(hasPermission(['tenant_admin'], 'retention:execute'));
  assert.ok(hasPermission(['tenant_archive_admin'], 'retention:execute'));
  // Separation of duties: the security admin configures policy but does not destroy data.
  assert.ok(hasPermission(['tenant_security_admin'], 'retention:manage'));
  assert.equal(hasPermission(['tenant_security_admin'], 'retention:execute'), false);
  for (const role of ['document_creator', 'document_sender', 'approver', 'auditor', 'readonly', 'department_admin']) {
    assert.equal(hasPermission([role], 'retention:execute'), false, `${role} must not gallra`);
    assert.equal(hasPermission([role], 'retention:manage'), false, `${role} must not configure retention`);
  }
});

const ALL_FEATURES = ['BANKID', 'FREJA_PLUS', 'FREJA_ORGID', 'SWEDEN_CONNECT', 'SVERIGE_ID', 'EIDAS', 'QES'];
const identityRequest = (overrides = {}) => ({
  environment: 'production', enabledFeatures: ALL_FEATURES,
  policyAllowedMethods: ['BANKID', 'FREJA_PLUS', 'FREJA_ORGID', 'SVERIGE_ID', 'EIDAS', 'TEST_ONLY'],
  requiredAssurance: 'HIGH', requiredSignatureLevel: 'ADVANCED_ELECTRONIC_SIGNATURE', ...overrides,
});
const identityCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('identity registry resolves methods by capability without naming a provider', () => {
  const bankId = resolveIdentityMethod(identityRequest({ method: 'BANKID' }));
  assert.equal(bankId.provider, 'TIC_BANKID');
  assert.equal(bankId.capabilities.supportsQr, true);

  // Freja OrgID is the staff method: it is the one carrying an organisational
  // identity, and BankID must not be substituted for it.
  assert.equal(capabilitiesFor('FREJA_ORGID').carriesOrganisationIdentity, true);
  assert.equal(capabilitiesFor('FREJA_PLUS').carriesOrganisationIdentity, false);
  assert.equal(
    identityCode(() => resolveIdentityMethod(identityRequest({ method: 'BANKID', requiresOrganisationIdentity: true }))),
    'IDENTITY_ORGANISATION_REQUIRED',
  );
  // Both Freja methods route to the same provider, so adding Freja+ costs no
  // new provider integration.
  assert.equal(capabilitiesFor('FREJA_ORGID').provider, capabilitiesFor('FREJA_PLUS').provider);
  assert.equal(capabilitiesFor('SVERIGE_ID').provider, capabilitiesFor('EIDAS').provider);
});

test('identity registry fails closed in production for every gate', () => {
  // Unfinished integrations must not be reachable in production...
  assert.equal(identityCode(() => resolveIdentityMethod(identityRequest({ method: 'FREJA_ORGID' }))), 'IDENTITY_METHOD_NOT_PRODUCTION_READY');
  assert.equal(identityCode(() => resolveIdentityMethod(identityRequest({ method: 'SVERIGE_ID' }))), 'IDENTITY_METHOD_NOT_PRODUCTION_READY');
  // ...but the adapter is reachable in development so it can be built and tested.
  assert.equal(resolveIdentityMethod(identityRequest({ method: 'FREJA_ORGID', environment: 'development' })).provider, 'FREJA');

  // The test provider is never reachable from a production-like runtime, and
  // staging counts as production-like.
  assert.equal(identityCode(() => resolveIdentityMethod(identityRequest({ method: 'TEST_ONLY' }))), 'IDENTITY_TEST_PROVIDER_FORBIDDEN');
  assert.equal(identityCode(() => resolveIdentityMethod(identityRequest({ method: 'TEST_ONLY', environment: 'staging' }))), 'IDENTITY_TEST_PROVIDER_FORBIDDEN');

  // Policy outranks the feature flag: a flag alone never grants a method.
  assert.equal(identityCode(() => resolveIdentityMethod(identityRequest({ method: 'BANKID', policyAllowedMethods: [] }))), 'IDENTITY_METHOD_NOT_ALLOWED_BY_POLICY');
  assert.equal(identityCode(() => resolveIdentityMethod(identityRequest({ method: 'BANKID', enabledFeatures: [] }))), 'IDENTITY_METHOD_NOT_ENABLED');

  // Qualified signatures are not approximated while no QTSP is integrated.
  assert.equal(
    identityCode(() => resolveIdentityMethod(identityRequest({ method: 'BANKID', requiredSignatureLevel: 'QUALIFIED_ELECTRONIC_SIGNATURE_FUTURE' }))),
    'SIGNATURE_LEVEL_QUALIFIED_UNAVAILABLE',
  );
  // eIDAS reaches substantial, not high, so a high-assurance policy rejects it.
  assert.equal(
    identityCode(() => resolveIdentityMethod(identityRequest({ method: 'EIDAS', environment: 'development' }))),
    'IDENTITY_ASSURANCE_INSUFFICIENT',
  );
  assert.equal(resolveIdentityMethod(identityRequest({ method: 'EIDAS', environment: 'development', requiredAssurance: 'SUBSTANTIAL' })).provider, 'SWEDEN_CONNECT');
});

test('provider outage narrows the offered methods but never lowers assurance', () => {
  const inProduction = availableMethods(identityRequest());
  assert.deepEqual(inProduction.map((entry) => entry.method), ['BANKID']);

  // With the other adapters live, a BankID outage still leaves the staff
  // method usable. eIDAS stays out because it cannot reach HIGH assurance.
  const development = { ...identityRequest(), environment: 'development' };
  assert.deepEqual(
    availableMethods(development, ['TIC_BANKID']).map((entry) => entry.method),
    ['FREJA_PLUS', 'FREJA_ORGID', 'SVERIGE_ID'],
  );
  // A total outage offers nothing rather than falling back to a weaker method.
  assert.deepEqual(availableMethods(development, ['TIC_BANKID', 'FREJA', 'SWEDEN_CONNECT', 'TEST_ONLY']), []);

  // Assurance ordering is what makes "never downgrade" checkable.
  assert.ok(assuranceAtLeast('HIGH', 'SUBSTANTIAL'));
  assert.equal(assuranceAtLeast('SUBSTANTIAL', 'HIGH'), false);
});

const fullEvidence = (overrides = {}) => ({
  signingCertificateReference: 'cert-1', certificateChainReference: 'chain-1',
  signedRevisionSha256: 'a'.repeat(64), signatureTimestampReference: 'tst-1',
  archiveTimestampReference: 'atst-1', revocationEvidenceReferences: ['ocsp-1'],
  trustListSnapshotReference: 'tl-1', validationResult: 'TOTAL_PASSED',
  validatedAt: '2026-08-07T10:00:00.000Z', ...overrides,
});
const padesPolicy = (overrides = {}) => ({
  requiredPadesLevel: 'LT', requiresTimestamp: true,
  allowedValidationResults: ['TOTAL_PASSED'], ...overrides,
});
const padesCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('attained PAdES level is capped by the evidence actually present', () => {
  assert.equal(attainedPadesLevel(fullEvidence()), 'LTA');
  // Each level is cumulative: removing one artefact caps the level one step down.
  assert.equal(attainedPadesLevel(fullEvidence({ archiveTimestampReference: null })), 'LT');
  assert.equal(attainedPadesLevel(fullEvidence({ archiveTimestampReference: null, trustListSnapshotReference: null })), 'T');
  assert.equal(attainedPadesLevel(fullEvidence({ archiveTimestampReference: null, revocationEvidenceReferences: [] })), 'T');
  assert.equal(attainedPadesLevel(fullEvidence({ signatureTimestampReference: null, archiveTimestampReference: null })), 'B');
  // Without a signature over the revision there is no PAdES at all.
  assert.equal(attainedPadesLevel(fullEvidence({ signedRevisionSha256: null })), null);
  assert.equal(attainedPadesLevel(fullEvidence({ signingCertificateReference: null })), null);
  assert.equal(attainedPadesLevel(fullEvidence({ certificateChainReference: null })), null);
});

test('PAdES admission refuses to register an unvalidated or failed signature', () => {
  // AGENTS.md rule 5: no registration without DSS or equivalent validation,
  // however complete the rest of the evidence is.
  assert.equal(padesCode(() => admitPadesSignature(padesPolicy(), fullEvidence({ validationResult: null }))), 'PADES_NOT_VALIDATED');
  assert.equal(padesCode(() => admitPadesSignature(padesPolicy(), fullEvidence({ validatedAt: null }))), 'PADES_NOT_VALIDATED');
  assert.equal(padesCode(() => admitPadesSignature(padesPolicy(), fullEvidence({ validationResult: 'TOTAL_FAILED' }))), 'PADES_VALIDATION_FAILED');

  // INDETERMINATE is admissible only when the policy opts into it.
  assert.equal(
    padesCode(() => admitPadesSignature(padesPolicy(), fullEvidence({ validationResult: 'INDETERMINATE' }))),
    'PADES_VALIDATION_RESULT_NOT_ALLOWED',
  );
  assert.equal(
    admitPadesSignature(padesPolicy({ allowedValidationResults: ['TOTAL_PASSED', 'INDETERMINATE'] }), fullEvidence({ validationResult: 'INDETERMINATE' })).validationResult,
    'INDETERMINATE',
  );

  // A policy that produces no PAdES must not have one registered against it.
  assert.equal(padesCode(() => admitPadesSignature(padesPolicy({ requiredPadesLevel: 'NONE' }), fullEvidence())), 'PADES_NOT_REQUIRED_BY_POLICY');
});

test('PAdES admission never claims a level the evidence does not support', () => {
  // The core guarantee: asking for LTA without an archive timestamp fails
  // rather than silently recording LT, and the code names what is missing.
  assert.equal(
    padesCode(() => admitPadesSignature(padesPolicy({ requiredPadesLevel: 'LTA' }), fullEvidence({ archiveTimestampReference: null }))),
    'PADES_ARCHIVE_TIMESTAMP_MISSING',
  );
  assert.equal(
    padesCode(() => admitPadesSignature(padesPolicy({ requiredPadesLevel: 'LT' }), fullEvidence({ archiveTimestampReference: null, revocationEvidenceReferences: [] }))),
    'PADES_REVOCATION_EVIDENCE_MISSING',
  );
  assert.equal(
    padesCode(() => admitPadesSignature(padesPolicy({ requiredPadesLevel: 'LT' }), fullEvidence({ archiveTimestampReference: null, trustListSnapshotReference: null }))),
    'PADES_TRUST_LIST_MISSING',
  );
  assert.equal(
    padesCode(() => admitPadesSignature(padesPolicy({ requiredPadesLevel: 'T' }), fullEvidence({ signatureTimestampReference: null, archiveTimestampReference: null }))),
    'PADES_TIMESTAMP_MISSING',
  );
  // A policy demanding a timestamp gets one even at level B.
  assert.equal(
    padesCode(() => admitPadesSignature(padesPolicy({ requiredPadesLevel: 'B', requiresTimestamp: true }), fullEvidence({ signatureTimestampReference: null, archiveTimestampReference: null }))),
    'PADES_TIMESTAMP_MISSING',
  );

  // What is recorded is what the evidence supports, not what was requested:
  // asking for B with full LTA evidence records LTA, not B.
  assert.equal(admitPadesSignature(padesPolicy({ requiredPadesLevel: 'B' }), fullEvidence()).admittedLevel, 'LTA');
  assert.equal(admitPadesSignature(padesPolicy({ requiredPadesLevel: 'LT' }), fullEvidence({ archiveTimestampReference: null })).admittedLevel, 'LT');
  assert.match(describePadesLevel('LTA'), /arkivtidsstämpel/);
});

const ALL_STORES = ['CONTROL', 'DATA', 'OBJECT_STORAGE', 'AUDIT_LOG', 'BACKUP'];
const fullCoverage = (overrides = {}) => ALL_STORES.map((store) => ({
  store, recordCount: 1, searched: true,
  ...(erasureExemption(store) ? { searched: false, recordCount: 0, exemptionReason: erasureExemption(store) } : {}),
  ...(overrides[store] ?? {}),
}));
const privacyRequest = (overrides = {}) => ({
  tenantId: '00000000-0000-4000-8000-000000000001', requestId: '00000000-0000-4000-8000-000000000009',
  right: 'ERASURE', receivedAt: '2026-08-07T00:00:00.000Z', legalHoldActive: false, ...overrides,
});
const privacyCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('a data subject request must account for every store, including CONTROL', () => {
  const response = buildDataSubjectResponse(privacyRequest({ right: 'ACCESS' }), fullCoverage());
  assert.equal(response.complete, true);
  assert.equal(response.schemaVersion, 1);
  // PUB-avtalet 10.1: 30 dagar från mottagandet.
  assert.equal(response.dueAt, '2026-09-06T00:00:00.000Z');

  // Detta är defekten modulen finns för: ett svar som täcker DATA men glömmer
  // CONTROL ser fullständigt ut och måste därför avvisas.
  const withoutControl = fullCoverage().filter((entry) => entry.store !== 'CONTROL');
  assert.equal(privacyCode(() => buildDataSubjectResponse(privacyRequest({ right: 'ACCESS' }), withoutControl)), 'PRIVACY_COVERAGE_INCOMPLETE');
  const withoutStorage = fullCoverage().filter((entry) => entry.store !== 'OBJECT_STORAGE');
  assert.equal(privacyCode(() => buildDataSubjectResponse(privacyRequest({ right: 'ACCESS' }), withoutStorage)), 'PRIVACY_COVERAGE_INCOMPLETE');

  // Ett register får inte vara varken genomsökt eller undantaget.
  assert.equal(
    privacyCode(() => buildDataSubjectResponse(privacyRequest({ right: 'ACCESS' }), fullCoverage({ CONTROL: { searched: false, exemptionReason: '  ' } }))),
    'PRIVACY_STORE_NOT_SEARCHED',
  );
  assert.equal(
    privacyCode(() => buildDataSubjectResponse(privacyRequest({ right: 'ACCESS' }), [...fullCoverage(), { store: 'DATA', recordCount: 0, searched: true }])),
    'PRIVACY_STORE_DUPLICATE',
  );
});

test('erasure respects legal hold and the statutory log retention', () => {
  // Legal hold blockerar radering på samma sätt som gallring.
  assert.equal(
    privacyCode(() => buildDataSubjectResponse(privacyRequest({ legalHoldActive: true }), fullCoverage())),
    'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD',
  );

  // Rätten till radering är inte absolut. Auditloggen bevaras enligt
  // PUB-avtalet 7.5 och backuper punktraderas inte — men båda ska redovisas
  // som undantag med grund, inte tyst hoppas över.
  const response = buildDataSubjectResponse(privacyRequest(), fullCoverage());
  assert.deepEqual([...response.exemptedStores].sort(), ['AUDIT_LOG', 'BACKUP']);
  assert.match(erasureExemption('AUDIT_LOG'), /fem år/);
  assert.equal(erasureExemption('CONTROL'), null);
  assert.equal(erasureExemption('DATA'), null);

  // Förfallodatum räknas mot PUB-avtalets frist.
  assert.equal(isOverdue(response, new Date('2026-09-01T00:00:00.000Z')), false);
  assert.equal(isOverdue(response, new Date('2026-09-10T00:00:00.000Z')), true);
});

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const CASE = '00000000-0000-4000-8000-0000000000a2';
const INTENT = '00000000-0000-4000-8000-0000000000a3';
const DOC_HASH = 'a'.repeat(64);
const REV_HASH = 'b'.repeat(64);

const signedData = { tenantId: TENANT, signatureCaseId: CASE, documentVersionId: '00000000-0000-4000-8000-0000000000a4', documentSha256: DOC_HASH };
const beginPipeline = (overrides = {}) => beginSigningPipeline({
  signedData, signingIntentId: INTENT, requiredLevel: 'LT', requiresTimestamp: true, documentLocked: true, ...overrides,
});
const artifact = (overrides = {}) => ({
  artifactReference: 'artifact-1', coveredDocumentSha256: DOC_HASH, signedRevisionSha256: REV_HASH,
  signingCertificateReference: 'cert-1', certificateChainReference: 'chain-1', producedAt: '2026-08-07T10:00:00.000Z', ...overrides,
});
const tsToken = (overrides = {}) => ({
  tokenReference: 'tst-1', coveredSha256: REV_HASH, generatedAt: '2026-08-07T10:00:01.000Z', authorityName: 'tsa', ...overrides,
});
const report = (overrides = {}) => ({
  result: 'TOTAL_PASSED', attainedLevel: 'LT', revocationEvidenceReferences: ['ocsp-1'],
  trustListSnapshotReference: 'tl-1', archiveTimestampReference: null, reportReference: 'rep-1',
  validatedAt: '2026-08-07T10:00:02.000Z', ...overrides,
});
const identity = (overrides = {}) => ({ signingIntentId: INTENT, signatureCaseId: CASE, tenantId: TENANT, assuranceLevel: 'HIGH', ...overrides });
const signingCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('the signing pipeline runs every stage in order and cannot skip one', () => {
  let state = beginPipeline();
  assert.deepEqual(state.completedStages, ['DOCUMENT_LOCKED']);

  // This is the defect the stage machine exists for: a case must not be able
  // to reach a signature without a resolved policy and a verified identity.
  assert.equal(signingCode(() => recordSignatureCreated(state, artifact())), 'SIGNING_STAGE_OUT_OF_ORDER');
  assert.equal(signingCode(() => recordValidated(state, report())), 'SIGNING_STAGE_OUT_OF_ORDER');

  state = recordPolicyResolved(state);
  assert.equal(signingCode(() => recordPolicyResolved(state)), 'SIGNING_STAGE_ALREADY_COMPLETED');

  state = recordIdentityVerified(state, identity(), ['HIGH', 'SUBSTANTIAL']);
  state = recordSignatureCreated(state, artifact());
  state = recordTimestamped(state, tsToken());
  state = recordValidated(state, report());
  assert.equal(pipelineIsComplete(state), false);
  state = recordAdmitted(state);
  assert.equal(pipelineIsComplete(state), true);

  // The evidence handed to the PAdES gate is assembled only from what
  // providers returned, and admits exactly the level it supports.
  const evidence = collectSignatureEvidence(state);
  assert.equal(evidence.signedRevisionSha256, REV_HASH);
  assert.equal(attainedPadesLevel(evidence), 'LT');
  assert.equal(
    admitPadesSignature({ requiredPadesLevel: 'LT', requiresTimestamp: true, allowedValidationResults: ['TOTAL_PASSED'] }, evidence).admittedLevel,
    'LT',
  );
  assert.match(describeStage('SIGNATURE_CREATED'), /Kryptografisk signatur/);
});

test('a signature is refused when it does not bind to the locked document', () => {
  // An unlocked document means the bytes can change between display and
  // signature, so the hash proves nothing.
  assert.equal(signingCode(() => beginPipeline({ documentLocked: false })), 'SIGNING_DOCUMENT_NOT_LOCKED');
  assert.equal(signingCode(() => beginPipeline({ signedData: { ...signedData, documentSha256: 'not-a-hash' } })), 'SIGNING_DOCUMENT_MISMATCH');

  let state = recordPolicyResolved(beginPipeline());

  // Identity evidence from another intent, case or tenant is the path by which
  // a valid BankID session for one document completes a signature over another.
  assert.equal(signingCode(() => recordIdentityVerified(state, identity({ signingIntentId: CASE }), ['HIGH'])), 'SIGNING_IDENTITY_NOT_BOUND');
  assert.equal(signingCode(() => recordIdentityVerified(state, identity({ tenantId: CASE }), ['HIGH'])), 'SIGNING_IDENTITY_NOT_BOUND');
  assert.equal(signingCode(() => recordIdentityVerified(state, identity({ assuranceLevel: 'LOW' }), ['HIGH'])), 'SIGNING_IDENTITY_ASSURANCE_TOO_LOW');

  state = recordIdentityVerified(state, identity(), ['HIGH']);

  // The backend says what it covered; the pipeline checks rather than trusts.
  assert.equal(signingCode(() => recordSignatureCreated(state, artifact({ coveredDocumentSha256: REV_HASH }))), 'SIGNING_ARTIFACT_NOT_BOUND');
  assert.equal(signingCode(() => recordSignatureCreated(state, artifact({ certificateChainReference: '' }))), 'SIGNING_ARTIFACT_MISSING');

  const signed = recordSignatureCreated(state, artifact());
  // A timestamp over some other digest proves nothing about our revision.
  assert.equal(signingCode(() => recordTimestamped(signed, tsToken({ coveredSha256: DOC_HASH }))), 'SIGNING_ARTIFACT_NOT_BOUND');
  // Any level above B needs a timestamp, whatever the policy flag says.
  assert.equal(signingCode(() => recordTimestamped(signed, null)), 'SIGNING_TIMESTAMP_REQUIRED');

  assert.equal(signingCode(() => recordValidated(recordTimestamped(signed, tsToken()), report({ result: 'TOTAL_FAILED' }))), 'SIGNING_VALIDATION_FAILED');
  // Evidence may not be collected from an incomplete pipeline.
  assert.equal(signingCode(() => collectSignatureEvidence(recordTimestamped(signed, tsToken()))), 'SIGNING_NOT_VALIDATED');
});

test('an unconfigured signing runtime refuses to sign instead of pretending to', async () => {
  const blocked = {
    environment: 'production',
    engine: new NotConfiguredSigningEngine(),
    timestamps: new NotConfiguredTimestampProvider(),
    validator: new NotConfiguredSignatureValidator(),
  };
  // The default backend must refuse. A permissive stub would produce cases
  // that look signed and are not (AGENTS.md rule 10).
  await assert.rejects(() => blocked.engine.sign(), (error) => error.code === 'SIGNING_PROVIDER_NOT_CONFIGURED');
  assert.equal(signingCode(() => assertSigningRuntimeUsable(blocked, 'LT')), 'SIGNING_LEVEL_NOT_SUPPORTED');
  // A policy that produces no signature must never enter the signing pipeline.
  assert.equal(signingCode(() => assertSigningRuntimeUsable(blocked, 'NONE')), 'SIGNING_POLICY_REQUIRES_SIGNATURE');

  const capable = (overrides = {}) => ({
    environment: 'production',
    engine: { capabilities: { backendKey: 'x', supportedLevels: ['B', 'T', 'LT', 'LTA'], producesPdfA: true, productionReady: true, keyProtection: 'HSM', ...(overrides.capabilities ?? {}) }, sign: async () => artifact() },
    timestamps: { authorityName: 'tsa', productionReady: true, timestamp: async () => tsToken() },
    validator: { validatorKey: 'v', productionReady: true, validate: async () => report() },
    ...overrides.runtime,
  });
  assert.equal(signingCode(() => assertSigningRuntimeUsable(capable(), 'LT')), 'NO_ERROR');

  // Every participant must be production ready in production: a stub validator
  // would let an unvalidated signature reach the admission gate.
  assert.equal(
    signingCode(() => assertSigningRuntimeUsable(capable({ runtime: { validator: { validatorKey: 'v', productionReady: false, validate: async () => report() } } }), 'LT')),
    'SIGNING_PROVIDER_NOT_PRODUCTION_READY',
  );
  assert.equal(
    signingCode(() => assertSigningRuntimeUsable(capable({ runtime: { timestamps: { authorityName: 't', productionReady: false, timestamp: async () => tsToken() } } }), 'LT')),
    'SIGNING_PROVIDER_NOT_PRODUCTION_READY',
  );
  // Long-term archival signatures may not rest on software-held keys.
  assert.equal(signingCode(() => assertSigningRuntimeUsable(capable({ capabilities: { keyProtection: 'SOFTWARE' } }), 'LTA')), 'SIGNING_PROVIDER_NOT_PRODUCTION_READY');
  // ...but the same software backend is acceptable below LTA.
  assert.equal(signingCode(() => assertSigningRuntimeUsable(capable({ capabilities: { keyProtection: 'SOFTWARE' } }), 'T')), 'NO_ERROR');

  // Outside production a non-ready backend is allowed, so developers can work.
  assert.equal(signingCode(() => assertSigningRuntimeUsable(capable({ runtime: { environment: 'development' }, capabilities: { productionReady: false } }), 'LT')), 'NO_ERROR');
});

const NOW = new Date('2026-08-07T12:00:00.000Z');
const frejaClaims = (overrides = {}) => ({
  signatureVerified: true, algorithm: 'ES256', issuer: 'https://services.prod.frejaeid.com',
  audience: 'kommunsign-rp', transactionReference: 'tx-1', signRef: 'intent-1', nonce: 'nonce-1',
  issuedAt: '2026-08-07T11:59:30.000Z', expiresAt: '2026-08-07T12:05:00.000Z', status: 'APPROVED',
  subjectType: 'SSN', subject: '198001019876', personalNumber: '198001019876', displayName: 'Test Testsson',
  registrationLevel: 'PLUS', signedDataSha256: 'c'.repeat(64), ...overrides,
});
const frejaExpect = (overrides = {}) => ({
  method: 'FREJA_PLUS', issuer: 'https://services.prod.frejaeid.com', audience: 'kommunsign-rp',
  transactionReference: 'tx-1', signRef: 'intent-1', nonce: 'nonce-1', signedDataSha256: 'c'.repeat(64),
  minimumRegistrationLevel: 'PLUS', allowedAlgorithms: ['ES256', 'RS256'],
  documentClassification: 'CONFIDENTIAL', maximumResponseAgeSeconds: 300, ...overrides,
});
const frejaCode = (claims, expectation = {}, ledger = new InMemoryFrejaNonceLedger(), now = NOW) => {
  try { verifyFrejaSignatureClaims(frejaClaims(claims), frejaExpect(expectation), ledger, now); return 'NO_ERROR'; }
  catch (error) { return error.code; }
};

test('a Freja response is accepted only when it binds to this signing intent', () => {
  assert.equal(frejaCode({}), 'NO_ERROR');

  // Signature validity proves the message came from Freja. It proves nothing
  // about which intent it answers, which is what these three bindings cover.
  assert.equal(frejaCode({ transactionReference: 'tx-2' }), 'FREJA_TRANSACTION_MISMATCH');
  assert.equal(frejaCode({ signRef: 'intent-2' }), 'FREJA_INTENT_MISMATCH');
  assert.equal(frejaCode({ signedDataSha256: 'd'.repeat(64) }), 'FREJA_DOCUMENT_MISMATCH');

  // Nothing below the signature check means anything on an unverified message.
  assert.equal(frejaCode({ signatureVerified: false }), 'FREJA_SIGNATURE_NOT_VERIFIED');
  // Allow-list, not deny-list.
  assert.equal(frejaCode({ algorithm: 'none' }), 'FREJA_ALGORITHM_NOT_ALLOWED');
  assert.equal(frejaCode({ algorithm: 'HS256' }), 'FREJA_ALGORITHM_NOT_ALLOWED');
  assert.equal(frejaCode({ issuer: 'https://evil.example' }), 'FREJA_ISSUER_MISMATCH');
  // Without this, a response minted for another relying party is accepted.
  assert.equal(frejaCode({ audience: 'other-rp' }), 'FREJA_AUDIENCE_MISMATCH');
  assert.equal(frejaCode({ status: 'REJECTED' }), 'FREJA_STATUS_NOT_APPROVED');
  assert.equal(frejaCode({ status: 'CANCELED' }), 'FREJA_STATUS_NOT_APPROVED');
});

test('a Freja response cannot be replayed and cannot outlive its window', () => {
  const ledger = new InMemoryFrejaNonceLedger();
  assert.equal(frejaCode({}, {}, ledger), 'NO_ERROR');
  // The same genuine response replayed matches the nonce both times, so
  // matching alone is not enough — it must be consumable only once.
  assert.equal(frejaCode({}, {}, ledger), 'FREJA_NONCE_REPLAYED');
  assert.equal(frejaCode({ nonce: 'other' }), 'FREJA_NONCE_MISMATCH');

  assert.equal(frejaCode({ expiresAt: '2026-08-07T11:00:00.000Z' }), 'FREJA_RESPONSE_EXPIRED');
  assert.equal(frejaCode({ issuedAt: '2026-08-07T12:30:00.000Z' }), 'FREJA_ISSUED_IN_FUTURE');
  // A response whose own expiry is far in the future must not stay usable that
  // long: we bound the age ourselves.
  assert.equal(
    frejaCode({ issuedAt: '2026-08-07T10:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }),
    'FREJA_RESPONSE_EXPIRED',
  );
});

test('Freja assurance and OrgID organisation identity are enforced, not assumed', () => {
  // BASIC is self-registered and must never pass as a formal Swedish identity.
  assert.equal(frejaAssuranceLevel('BASIC'), 'LOW');
  assert.equal(frejaAssuranceLevel('EXTENDED'), 'SUBSTANTIAL');
  assert.equal(frejaAssuranceLevel('PLUS'), 'HIGH');
  assert.equal(frejaCode({ registrationLevel: 'BASIC' }), 'FREJA_REGISTRATION_LEVEL_TOO_LOW');
  assert.equal(frejaCode({ registrationLevel: 'EXTENDED' }), 'FREJA_REGISTRATION_LEVEL_TOO_LOW');
  assert.equal(frejaCode({ registrationLevel: 'EXTENDED' }, { minimumRegistrationLevel: 'EXTENDED' }), 'NO_ERROR');

  // INFERRED lets Freja pick the subject; never acceptable when the point is
  // knowing exactly who signed.
  assert.equal(frejaCode({ subjectType: 'INFERRED' }), 'FREJA_SUBJECT_TYPE_NOT_ALLOWED');
  assert.equal(frejaCode({ subjectType: 'INFERRED' }, { documentClassification: 'INTERNAL' }), 'NO_ERROR');

  // OrgID is the only method carrying a verified organisation identity, and it
  // must be our organisation rather than any organisation.
  const orgExpect = { method: 'FREJA_ORGID', expectedOrganisationId: 'org-kungalv' };
  assert.equal(frejaCode({}, orgExpect), 'FREJA_ORGANISATION_IDENTITY_MISSING');
  assert.equal(frejaCode({ organisationId: 'org-other' }, orgExpect), 'FREJA_ORGANISATION_MISMATCH');
  assert.equal(frejaCode({ organisationId: 'org-kungalv' }, orgExpect), 'NO_ERROR');

  // Normalisation keeps Freja vocabulary out of the rest of the system.
  const evidence = { provider: 'FREJA_DIRECT', providerReference: 'tx-1', rawPayload: {}, collectedAt: NOW.toISOString() };
  const verified = toVerifiedIdentityEvidence(frejaClaims({ organisationId: 'org-kungalv' }), evidence, NOW.toISOString());
  assert.equal(verified.assuranceLevel, 'HIGH');
  assert.equal(verified.provider, 'FREJA_DIRECT');
  assert.equal(verified.signedPayloadSha256, 'c'.repeat(64));
});

test('an unconfigured Freja verifier refuses instead of accepting an unverified response', async () => {
  await assert.rejects(() => new RejectingFrejaSignatureVerifier().verifyJws('a.b.c'), /not configured/);
  const provider = new FrejaProvider(
    { method: 'FREJA_PLUS', issuer: 'i', audience: 'a', minimumRegistrationLevel: 'PLUS', allowedAlgorithms: ['ES256'], maximumResponseAgeSeconds: 300 },
    { transport: 'MTLS_JAVA_GATEWAY', startSignature: async () => ({}), getStatus: async () => 'PENDING', collectEvidence: async () => ({}), cancel: async () => {}, verifyEvidence: async () => ({}) },
  );
  // Wrong provider and a missing JWS are both refusals, not warnings.
  await assert.rejects(
    () => provider.verifyEvidence({ provider: 'TIC_BANKID', providerReference: 'x', rawPayload: {}, collectedAt: NOW.toISOString() }),
    (error) => error.code === 'FREJA_WRONG_PROVIDER',
  );
  await assert.rejects(
    () => provider.verifyEvidence({ provider: 'FREJA_DIRECT', providerReference: 'x', rawPayload: {}, collectedAt: NOW.toISOString() }),
    (error) => error.code === 'FREJA_SIGNATURE_NOT_VERIFIED',
  );
});

const FED_TENANT = '00000000-0000-4000-8000-0000000000b1';
const fedConfig = (overrides = {}) => ({
  tenantId: FED_TENANT, protocol: 'SAML2', enabled: true,
  issuer: 'https://idp.kungalv.se/metadata', audience: 'https://kungalv.kommunsign.se/sp',
  destination: 'https://kungalv.kommunsign.se/saml/acs',
  signingCertificateSecretReference: 'vault://kungalv/saml-signing',
  requiredAuthnContexts: ['urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor'],
  maximumAuthenticationAgeSeconds: 3600, subjectAttribute: 'uid', groupsAttribute: 'memberOf',
  groupToRole: { 'CN=Kommunsign-Admin': 'tenant_admin', 'CN=Kommunsign-Handlaggare': 'case_manager' },
  assignableRoles: ['tenant_admin', 'case_manager'], ...overrides,
});
const fedAssertion = (overrides = {}) => ({
  protocol: 'SAML2', signatureVerified: true, issuer: 'https://idp.kungalv.se/metadata',
  audience: 'https://kungalv.kommunsign.se/sp', destination: 'https://kungalv.kommunsign.se/saml/acs',
  assertionId: 'assertion-1', inResponseTo: 'request-1', notBefore: '2026-08-07T11:59:00.000Z',
  notOnOrAfter: '2026-08-07T12:05:00.000Z', authenticatedAt: '2026-08-07T11:58:00.000Z',
  authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor', subject: 'anna.andersson',
  attributes: { uid: ['anna.andersson'], memberOf: ['CN=Kommunsign-Handlaggare', 'CN=Ovrig'] }, ...overrides,
});
const fedBinding = (overrides = {}) => ({ requestId: 'request-1', tenantId: FED_TENANT, redirectUri: 'https://kungalv.kommunsign.se/saml/acs', ...overrides });
const fedCode = (assertion = {}, config = {}, binding = {}, ledger = new InMemoryAssertionLedger()) => {
  try { verifyWorkforceAssertion(fedAssertion(assertion), fedConfig(config), fedBinding(binding), ledger, NOW); return 'NO_ERROR'; }
  catch (error) { return error.code; }
};

test('a federated assertion is admitted only when it answers our own login request', () => {
  assert.equal(fedCode(), 'NO_ERROR');

  // Nothing below the signature means anything on an unsigned assertion.
  assert.equal(fedCode({ signatureVerified: false }), 'FEDERATION_SIGNATURE_NOT_VERIFIED');
  // A disabled provider must not authenticate anyone, even with a valid
  // assertion left over from when it was enabled.
  assert.equal(fedCode({}, { enabled: false }), 'FEDERATION_PROVIDER_DISABLED');
  assert.equal(fedCode({ issuer: 'https://evil.example' }), 'FEDERATION_ISSUER_MISMATCH');
  // An assertion minted for a different service provider by the same IdP.
  assert.equal(fedCode({ audience: 'https://other.example/sp' }), 'FEDERATION_AUDIENCE_MISMATCH');
  // One captured at a different endpoint and posted to ours.
  assert.equal(fedCode({ destination: 'https://other.example/acs' }), 'FEDERATION_DESTINATION_MISMATCH');
  // IdP-initiated flows are refused: a stolen assertion could be posted at any
  // time if it did not have to answer a request we started.
  assert.equal(fedCode({ inResponseTo: null }), 'FEDERATION_REQUEST_MISMATCH');
  assert.equal(fedCode({ inResponseTo: 'request-2' }), 'FEDERATION_REQUEST_MISMATCH');
  // AGENTS.md rule 1: tenant comes from the bound configuration, never the message.
  assert.equal(fedCode({}, {}, { tenantId: '00000000-0000-4000-8000-0000000000b2' }), 'FEDERATION_TENANT_MISMATCH');
  assert.equal(fedCode({ subject: '   ' }, {}, {}), 'FEDERATION_SUBJECT_MISSING');
});

test('a federated assertion expires, cannot be replayed, and carries a fresh enough session', () => {
  assert.equal(fedCode({ notOnOrAfter: '2026-08-07T11:00:00.000Z' }), 'FEDERATION_ASSERTION_EXPIRED');
  assert.equal(fedCode({ notBefore: '2026-08-07T12:30:00.000Z' }), 'FEDERATION_ASSERTION_NOT_YET_VALID');

  // Within its validity window the same assertion is accepted every time it is
  // presented, unless it is consumed exactly once.
  const ledger = new InMemoryAssertionLedger();
  assert.equal(fedCode({}, {}, {}, ledger), 'NO_ERROR');
  assert.equal(fedCode({}, {}, {}, ledger), 'FEDERATION_ASSERTION_REPLAYED');

  // A fresh assertion can still describe a very old IdP session.
  assert.equal(fedCode({ authenticatedAt: '2026-08-07T06:00:00.000Z' }), 'FEDERATION_SESSION_TOO_OLD');
  assert.equal(fedCode({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password' }), 'FEDERATION_AUTHN_CONTEXT_TOO_LOW');
  assert.equal(fedCode({ authnContext: null }), 'FEDERATION_AUTHN_CONTEXT_TOO_LOW');
  // A tenant that demands no particular context accepts what the IdP sent.
  assert.equal(fedCode({ authnContext: null }, { requiredAuthnContexts: [] }), 'NO_ERROR');

  // The same rules apply to OIDC: one decision, not two that can drift.
  assert.equal(fedCode({ protocol: 'OIDC' }, { protocol: 'OIDC' }), 'NO_ERROR');
});

test('group to role mapping denies by default rather than granting a fallback', () => {
  const mapped = mapWorkforceIdentity(fedAssertion(), fedConfig(), fedBinding());
  assert.deepEqual(mapped.roles, ['case_manager']);
  // An unmapped group grants nothing rather than being ignored silently.
  assert.deepEqual(mapped.groups, ['CN=Kommunsign-Handlaggare', 'CN=Ovrig']);
  assert.equal(mapped.tenantId, FED_TENANT);

  const mapCode = (assertion, config = {}) => {
    try { mapWorkforceIdentity(fedAssertion(assertion), fedConfig(config), fedBinding()); return 'NO_ERROR'; }
    catch (error) { return error.code; }
  };
  // A user with no mapped group is refused, not given a default role.
  assert.equal(mapCode({ attributes: { uid: ['x'], memberOf: ['CN=Ovrig'] } }), 'FEDERATION_NO_ROLE_MAPPED');
  assert.equal(mapCode({ attributes: { uid: ['x'] } }), 'FEDERATION_NO_ROLE_MAPPED');
  // A mapping pointing outside assignableRoles fails loudly at login rather
  // than quietly handing out a permission nobody chose.
  assert.equal(
    mapCode({}, { groupToRole: { 'CN=Kommunsign-Handlaggare': 'platform_superadmin' } }),
    'FEDERATION_ROLE_NOT_ASSIGNABLE',
  );
  assert.equal(mapCode({ attributes: { memberOf: ['CN=Kommunsign-Admin'] }, subject: '  ' }), 'FEDERATION_SUBJECT_MISSING');
});

test('single logout terminates only the sessions the IdP actually named', () => {
  const sessions = [
    { sessionId: 's1', tenantId: FED_TENANT, subject: 'anna.andersson', sessionIndex: 'idx-1' },
    { sessionId: 's2', tenantId: FED_TENANT, subject: 'anna.andersson', sessionIndex: 'idx-2' },
    { sessionId: 's3', tenantId: FED_TENANT, subject: 'bo.bosson', sessionIndex: 'idx-1' },
    { sessionId: 's4', tenantId: '00000000-0000-4000-8000-0000000000b2', subject: 'anna.andersson', sessionIndex: 'idx-1' },
  ];
  const logout = (overrides = {}) => ({ issuer: 'https://idp.kungalv.se/metadata', subject: 'anna.andersson', sessionIndex: null, signatureVerified: true, ...overrides });

  // No session index means every session for that subject, in that tenant only.
  assert.deepEqual(resolveLogoutTargets(logout(), fedConfig(), sessions), ['s1', 's2']);
  assert.deepEqual(resolveLogoutTargets(logout({ sessionIndex: 'idx-1' }), fedConfig(), sessions), ['s1']);

  // An honoured unsigned or foreign logout would be a denial of service
  // against every user, so both are refused.
  const logoutCode = (overrides) => {
    try { resolveLogoutTargets(logout(overrides), fedConfig(), sessions); return 'NO_ERROR'; }
    catch (error) { return error.code; }
  };
  assert.equal(logoutCode({ signatureVerified: false }), 'FEDERATION_SIGNATURE_NOT_VERIFIED');
  assert.equal(logoutCode({ issuer: 'https://evil.example' }), 'FEDERATION_ISSUER_MISMATCH');
});

const SCIM_TENANT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000c2';
const scimContext = (overrides = {}) => ({
  tenantId: SCIM_TENANT, clientId: '00000000-0000-4000-8000-0000000000c3', requestId: 'req-1',
  assignableRoles: ['tenant_admin', 'case_manager'],
  groupToRole: { 'Kommunsign-Admin': 'tenant_admin', 'Kommunsign-Handlaggare': 'case_manager' }, ...overrides,
});
const scimUser = (overrides = {}) => ({
  id: '00000000-0000-4000-8000-0000000000c4', tenantId: SCIM_TENANT, externalId: 'ext-1',
  userName: 'anna.andersson', displayName: 'Anna Andersson', email: 'anna@kungalv.se', active: true,
  roles: [], groups: [], createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...overrides,
});
const scimCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };
const SCIM_NOW = '2026-08-07T12:00:00.000Z';

test('SCIM provisioning is idempotent and never crosses a tenant boundary', () => {
  const context = scimContext();
  const existing = [scimUser()];

  // IdPs retry provisioning freely. Without idempotency on externalId each
  // retry either duplicates the account or 409s and stalls the sync.
  const retry = createScimUser(context, { userName: 'anna.andersson', externalId: 'ext-1' }, existing, 'new-id', SCIM_NOW);
  assert.equal(retry.idempotentMatch, true);
  assert.equal(retry.user.id, scimUser().id);

  // Two different directory entries claiming one login is a real conflict.
  assert.equal(scimCode(() => createScimUser(context, { userName: 'ANNA.ANDERSSON', externalId: 'ext-2' }, existing, 'n', SCIM_NOW)), 'SCIM_UNIQUENESS');
  assert.equal(scimCode(() => createScimUser(context, { externalId: 'ext-3' }, existing, 'n', SCIM_NOW)), 'SCIM_INVALID_VALUE');

  const created = createScimUser(context, { userName: 'bo.bosson', externalId: 'ext-9', emails: [{ value: 'B@Kungalv.se', primary: true }] }, existing, 'new-id', SCIM_NOW);
  assert.equal(created.idempotentMatch, false);
  assert.equal(created.user.tenantId, SCIM_TENANT); // never from the payload
  assert.equal(created.user.email, 'b@kungalv.se');
  assert.equal(created.user.active, true); // SCIM default

  // A user in another tenant must be invisible, not merely forbidden: a 403
  // confirms the resource is real and turns ID enumeration into a directory
  // listing. So this is 404.
  const foreign = scimUser({ tenantId: OTHER_TENANT });
  assert.equal(scimCode(() => assertScimTenant(context, foreign)), 'SCIM_TENANT_MISMATCH');
  assert.equal(new ScimError('SCIM_TENANT_MISMATCH', 'x').status, 404);
  assert.equal(scimCode(() => applyScimPatch(context, foreign, [{ op: 'replace', path: 'active', value: false }], SCIM_NOW)), 'SCIM_TENANT_MISMATCH');
  assert.equal(scimCode(() => deprovisionScimUser(context, foreign, true, SCIM_NOW)), 'SCIM_TENANT_MISMATCH');
  // Idempotent lookup must not reach across tenants either.
  assert.equal(createScimUser(context, { userName: 'x.y', externalId: 'ext-1' }, [foreign], 'n', SCIM_NOW).idempotentMatch, false);
});

test('SCIM deactivation keeps the user record instead of deleting the audit trail', () => {
  const context = scimContext();
  // This is how Entra and most directories deprovision.
  const disabled = applyScimPatch(context, scimUser(), [{ op: 'replace', path: 'active', value: false }], SCIM_NOW);
  assert.equal(disabled.active, false);
  assert.equal(disabled.id, scimUser().id);
  assert.equal(disabled.updatedAt, SCIM_NOW);

  // Some directories send the strings rather than booleans.
  assert.equal(applyScimPatch(context, scimUser(), [{ op: 'replace', path: 'active', value: 'False' }], SCIM_NOW).active, false);
  assert.equal(scimCode(() => applyScimPatch(context, scimUser(), [{ op: 'replace', path: 'active', value: 'maybe' }], SCIM_NOW)), 'SCIM_INVALID_VALUE');

  // Entra also sends pathless replace with an attribute object.
  const renamed = applyScimPatch(context, scimUser(), [{ op: 'replace', value: { displayName: 'Anna Ny', active: false } }], SCIM_NOW);
  assert.equal(renamed.displayName, 'Anna Ny');
  assert.equal(renamed.active, false);

  // Refused rather than ignored: silently dropping an attribute the directory
  // believes it set leaves the two sides disagreeing forever.
  assert.equal(scimCode(() => applyScimPatch(context, scimUser(), [{ op: 'replace', path: 'roles', value: ['tenant_admin'] }], SCIM_NOW)), 'SCIM_INVALID_PATH');
  assert.equal(scimCode(() => applyScimPatch(context, scimUser(), [{ op: 'replace', path: 'id', value: 'x' }], SCIM_NOW)), 'SCIM_INVALID_PATH');
  assert.equal(scimCode(() => applyScimPatch(context, scimUser(), [{ op: 'merge', path: 'active', value: false }], SCIM_NOW)), 'SCIM_INVALID_VALUE');

  // A DELETE for a user with history degrades to deactivation: removing the row
  // would orphan the signatures and audit events that name them.
  assert.equal(deprovisionScimUser(context, scimUser(), true, SCIM_NOW).action, 'DEACTIVATED');
  assert.equal(deprovisionScimUser(context, scimUser(), false, SCIM_NOW).action, 'DELETED');
});

test('SCIM roles come from mapped groups only, and never above the client scope', () => {
  const context = scimContext();
  const withGroups = applyGroupMembership(context, scimUser(), ['Kommunsign-Handlaggare', 'Ovrig-Grupp'], SCIM_NOW);
  // An unmapped group grants nothing.
  assert.deepEqual(withGroups.roles, ['case_manager']);
  assert.deepEqual(withGroups.groups, ['Kommunsign-Handlaggare', 'Ovrig-Grupp']);
  assert.deepEqual(resolveScimRoles(context, []), []);
  assert.deepEqual(resolveScimRoles(context, ['Kommunsign-Admin', 'Kommunsign-Handlaggare']), ['case_manager', 'tenant_admin']);

  // A directory admin adding someone to a group must not escalate beyond what
  // the provisioning client itself was scoped for.
  const escalating = scimContext({ groupToRole: { 'Kommunsign-Admin': 'platform_superadmin' } });
  assert.equal(scimCode(() => resolveScimRoles(escalating, ['Kommunsign-Admin'])), 'SCIM_ROLE_NOT_ASSIGNABLE');
});

test('SCIM pagination is 1-based and filters are a strict subset', () => {
  const resources = Array.from({ length: 250 }, (_, index) => ({ index }));

  // RFC 7644 §3.4.2.4. Treating this as 0-based skips or duplicates a user on
  // every page boundary, which surfaces months later as missing staff.
  const first = paginateScim(resources, 1, 100);
  assert.equal(first.startIndex, 1);
  assert.deepEqual(first.Resources[0], { index: 0 });
  assert.equal(first.totalResults, 250);
  assert.equal(first.itemsPerPage, 100);

  const second = paginateScim(resources, 101, 100);
  assert.deepEqual(second.Resources[0], { index: 100 });
  // No overlap and no gap between consecutive pages.
  assert.deepEqual(first.Resources.at(-1), { index: 99 });

  assert.equal(scimCode(() => paginateScim(resources, 0, 10)), 'SCIM_INVALID_PAGINATION');
  assert.equal(scimCode(() => paginateScim(resources, -1, 10)), 'SCIM_INVALID_PAGINATION');
  assert.equal(scimCode(() => paginateScim(resources, 1, -1)), 'SCIM_INVALID_PAGINATION');
  // An oversized count is a resource limit, so it is capped rather than refused.
  assert.equal(paginateScim(resources, 1, 10_000).itemsPerPage, SCIM_MAXIMUM_PAGE_SIZE);
  assert.equal(paginateScim(resources, 251, 10).Resources.length, 0);

  // The filter grammar is a strict subset: every attribute is a column, and an
  // over-general parser is how a filter string becomes a query-shaping input.
  assert.deepEqual(parseScimFilter('userName eq "anna.andersson"'), { attribute: 'userName', operator: 'eq', value: 'anna.andersson' });
  assert.deepEqual(parseScimFilter('externalId Eq "ext-1"'), { attribute: 'externalId', operator: 'eq', value: 'ext-1' });
  assert.deepEqual(parseScimFilter('active eq true'), { attribute: 'active', operator: 'eq', value: 'true' });
  assert.equal(parseScimFilter(undefined), null);
  for (const bad of ['userName co "a"', 'userName eq "a" or userName eq "b"', 'password eq "x"', 'userName eq ""', 'userName eq "a\\"']) {
    assert.equal(scimCode(() => parseScimFilter(bad)), 'SCIM_INVALID_FILTER', bad);
  }

  assert.equal(matchesScimFilter(scimUser(), parseScimFilter('userName eq "ANNA.ANDERSSON"')), true);
  assert.equal(matchesScimFilter(scimUser({ externalId: null }), parseScimFilter('externalId eq "ext-1"')), false);
  assert.equal(matchesScimFilter(scimUser({ active: false }), parseScimFilter('active eq true')), false);

  // The wire shape keeps the schema URN and a relative location, so one tenant
  // hostname is never baked into a record served from several.
  const resource = toScimUserResource(scimUser({ roles: ['case_manager'] }));
  assert.deepEqual(resource.schemas, ['urn:ietf:params:scim:schemas:core:2.0:User']);
  assert.equal(resource.meta.location, `/scim/v2/Users/${scimUser().id}`);
  assert.deepEqual(resource.roles, [{ value: 'case_manager' }]);
});

const bytesOf = (text) => new TextEncoder().encode(text);
const archiveCase = (overrides = {}) => ({
  tenantId: '00000000-0000-4000-8000-0000000000d1',
  signatureCaseId: '00000000-0000-4000-8000-0000000000d2',
  reference: 'KS2026-0001', title: 'Delegationsbeslut', decisionMode: 'ELECTRONIC_SIGNATURE',
  status: 'archived', createdAt: '2026-08-01T00:00:00.000Z', closedAt: '2026-08-05T00:00:00.000Z',
  documents: [{
    documentId: '00000000-0000-4000-8000-0000000000d3', documentVersionId: '00000000-0000-4000-8000-0000000000d4',
    displayName: 'beslut.pdf', sha256: 'e'.repeat(64), byteSize: 12, verifiedProfile: 'PDF/A-2b', isSignedArtifact: true,
  }],
  signatures: [{
    signerId: '00000000-0000-4000-8000-0000000000d5', signedAt: '2026-08-04T00:00:00.000Z', padesLevel: 'LT',
    signatureArtifactSha256: 'f'.repeat(64), validationReportSha256: '1'.repeat(64), timestampTokenSha256: '2'.repeat(64),
  }],
  identities: [{
    signerId: '00000000-0000-4000-8000-0000000000d5', provider: 'TIC_BANKID', assuranceLevel: 'HIGH',
    maskedIdentifier: '19800101-****', verifiedAt: '2026-08-04T00:00:00.000Z', evidenceSha256: '3'.repeat(64),
  }],
  auditTrailSha256: '4'.repeat(64), ...overrides,
});
const archiveFiles = () => [
  { path: 'content/beslut.pdf', bytes: bytesOf('signed-pdf-1'), mediaType: 'application/pdf' },
  { path: 'metadata/descriptive.json', bytes: bytesOf('{"a":1}'), mediaType: 'application/json' },
  { path: 'evidence/validation-report.json', bytes: bytesOf('{"r":"ok"}'), mediaType: 'application/json' },
];
const archiveCode = async (fn) => { try { await fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('an archive package refuses to misrepresent what it contains', async () => {
  assert.equal(await archiveCode(() => buildArchivePackage(archiveCase(), archiveFiles())), 'NO_ERROR');

  // Archiving a running case would freeze a half-finished record and imply it
  // was final.
  assert.equal(await archiveCode(() => buildArchivePackage(archiveCase({ closedAt: null }), archiveFiles())), 'ARCHIVE_CASE_NOT_CLOSED');
  assert.equal(await archiveCode(() => buildArchivePackage(archiveCase({ documents: [] }), archiveFiles())), 'ARCHIVE_DOCUMENT_MISSING');

  // RA-FS requires a preservation format. A profile the processor did not
  // verify is a claim, not a format.
  const unverified = archiveCase({ documents: [{ ...archiveCase().documents[0], verifiedProfile: null }] });
  assert.equal(await archiveCode(() => buildArchivePackage(unverified, archiveFiles())), 'ARCHIVE_PROFILE_NOT_VERIFIED');

  // An electronic signature exported without signature evidence would be a
  // false statement about a legal act.
  assert.equal(await archiveCode(() => buildArchivePackage(archiveCase({ signatures: [] }), archiveFiles())), 'ARCHIVE_SIGNATURE_EVIDENCE_MISSING');
  const noReport = archiveCase({ signatures: [{ ...archiveCase().signatures[0], validationReportSha256: null }] });
  assert.equal(await archiveCode(() => buildArchivePackage(noReport, archiveFiles())), 'ARCHIVE_SIGNATURE_EVIDENCE_MISSING');
  // A signature with no identity evidence cannot prove who signed.
  assert.equal(await archiveCode(() => buildArchivePackage(archiveCase({ identities: [] }), archiveFiles())), 'ARCHIVE_IDENTITY_EVIDENCE_MISSING');
  // Without the audit trail the package records the outcome but not the process.
  assert.equal(await archiveCode(() => buildArchivePackage(archiveCase({ auditTrailSha256: null }), archiveFiles())), 'ARCHIVE_AUDIT_TRAIL_MISSING');

  // A digital approval has no PAdES signature and must not be required to
  // carry one — the completeness rules are asymmetric on purpose.
  const approval = archiveCase({ decisionMode: 'DIGITAL_APPROVAL', signatures: [], identities: [] });
  assert.equal(await archiveCode(() => buildArchivePackage(approval, archiveFiles())), 'NO_ERROR');

  // Path traversal and stray namespaces are refused outright.
  for (const path of ['../etc/passwd', 'content/../x', 'other/file.pdf', 'content/']) {
    assert.equal(
      await archiveCode(() => buildArchivePackage(archiveCase(), [{ path, bytes: bytesOf('x'), mediaType: 'application/pdf' }])),
      'ARCHIVE_PATH_INVALID', path,
    );
  }
  // A package with metadata but no content describes a delivery missing its files.
  assert.equal(
    await archiveCode(() => buildArchivePackage(archiveCase(), [{ path: 'metadata/only.json', bytes: bytesOf('{}'), mediaType: 'application/json' }])),
    'ARCHIVE_DOCUMENT_MISSING',
  );
});

test('an archive package is deterministic and verifiable with nothing but itself', async () => {
  const first = await buildArchivePackage(archiveCase(), archiveFiles());
  // Same case, files supplied in a different order.
  const shuffled = [archiveFiles()[2], archiveFiles()[0], archiveFiles()[1]];
  const second = await buildArchivePackage(archiveCase(), shuffled);

  // If the same closed case exported twice differed, no one could prove the
  // archive copy is the delivered copy.
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(first.manifest.entries.map((entry) => entry.path), second.manifest.entries.map((entry) => entry.path));
  assert.deepEqual(first.manifest.entries.map((entry) => entry.path), ['content/beslut.pdf', 'evidence/validation-report.json', 'metadata/descriptive.json']);
  assert.equal(first.manifest.regulation, 'RA-FS 2009:2');
  assert.deepEqual(first.manifest.entries.map((entry) => entry.category), ['content', 'evidence', 'metadata']);

  // Verification needs the package, the manifest and the separately delivered
  // manifest hash — no database, no network.
  assert.deepEqual(await verifyArchivePackage(first.manifest, archiveFiles(), first.manifestSha256), { verified: true, failures: [] });

  // A tampered file is detected.
  const tampered = archiveFiles().map((file) => file.path === 'content/beslut.pdf' ? { ...file, bytes: bytesOf('signed-pdf-2') } : file);
  const tamperedResult = await verifyArchivePackage(first.manifest, tampered, first.manifestSha256);
  assert.equal(tamperedResult.verified, false);
  assert.match(tamperedResult.failures.join(' '), /Hash mismatch: content\/beslut\.pdf/);

  // A missing file and an extra file are both failures: a package carrying
  // content the manifest does not describe was not delivered as described.
  assert.match((await verifyArchivePackage(first.manifest, archiveFiles().slice(1), first.manifestSha256)).failures.join(' '), /Missing file/);
  assert.match(
    (await verifyArchivePackage(first.manifest, [...archiveFiles(), { path: 'content/extra.pdf', bytes: bytesOf('x'), mediaType: 'application/pdf' }], first.manifestSha256)).failures.join(' '),
    /Unexpected file/,
  );

  // The manifest hash is delivered outside the manifest. A checksum stored
  // inside would re-certify any modification to the manifest itself.
  const forged = { ...first.manifest, title: 'Något annat' };
  const forgedResult = await verifyArchivePackage(forged, archiveFiles(), first.manifestSha256);
  assert.equal(forgedResult.verified, false);
  assert.deepEqual(forgedResult.failures, ['Manifest hash does not match the delivered manifest hash']);

  // Descriptive metadata is technology-neutral and carries no full personal
  // number: an archive package outlives every access control around it.
  const metadata = buildDescriptiveMetadata(archiveCase());
  assert.equal(metadata.signatories[0].identifier, '19800101-****');
  assert.equal(metadata.documents[0].format, 'PDF/A-2b');
  assert.doesNotMatch(canonicalJson(metadata), /\d{8}-?\d{4}/);
});

const GAL_TENANT = '00000000-0000-4000-8000-0000000000e1';
const GAL_CASE = '00000000-0000-4000-8000-0000000000e2';
const REQUESTER = '00000000-0000-4000-8000-0000000000e3';
const APPROVER = '00000000-0000-4000-8000-0000000000e4';
const GAL_NOW = new Date('2026-08-07T12:00:00.000Z');
const galPolicy = (overrides = {}) => ({
  policyKey: 'case-default', version: 1, retentionClass: 'business_data',
  mode: 'delete_after_period', periodDays: 30, active: true, ...overrides,
});
const galSubject = (overrides = {}) => ({
  tenantId: GAL_TENANT, caseId: GAL_CASE, status: 'completed',
  closedAt: '2026-01-01T00:00:00.000Z', legalHoldActive: false, ...overrides,
});
const galJob = (overrides = {}) => ({
  tenantId: GAL_TENANT, jobId: '00000000-0000-4000-8000-0000000000e5', state: 'QUEUED',
  policyKey: 'case-default', policyVersion: 1, caseIds: [GAL_CASE],
  queuedDecision: { action: 'DELETE', reason: 'DUE_FOR_DELETION', eligibleAt: '2026-01-31T00:00:00.000Z' },
  queuedAt: '2026-08-06T00:00:00.000Z', plannedTargets: [], requestedBy: REQUESTER,
  approvedBy: null, approvedAt: null, ...overrides,
});
const galApprover = (overrides = {}) => ({
  actorId: APPROVER, tenantId: GAL_TENANT, hasRetentionExecutePermission: true, isPlatformStaff: false, ...overrides,
});
const allOutcomes = (overrides = {}) => MANDATORY_CASE_TARGETS.map((target) => ({
  target, deletedCount: 1, verified: true, ...(overrides[target] ?? {}),
}));
const galCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('gallring is approved by the customer, by someone other than the requester', () => {
  const due = selectDueCases(galPolicy(), [galSubject(), galSubject({ caseId: 'x', legalHoldActive: true })], GAL_NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].decision.action, 'DELETE');

  const planned = planGallring(galJob());
  assert.equal(planned.state, 'PLANNED');
  // The plan always covers the derived stores people forget — a search index or
  // cache that keeps serving content after the primary row is gone means the
  // information is still recoverable (krav 2070).
  for (const target of ['search_index', 'cache', 'notifications', 'object_storage']) {
    assert.ok(planned.plannedTargets.includes(target), target);
  }

  const approved = approveGallring(planned, galApprover(), GAL_NOW.toISOString());
  assert.equal(approved.state, 'APPROVED');
  assert.equal(approved.approvedBy, APPROVER);

  // Krav 2069 cuts both ways: the customer can gallra without the supplier,
  // so the supplier must not gallra without the customer.
  assert.equal(galCode(() => approveGallring(planned, galApprover({ isPlatformStaff: true }))), 'GALLRING_APPROVER_NOT_PERMITTED');
  assert.equal(galCode(() => approveGallring(planned, galApprover({ hasRetentionExecutePermission: false }))), 'GALLRING_APPROVER_NOT_PERMITTED');
  assert.equal(galCode(() => approveGallring(planned, galApprover({ tenantId: 'other' }))), 'GALLRING_TENANT_MISMATCH');
  // Gallring is irreversible; one account must not both propose and execute it.
  assert.equal(galCode(() => approveGallring(planned, galApprover({ actorId: REQUESTER }))), 'GALLRING_SELF_APPROVAL');
  // States are ordered: approval cannot skip planning.
  assert.equal(galCode(() => approveGallring(galJob(), galApprover())), 'GALLRING_STATE_INVALID');
});

test('a queued gallring decision is re-checked before anything is deleted', () => {
  const approved = approveGallring(planGallring(galJob()), galApprover(), GAL_NOW.toISOString());
  assert.equal(beginGallringExecution(approved, galPolicy(), [galSubject()], GAL_NOW).state, 'EXECUTING');

  // This is the defect the re-check exists for: a legal hold placed after the
  // job was queued must stop the deletion, not be overridden by yesterday's
  // decision.
  assert.equal(
    galCode(() => beginGallringExecution(approved, galPolicy(), [galSubject({ legalHoldActive: true })], GAL_NOW)),
    'GALLRING_DECISION_STALE',
  );
  // A case reopened since queuing is no longer closed, so its clock restarted.
  assert.equal(
    galCode(() => beginGallringExecution(approved, galPolicy(), [galSubject({ status: 'in_progress', closedAt: null })], GAL_NOW)),
    'GALLRING_DECISION_STALE',
  );
  // A policy changed to archive-then-delete changes the act, not just its timing.
  assert.equal(
    galCode(() => beginGallringExecution(approved, galPolicy({ mode: 'archive_then_delete' }), [galSubject()], GAL_NOW)),
    'GALLRING_DECISION_STALE',
  );
  // Nothing outside the approved job may be swept in.
  assert.equal(
    galCode(() => beginGallringExecution(approved, galPolicy(), [galSubject({ caseId: 'other-case' })], GAL_NOW)),
    'GALLRING_DECISION_STALE',
  );
  assert.equal(
    galCode(() => beginGallringExecution(approved, galPolicy(), [galSubject({ tenantId: 'other-tenant' })], GAL_NOW)),
    'GALLRING_TENANT_MISMATCH',
  );
  assert.equal(galCode(() => beginGallringExecution(planGallring(galJob()), galPolicy(), [galSubject()], GAL_NOW)), 'GALLRING_STATE_INVALID');
});

test('a partial gallring cannot be reported as complete', () => {
  const executing = beginGallringExecution(
    approveGallring(planGallring(galJob()), galApprover(), GAL_NOW.toISOString()),
    galPolicy(), [galSubject()], GAL_NOW,
  );

  const verified = verifyGallringExecution(executing, allOutcomes());
  assert.equal(verified.state, 'VERIFIED');
  const { job, report } = completeGallring(verified, allOutcomes(), 'business_data', GAL_NOW.toISOString());
  assert.equal(job.state, 'REPORTED');
  assert.equal(report.complete, true);
  assert.equal(report.caseCount, 1);
  // The report records who authorised the irreversible act, not who asked.
  assert.equal(report.executedBy, APPROVER);

  // The defect: a run addressing only some targets hands over only verified
  // outcomes and looks complete. Comparing against the declared plan is what
  // turns an unaddressed target into a detected omission.
  const partial = allOutcomes().filter((outcome) => !['search_index', 'cache'].includes(outcome.target));
  assert.equal(galCode(() => verifyGallringExecution(executing, partial)), 'GALLRING_TARGET_NOT_EXECUTED');
  // Note the same partial set is judged complete by the report builder alone,
  // which is exactly why the plan check has to exist.
  assert.equal(buildGallringReport({
    tenantId: GAL_TENANT, jobId: galJob().jobId, policyKey: 'k', policyVersion: 1,
    retentionClass: 'business_data', executedBy: APPROVER, executedAt: GAL_NOW.toISOString(),
    caseIds: [GAL_CASE], outcomes: partial,
  }).complete, true);

  // A target we could not confirm may still hold a readable copy (krav 2070).
  assert.equal(galCode(() => verifyGallringExecution(executing, allOutcomes({ object_storage: { verified: false } }))), 'GALLRING_NOT_VERIFIED');
  // Deleting from a store nobody authorised is also a failure.
  assert.equal(
    galCode(() => verifyGallringExecution(executing, [...allOutcomes(), { target: 'signature_case', deletedCount: 1, verified: true }])),
    'GALLRING_TARGET_DUPLICATE',
  );
  // Completion is unreachable without a verified execution.
  assert.equal(galCode(() => completeGallring(executing, allOutcomes(), 'business_data', GAL_NOW.toISOString())), 'GALLRING_STATE_INVALID');

  // Stopping a deletion is never the dangerous direction, so abandoning is
  // always allowed — except once the deletion has already been reported.
  assert.equal(abandonGallring(executing, 'operator stopped it').state, 'ABANDONED');
  assert.equal(galCode(() => abandonGallring(job, 'too late')), 'GALLRING_STATE_INVALID');
});

const SUBJECT = '00000000-0000-4000-8000-0000000000f1';
const HANDLER = '00000000-0000-4000-8000-0000000000f2';
const privacyJob = ({ request: requestOverrides, ...overrides } = {}) => ({
  state: 'RECEIVED', subjectId: SUBJECT, identity: null, handledBy: null,
  refusalGround: null, response: null, ...overrides,
  request: privacyRequest({ right: 'ACCESS', ...(requestOverrides ?? {}) }),
});
const strongIdentity = (overrides = {}) => ({
  verified: true, method: 'BANKID', assuranceLevel: 'HIGH', subjectId: SUBJECT,
  verifiedAt: '2026-08-07T10:00:00.000Z', ...overrides,
});
const privJobCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('a rights request cannot act before the right person is verified', () => {
  const job = privacyJob();
  // This is the defect: a rights request is otherwise the easiest route to
  // someone else's data — you only have to claim to be them.
  assert.equal(privJobCode(() => beginHandling(job, HANDLER, job.request.tenantId)), 'PRIVACY_STATE_INVALID');
  assert.equal(privJobCode(() => verifySubjectIdentity(job, strongIdentity({ verified: false }))), 'PRIVACY_IDENTITY_NOT_VERIFIED');
  // Verifying *someone* is not enough; it must be the person the request is about.
  assert.equal(privJobCode(() => verifySubjectIdentity(job, strongIdentity({ subjectId: HANDLER }))), 'PRIVACY_SUBJECT_MISMATCH');

  // An access extract released on an email address someone happens to control
  // is itself a personal data breach, so disclosure needs strong identity.
  for (const right of ['ACCESS', 'ERASURE', 'PORTABILITY', 'RECTIFICATION']) {
    assert.equal(
      privJobCode(() => verifySubjectIdentity(privacyJob({ request: { right } }), strongIdentity({ assuranceLevel: 'SUBSTANTIAL' }))),
      'PRIVACY_IDENTITY_ASSURANCE_TOO_LOW', right,
    );
  }
  // Restriction protects the data subject; requiring strong identity for it
  // would make the shield harder to obtain than the intrusion.
  assert.equal(
    privJobCode(() => verifySubjectIdentity(privacyJob({ request: { right: 'RESTRICTION' } }), strongIdentity({ assuranceLevel: 'LOW' }))),
    'NO_ERROR',
  );

  const verified = verifySubjectIdentity(job, strongIdentity());
  assert.equal(verified.state, 'IDENTITY_VERIFIED');
  assert.equal(privJobCode(() => beginHandling(verified, HANDLER, '00000000-0000-4000-8000-0000000000ff')), 'PRIVACY_TENANT_MISMATCH');
  assert.equal(beginHandling(verified, HANDLER, job.request.tenantId).state, 'IN_PROGRESS');
});

test('erasure re-checks legal hold and restriction at the moment of execution', () => {
  const inProgress = beginHandling(
    verifySubjectIdentity(privacyJob({ request: { right: 'ERASURE' } }), strongIdentity()),
    HANDLER, privacyRequest().tenantId,
  );

  // The hold state is re-read rather than trusted from the request: a hold
  // placed after the request arrived must still stop the erasure.
  assert.equal(privJobCode(() => fulfilRequest(inProgress, fullCoverage(), true, false)), 'PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD');
  // Article 18: restricted processing means the data is kept but not processed.
  assert.equal(privJobCode(() => fulfilRequest(inProgress, fullCoverage(), false, true)), 'PRIVACY_RESTRICTION_ACTIVE');
  // The completeness check is not bypassable through this path either.
  assert.equal(
    privJobCode(() => fulfilRequest(inProgress, fullCoverage().filter((entry) => entry.store !== 'CONTROL'), false, false)),
    'PRIVACY_COVERAGE_INCOMPLETE',
  );

  const fulfilled = fulfilRequest(inProgress, fullCoverage(), false, false);
  assert.equal(fulfilled.state, 'FULFILLED');
  assert.deepEqual([...fulfilled.response.exemptedStores].sort(), ['AUDIT_LOG', 'BACKUP']);

  // Acting on the data and disclosing it are separate events with separate
  // evidence, so delivery is a separate transition.
  assert.equal(deliverResponse(fulfilled).state, 'DELIVERED');
  assert.equal(privJobCode(() => deliverResponse(inProgress)), 'PRIVACY_STATE_INVALID');

  // A refusal without a legal ground is not a refusal, it is an unhandled
  // request — the data subject needs the reason in order to complain.
  assert.equal(privJobCode(() => refuseRequest(inProgress, '   ')), 'PRIVACY_REFUSAL_NEEDS_GROUND');
  assert.equal(refuseRequest(inProgress, 'GDPR art. 17.3 b').state, 'REFUSED');
  assert.equal(privJobCode(() => refuseRequest(deliverResponse(fulfilled), 'för sent')), 'PRIVACY_STATE_INVALID');
});

test('the thirty-day deadline runs from receipt and overdue requests stay visible', () => {
  // PUB-avtalet 10.1 counts from receipt, not from when handling happened to
  // start, so a request parked for a month is already late when it is opened.
  assert.equal(deadlineFor(privacyRequest({ receivedAt: '2026-08-07T00:00:00.000Z' })), '2026-09-06T00:00:00.000Z');

  const old = privacyJob({ request: { requestId: '00000000-0000-4000-8000-0000000000fa', receivedAt: '2026-06-01T00:00:00.000Z' } });
  const recent = privacyJob({ request: { requestId: '00000000-0000-4000-8000-0000000000fb', receivedAt: '2026-08-06T00:00:00.000Z' } });
  const delivered = { ...old, request: { ...old.request, requestId: '00000000-0000-4000-8000-0000000000fc' }, state: 'DELIVERED' };
  const refused = { ...old, request: { ...old.request, requestId: '00000000-0000-4000-8000-0000000000fd' }, state: 'REFUSED' };

  const overdue = overdueRequests([old, recent, delivered, refused], new Date('2026-08-07T12:00:00.000Z'));
  // An overdue request surfaces as an open case with its state, rather than
  // being a date that quietly slipped past.
  assert.deepEqual(overdue.map((entry) => entry.requestId), ['00000000-0000-4000-8000-0000000000fa']);
  assert.equal(overdue[0].state, 'RECEIVED');
  assert.equal(overdue[0].dueAt, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(overdueRequests([recent], new Date('2026-09-30T00:00:00.000Z')).length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`${tests.length} tests passed`);
