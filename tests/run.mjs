import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { createObjectStorageAdapter as createS3ObjectStorageAdapter } from '../dist/apps/api/src/adapters/s3-object-storage.js';
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
  buildSigningIntentManifest, signingIntentManifestBytes, signingIntentManifestSha256,
} from '../dist/packages/signing-engine/src/manifest.js';
import { SignServiceClient } from '../dist/packages/signservice-client/src/index.js';
import { signWebhook, verifyWebhook } from '../dist/packages/webhooks/src/index.js';
import { buildFgsPackage, FGS_CONFORMANCE_STATUS, FGS_SPECIFICATION } from '../dist/packages/archive/src/fgs.js';
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
import {
  assertSubjectLineIsSafe, assertSupportAccess, decideDisclosure, isSearchable,
  normaliseProtectionLevel, OUTPUT_CHANNELS, redactedPlaceholder,
} from '../dist/packages/protected-identity/src/index.js';
import {
  assertBundleUnchanged, assertOrderIsWellFormed, assertSignerMaySign, buildSigningBundle,
  caseOutcome, decideReminder, signersAwaitingAction,
} from '../dist/packages/signing-workflow/src/index.js';
import {
  activeKeyVersion, assertKeyRingIsSane, assertNoCompromisedIndexRemains, assertReadableVersion,
  assertRotationComplete, assertWritableVersion, beginDualRead, planBlindIndexRotation,
  retireOldVersion, rollbackRotation, rotationRequired,
} from '../dist/packages/crypto/src/key-rotation.js';
import {
  assertMetricLabelsAreSafe, assertSecurityEventIsTraceable, buildLogRecord, cacheHeaders,
  isForbiddenLogField, isSecurityEvent, METRICS, sanitiseLogPayload, securityHeaders,
  stuckSigningRatio, TLS_POLICY,
} from '../dist/packages/observability/src/index.js';
import {
  admitConvertedDocument, ADOBE_READER_COMPATIBILITY, planOfficeIngestion,
} from '../dist/packages/document-processing/src/office-ingestion.js';
import {
  formatSwedishDate, formatSwedishDateTime, formatSwedishTime,
  formatSwedishTimestampWithOffset, messageFor, swedishUtcOffsetHours,
} from '../dist/packages/locale/src/index.js';
import {
  handleApplicationDeadline, handleCertificateMonitor, handleTenantActivation, handleTenantReadiness,
} from '../dist/apps/workers/src/platform-handlers.js';
import { handlePrivacyRequestExecute } from '../dist/apps/workers/src/privacy-handlers.js';
import { handleScimRequest } from '../dist/apps/api/src/scim-router.js';
import { handleFederationRequest } from '../dist/apps/api/src/federation-router.js';
import {
  PROMETHEUS_COUNTERS, PROMETHEUS_GAUGES, PROMETHEUS_UNFED_SERIES, renderPrometheus,
} from '../dist/packages/observability/src/prometheus.js';

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
const fedCode = async (assertion = {}, config = {}, binding = {}, ledger = new InMemoryAssertionLedger()) => {
  try { await verifyWorkforceAssertion(fedAssertion(assertion), fedConfig(config), fedBinding(binding), ledger, NOW); return 'NO_ERROR'; }
  catch (error) { return error.code; }
};

test('a federated assertion is admitted only when it answers our own login request', async () => {
  assert.equal(await fedCode(), 'NO_ERROR');

  // Nothing below the signature means anything on an unsigned assertion.
  assert.equal(await fedCode({ signatureVerified: false }), 'FEDERATION_SIGNATURE_NOT_VERIFIED');
  // A disabled provider must not authenticate anyone, even with a valid
  // assertion left over from when it was enabled.
  assert.equal(await fedCode({}, { enabled: false }), 'FEDERATION_PROVIDER_DISABLED');
  assert.equal(await fedCode({ issuer: 'https://evil.example' }), 'FEDERATION_ISSUER_MISMATCH');
  // An assertion minted for a different service provider by the same IdP.
  assert.equal(await fedCode({ audience: 'https://other.example/sp' }), 'FEDERATION_AUDIENCE_MISMATCH');
  // One captured at a different endpoint and posted to ours.
  assert.equal(await fedCode({ destination: 'https://other.example/acs' }), 'FEDERATION_DESTINATION_MISMATCH');
  // IdP-initiated flows are refused: a stolen assertion could be posted at any
  // time if it did not have to answer a request we started.
  assert.equal(await fedCode({ inResponseTo: null }), 'FEDERATION_REQUEST_MISMATCH');
  assert.equal(await fedCode({ inResponseTo: 'request-2' }), 'FEDERATION_REQUEST_MISMATCH');
  // AGENTS.md rule 1: tenant comes from the bound configuration, never the message.
  assert.equal(await fedCode({}, {}, { tenantId: '00000000-0000-4000-8000-0000000000b2' }), 'FEDERATION_TENANT_MISMATCH');
  assert.equal(await fedCode({ subject: '   ' }, {}, {}), 'FEDERATION_SUBJECT_MISSING');
});

test('a federated assertion expires, cannot be replayed, and carries a fresh enough session', async () => {
  assert.equal(await fedCode({ notOnOrAfter: '2026-08-07T11:00:00.000Z' }), 'FEDERATION_ASSERTION_EXPIRED');
  assert.equal(await fedCode({ notBefore: '2026-08-07T12:30:00.000Z' }), 'FEDERATION_ASSERTION_NOT_YET_VALID');

  // Within its validity window the same assertion is accepted every time it is
  // presented, unless it is consumed exactly once.
  const ledger = new InMemoryAssertionLedger();
  assert.equal(await fedCode({}, {}, {}, ledger), 'NO_ERROR');
  assert.equal(await fedCode({}, {}, {}, ledger), 'FEDERATION_ASSERTION_REPLAYED');

  // A fresh assertion can still describe a very old IdP session.
  assert.equal(await fedCode({ authenticatedAt: '2026-08-07T06:00:00.000Z' }), 'FEDERATION_SESSION_TOO_OLD');
  assert.equal(await fedCode({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password' }), 'FEDERATION_AUTHN_CONTEXT_TOO_LOW');
  assert.equal(await fedCode({ authnContext: null }), 'FEDERATION_AUTHN_CONTEXT_TOO_LOW');
  // A tenant that demands no particular context accepts what the IdP sent.
  assert.equal(await fedCode({ authnContext: null }, { requiredAuthnContexts: [] }), 'NO_ERROR');

  // The same rules apply to OIDC: one decision, not two that can drift.
  assert.equal(await fedCode({ protocol: 'OIDC' }, { protocol: 'OIDC' }), 'NO_ERROR');
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

const PROT_TENANT = '00000000-0000-4000-8000-000000000101';
const PROT_SUBJECT = '00000000-0000-4000-8000-000000000102';
const PROT_ACTOR = '00000000-0000-4000-8000-000000000103';
const PROT_NOW = new Date('2026-08-07T12:00:00.000Z');
const assessment = (overrides = {}) => ({
  tenantId: PROT_TENANT, subjectId: PROT_SUBJECT, assessedBy: PROT_ACTOR,
  assessedAt: '2026-08-07T09:00:00.000Z', expiresAt: '2026-08-07T18:00:00.000Z',
  ground: 'Menprövning enligt OSL 21 kap. 3 §', ...overrides,
});
const disclose = (overrides = {}) => decideDisclosure({
  tenantId: PROT_TENANT, subjectId: PROT_SUBJECT, level: 'SEKRETESSMARKERING',
  channel: 'SCREEN_AUTHORISED', fields: ['fullName', 'personalNumber', 'address'],
  assessment: null, now: PROT_NOW, ...overrides,
});
const protCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('protected personal data is never disclosed on a channel that escapes access control', () => {
  // Logs are shipped to operators, analytics to third parties, and a URL ends
  // up in history, referrer headers and proxy logs. None of them carries an
  // identifying field for anyone, protected or not.
  for (const channel of ['APPLICATION_LOG', 'ANALYTICS', 'URL']) {
    for (const level of ['NONE', 'SEKRETESSMARKERING', 'SKYDDAD_FOLKBOKFORING']) {
      const decision = disclose({ channel, level, assessment: assessment() });
      assert.deepEqual(decision.disclosed, [], `${channel}/${level}`);
      assert.equal(decision.redacted.length, 3);
    }
  }

  // An unrecognised value becomes the strictest level, not NONE: a data error
  // or a new Skatteverket code must not silently remove the protection.
  assert.equal(normaliseProtectionLevel('NAGOT_NYTT'), 'FINGERADE_PERSONUPPGIFTER');
  assert.equal(normaliseProtectionLevel(42), 'FINGERADE_PERSONUPPGIFTER');
  assert.equal(normaliseProtectionLevel(null), 'NONE');
  assert.equal(normaliseProtectionLevel('SKYDDAD_FOLKBOKFORING'), 'SKYDDAD_FOLKBOKFORING');

  // Adding an output path must force a decision here rather than defaulting
  // to disclosure.
  assert.equal(protCode(() => disclose({ channel: 'SOME_NEW_EXPORT' })), 'PROTECTED_CHANNEL_UNKNOWN');

  // The subject line is always readable without authenticating — lock screen
  // previews, mail server logs, forwarded shared mailboxes.
  assert.equal(protCode(() => assertSubjectLineIsSafe('Signering klar för Anna Andersson', ['Anna Andersson'])), 'PROTECTED_DISCLOSURE_FORBIDDEN');
  assert.equal(protCode(() => assertSubjectLineIsSafe('Du har ett dokument att signera', ['Anna Andersson', '198001019876'])), 'NO_ERROR');
});

test('each protection level redacts what that level is actually protecting', () => {
  // Unprotected: everything renders.
  assert.deepEqual(disclose({ level: 'NONE' }).redacted, []);

  // Sekretessmarkering is a flag, not a redaction: disclosure is possible, but
  // only after a recorded confidentiality assessment.
  assert.deepEqual(disclose({ level: 'SEKRETESSMARKERING' }).disclosed, []);
  assert.deepEqual(disclose({ level: 'SEKRETESSMARKERING', assessment: assessment() }).redacted, []);

  // An assessment for another person, another tenant, without a ground, or
  // expired, is not an assessment for this disclosure.
  for (const bad of [{ subjectId: PROT_ACTOR }, { tenantId: PROT_ACTOR }, { ground: '  ' }, { expiresAt: '2026-08-07T10:00:00.000Z' }]) {
    assert.deepEqual(disclose({ level: 'SEKRETESSMARKERING', assessment: assessment(bad) }).disclosed, [], JSON.stringify(bad));
  }

  // Skyddad folkbokföring: the address is the thing being protected and is
  // never ours to disclose — Skatteverket holds it. Not even an assessment
  // unlocks it.
  const skyddad = disclose({ level: 'SKYDDAD_FOLKBOKFORING', assessment: assessment() });
  assert.ok(skyddad.redacted.includes('address'));
  assert.deepEqual(skyddad.disclosed, ['fullName', 'personalNumber']);

  // The signature still has to be provable, so the evidence package retains
  // the identifying fields even for a protected person...
  assert.deepEqual(
    disclose({ level: 'SKYDDAD_FOLKBOKFORING', channel: 'EVIDENCE_PACKAGE', assessment: null }).disclosed,
    ['fullName', 'personalNumber'],
  );
  // ...while a colleague's screen shows nothing.
  assert.deepEqual(disclose({ level: 'SKYDDAD_FOLKBOKFORING', channel: 'SCREEN_COLLEAGUE', assessment: assessment() }).disclosed, []);

  // Fingerade personuppgifter: the old identity must not be resolvable at all,
  // on any channel, with or without an assessment.
  for (const channel of OUTPUT_CHANNELS) {
    assert.deepEqual(
      disclose({ level: 'FINGERADE_PERSONUPPGIFTER', channel, assessment: assessment() }).disclosed,
      [], channel,
    );
  }

  // Existence is itself informative: a redacted row still confirms this person
  // has a case in this municipality, which can be what locates them.
  assert.equal(isSearchable('NONE'), true);
  assert.equal(isSearchable('SEKRETESSMARKERING'), true);
  assert.equal(isSearchable('SKYDDAD_FOLKBOKFORING'), false);
  assert.equal(isSearchable('FINGERADE_PERSONUPPGIFTER'), false);

  // Placeholders are non-identifying and in Swedish.
  assert.equal(redactedPlaceholder('address'), 'Skyddad adress');
  assert.equal(redactedPlaceholder('personalNumber'), 'Skyddad uppgift');
});

test('support access to protected data is granted per person, by the customer, with an expiry', () => {
  const grant = (overrides = {}) => ({
    tenantId: PROT_TENANT, subjectId: PROT_SUBJECT, grantedTo: PROT_ACTOR,
    grantedBy: '00000000-0000-4000-8000-000000000104', grantedByCustomer: true,
    expiresAt: '2026-08-07T18:00:00.000Z', reason: 'Felsökning av signeringsärende KS2026-0001', ...overrides,
  });
  const request = { tenantId: PROT_TENANT, subjectId: PROT_SUBJECT, actorId: PROT_ACTOR, now: PROT_NOW };
  const accessCode = (g) => protCode(() => assertSupportAccess(g, request));

  assert.equal(accessCode(grant()), 'NO_ERROR');

  // Standing access is refused. The alternative makes the protection depend on
  // the supplier's internal discipline rather than a control the customer can
  // see and revoke.
  assert.equal(accessCode(null), 'PROTECTED_ACCESS_NOT_GRANTED');
  assert.equal(accessCode(grant({ grantedByCustomer: false })), 'PROTECTED_ACCESS_NOT_GRANTED');
  assert.equal(accessCode(grant({ reason: '   ' })), 'PROTECTED_ACCESS_NOT_GRANTED');
  assert.equal(accessCode(grant({ expiresAt: '2026-08-07T11:00:00.000Z' })), 'PROTECTED_GRANT_EXPIRED');
  // A grant for one protected person does not open the others, and a grant to
  // one engineer is not a grant to the team.
  assert.equal(accessCode(grant({ subjectId: PROT_ACTOR })), 'PROTECTED_ACCESS_NOT_GRANTED');
  assert.equal(accessCode(grant({ grantedTo: '00000000-0000-4000-8000-000000000105' })), 'PROTECTED_ACCESS_NOT_GRANTED');
  assert.equal(accessCode(grant({ tenantId: PROT_ACTOR })), 'PROTECTED_TENANT_MISMATCH');
});

const WF_TENANT = '00000000-0000-4000-8000-000000000201';
const WF_CASE = '00000000-0000-4000-8000-000000000202';
const S1 = '00000000-0000-4000-8000-000000000211';
const S2 = '00000000-0000-4000-8000-000000000212';
const S3 = '00000000-0000-4000-8000-000000000213';
const WF_NOW = new Date('2026-08-07T12:00:00.000Z');
const order = (mode, steps) => ({ tenantId: WF_TENANT, signatureCaseId: WF_CASE, mode, steps });
const seq = (...statuses) => order('sequential', [S1, S2, S3].map((signerId, index) => ({ signerId, stepNumber: index + 1, status: statuses[index] ?? 'pending' })));
const par = (...statuses) => order('parallel', [S1, S2, S3].map((signerId, index) => ({ signerId, stepNumber: 1, status: statuses[index] ?? 'pending' })));
const wfCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };
const doc = (overrides = {}) => ({
  documentId: '00000000-0000-4000-8000-000000000221', documentVersionId: '00000000-0000-4000-8000-000000000231',
  displayName: 'beslut.pdf', sha256: 'a'.repeat(64), role: 'signable', locked: true, ordinal: 1, ...overrides,
});
const attachment = (overrides = {}) => doc({
  documentId: '00000000-0000-4000-8000-000000000222', documentVersionId: '00000000-0000-4000-8000-000000000232',
  displayName: 'bilaga.pdf', sha256: 'b'.repeat(64), role: 'attachment', ordinal: 2, ...overrides,
});

test('sequential signing enforces turn order and parallel signing does not', () => {
  // A valid invitation link proves who the signer is, not that it is their
  // turn — so the ordering check cannot live in the invitation path.
  assert.equal(wfCode(() => assertSignerMaySign(seq(), S2, true)), 'WORKFLOW_STEP_NOT_REACHED');
  assert.equal(wfCode(() => assertSignerMaySign(seq(), S3, true)), 'WORKFLOW_STEP_NOT_REACHED');
  assert.equal(wfCode(() => assertSignerMaySign(seq(), S1, true)), 'NO_ERROR');
  assert.equal(wfCode(() => assertSignerMaySign(seq('signed'), S2, true)), 'NO_ERROR');
  assert.equal(wfCode(() => assertSignerMaySign(seq('signed'), S3, true)), 'WORKFLOW_STEP_NOT_REACHED');
  assert.equal(wfCode(() => assertSignerMaySign(seq('signed'), S1, true)), 'WORKFLOW_SIGNER_ALREADY_FINISHED');

  // Parallel: order is irrelevant, everyone may act at once.
  for (const signer of [S1, S2, S3]) assert.equal(wfCode(() => assertSignerMaySign(par(), signer, true)), 'NO_ERROR');
  assert.equal(wfCode(() => assertSignerMaySign(par('signed'), S1, true)), 'WORKFLOW_SIGNER_ALREADY_FINISHED');

  assert.equal(wfCode(() => assertSignerMaySign(seq(), '00000000-0000-4000-8000-0000000002ff', true)), 'WORKFLOW_SIGNER_NOT_IN_ORDER');
  assert.equal(wfCode(() => assertSignerMaySign(seq(), S1, false)), 'WORKFLOW_CASE_NOT_ACTIVE');

  assert.deepEqual(signersAwaitingAction(seq()), [S1]);
  assert.deepEqual(signersAwaitingAction(seq('signed')), [S2]);
  assert.deepEqual(signersAwaitingAction(par()).length, 3);
  assert.deepEqual(signersAwaitingAction(seq('signed', 'signed', 'signed')), []);

  // A malformed order has no defined "next", so whichever signer is read first
  // would win. Rejected at construction rather than resolved arbitrarily.
  const dup = order('sequential', [{ signerId: S1, stepNumber: 1, status: 'pending' }, { signerId: S2, stepNumber: 1, status: 'pending' }]);
  assert.equal(wfCode(() => assertOrderIsWellFormed(dup)), 'WORKFLOW_STEP_NUMBERS_INVALID');
  // A gap would let step 3 become reachable as soon as step 1 signs, silently
  // skipping a required approver.
  const gap = order('sequential', [{ signerId: S1, stepNumber: 1, status: 'pending' }, { signerId: S2, stepNumber: 3, status: 'pending' }]);
  assert.equal(wfCode(() => assertOrderIsWellFormed(gap)), 'WORKFLOW_STEP_NUMBERS_INVALID');
  assert.equal(wfCode(() => assertOrderIsWellFormed(order('parallel', []))), 'WORKFLOW_SIGNER_NOT_IN_ORDER');

  // One refusal ends the case: the remaining signatures would not add up to an
  // approved decision, and collecting them yields a case that can never complete.
  assert.equal(caseOutcome(seq()), 'IN_PROGRESS');
  assert.equal(caseOutcome(seq('signed', 'signed', 'signed')), 'COMPLETED');
  assert.equal(caseOutcome(seq('signed', 'declined')), 'DECLINED');
  assert.equal(caseOutcome(par('signed', 'expired')), 'EXPIRED');
});

test('attachments are bound into the signature without being signed themselves', () => {
  const bundle = buildSigningBundle([attachment(), doc()]);
  assert.deepEqual(bundle.signableDocuments.map((d) => d.displayName), ['beslut.pdf']);
  assert.deepEqual(bundle.attachments.map((d) => d.displayName), ['bilaga.pdf']);

  // The signer approved a decision in the light of the appendices, so swapping
  // one afterwards must be detectable. Excluding attachments from the binding
  // material would make them the obvious place to put anything you wanted to
  // change later.
  assert.equal(bundle.bundleSha256Material.length, 2);
  assert.match(bundle.bundleSha256Material[1], /^attachment:/);

  // Multiple signable documents in one go (F010), ordered deterministically.
  const multi = buildSigningBundle([
    doc({ ordinal: 2, displayName: 'b.pdf', documentVersionId: '00000000-0000-4000-8000-000000000234' }),
    doc({ ordinal: 1, displayName: 'a.pdf' }),
    attachment(),
  ]);
  assert.deepEqual(multi.signableDocuments.map((d) => d.displayName), ['a.pdf', 'b.pdf']);

  // A case with only attachments is not a signing case.
  assert.equal(wfCode(() => buildSigningBundle([attachment()])), 'WORKFLOW_NO_SIGNABLE_DOCUMENT');
  // An unlocked document can change between display and signature — for an
  // attachment exactly as much as for the main document.
  assert.equal(wfCode(() => buildSigningBundle([doc(), attachment({ locked: false })])), 'WORKFLOW_DOCUMENT_NOT_LOCKED');

  // An attachment added, removed or swapped after the intent was created.
  assert.equal(wfCode(() => assertBundleUnchanged(bundle.bundleSha256Material, bundle.bundleSha256Material)), 'NO_ERROR');
  assert.equal(wfCode(() => assertBundleUnchanged(bundle.bundleSha256Material, [bundle.bundleSha256Material[0]])), 'WORKFLOW_ATTACHMENT_NOT_BOUND');
  const swapped = buildSigningBundle([doc(), attachment({ sha256: 'c'.repeat(64) })]);
  assert.equal(wfCode(() => assertBundleUnchanged(bundle.bundleSha256Material, swapped.bundleSha256Material)), 'WORKFLOW_ATTACHMENT_NOT_BOUND');
  // Moving a document between roles changes the material, thanks to the tag.
  const rerolled = buildSigningBundle([doc(), attachment({ role: 'signable' })]);
  assert.equal(wfCode(() => assertBundleUnchanged(bundle.bundleSha256Material, rerolled.bundleSha256Material)), 'WORKFLOW_ATTACHMENT_NOT_BOUND');
});

test('reminders go only to signers whose turn it actually is', () => {
  const schedule = (overrides = {}) => ({
    tenantId: WF_TENANT, signatureCaseId: WF_CASE, signerId: S1,
    nextReminderAt: '2026-08-07T09:00:00.000Z', intervalHours: 24, remainingAttempts: 3, ...overrides,
  });
  const expiry = '2026-08-20T00:00:00.000Z';
  const decide = (s, o = seq(), e = expiry) => decideReminder(schedule(s), o, e, WF_NOW);

  assert.equal(decide({}).send, true);
  assert.equal(decide({}).nextReminderAt, '2026-08-08T12:00:00.000Z');

  // The check that matters: a schedule created for every signer up front would
  // nag signer three about a document they cannot open yet, which teaches
  // people to ignore reminders.
  assert.deepEqual(decide({ signerId: S3 }), { send: false, reason: 'SIGNER_NOT_AWAITING_ACTION', nextReminderAt: null });
  // In parallel mode the same signer is awaiting action and does get reminded.
  assert.equal(decide({ signerId: S3 }, par()).send, true);

  assert.equal(decide({ nextReminderAt: '2026-08-08T00:00:00.000Z' }).reason, 'NOT_DUE');
  assert.equal(decide({ remainingAttempts: 0 }).reason, 'NO_ATTEMPTS_LEFT');
  // The final reminder schedules no successor.
  assert.equal(decide({ remainingAttempts: 1 }).nextReminderAt, null);

  // Reminding someone to sign something that can no longer be signed invites a
  // wasted attempt and a confusing error.
  assert.equal(decide({}, seq(), '2026-08-01T00:00:00.000Z').reason, 'CASE_EXPIRED');
  assert.equal(decide({}, seq('signed', 'signed', 'signed')).reason, 'CASE_CLOSED');
  assert.equal(decide({}, seq('declined')).reason, 'CASE_CLOSED');

  // The next slot is computed from now, not from the stored due time: a paused
  // worker must not fire several reminders back to back once it resumes.
  const stale = decideReminder(schedule({ nextReminderAt: '2026-08-01T00:00:00.000Z' }), seq(), expiry, WF_NOW);
  assert.equal(stale.nextReminderAt, '2026-08-08T12:00:00.000Z');

  assert.equal(wfCode(() => decideReminder(schedule({ tenantId: S1 }), seq(), expiry, WF_NOW)), 'WORKFLOW_TENANT_MISMATCH');
});

const keyVersion = (version, state, overrides = {}) => ({
  version, state, secretReference: `vault://kommunsign/data-key-v${version}`,
  createdAt: '2026-08-01T00:00:00.000Z', compromised: false, ...overrides,
});
const ring = (versions, purpose = 'sensitive_data') => ({ purpose, versions });
const rotating = () => ring([keyVersion(1, 'active', { compromised: true }), keyVersion(2, 'pending')]);
const progress = (overrides = {}) => ({
  purpose: 'sensitive_data', state: 'REENCRYPTING', fromVersion: 1, toVersion: 2,
  totalRows: 1000, reencryptedRows: 1000, verifiedRows: 1000, failedRows: 0, ...overrides,
});
const keyCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('key rotation reads under both versions and writes only under the new one', () => {
  // Two active versions mean two writers producing ciphertext under different
  // keys with no record of which is which.
  assert.equal(keyCode(() => assertKeyRingIsSane(ring([keyVersion(1, 'active'), keyVersion(2, 'active')]))), 'KEY_MULTIPLE_ACTIVE_VERSIONS');
  assert.equal(keyCode(() => assertKeyRingIsSane(ring([keyVersion(1, 'decrypt_only')]))), 'KEY_NO_ACTIVE_VERSION');
  // A compromised active key is an urgent state, not an invalid one: rejecting
  // it here would make rotating away from a leaked key impossible, since every
  // operation on the ring would fail before the rotation could start.
  assert.equal(keyCode(() => assertKeyRingIsSane(ring([keyVersion(1, 'active', { compromised: true })]))), 'NO_ERROR');
  assert.equal(rotationRequired(rotating()), true);
  assert.equal(rotationRequired(ring([keyVersion(1, 'active')])), false);

  const dual = beginDualRead(rotating(), 2);
  assert.equal(activeKeyVersion(dual).version, 2);
  assert.equal(dual.versions.find((v) => v.version === 1).state, 'decrypt_only');

  // Read old, write new. Writing under anything but the active version grows
  // the set of rows still needing migration, so the rotation never converges.
  assert.equal(keyCode(() => assertWritableVersion(dual, 2)), 'NO_ERROR');
  assert.equal(keyCode(() => assertWritableVersion(dual, 1)), 'KEY_WRITE_TO_NON_ACTIVE_VERSION');
  assert.equal(keyCode(() => assertReadableVersion(dual, 1)), 'NO_ERROR');
  assert.equal(keyCode(() => assertReadableVersion(dual, 2)), 'NO_ERROR');
  assert.equal(keyCode(() => assertReadableVersion(dual, 9)), 'KEY_VERSION_UNKNOWN');

  // A key must be distributed before anything is written under it, or a node
  // that has not received it writes ciphertext its neighbours cannot read.
  assert.equal(keyCode(() => assertReadableVersion(rotating(), 2)), 'KEY_STATE_INVALID');
  assert.equal(keyCode(() => beginDualRead(dual, 2)), 'KEY_STATE_INVALID');
  assert.equal(
    keyCode(() => beginDualRead(ring([keyVersion(1, 'active'), keyVersion(2, 'pending', { compromised: true })]), 2)),
    'KEY_STATE_INVALID',
  );
});

test('the old key is retired only after counted, verified re-encryption', () => {
  const dual = beginDualRead(rotating(), 2);
  assert.equal(retireOldVersion(dual, progress()).versions.find((v) => v.version === 1).state, 'retired');
  // A retired key that still decrypts is not retired.
  assert.equal(keyCode(() => assertReadableVersion(retireOldVersion(dual, progress()), 1)), 'KEY_VERSION_RETIRED');

  // "It has probably finished by now" is how the last few thousand rows become
  // unreadable, and this mistake has no recovery once the key is destroyed.
  assert.equal(keyCode(() => assertRotationComplete(progress({ reencryptedRows: 999 }))), 'KEY_ROTATION_INCOMPLETE');
  assert.equal(keyCode(() => assertRotationComplete(progress({ failedRows: 1 }))), 'KEY_ROTATION_INCOMPLETE');
  // Re-encrypting and confirming the result are different claims: a writer can
  // report success for a row that does not decrypt under the new key.
  assert.equal(keyCode(() => assertRotationComplete(progress({ verifiedRows: 998 }))), 'KEY_ROTATION_NOT_VERIFIED');

  // Rolling back costs nothing while the old key still decrypts...
  const back = rollbackRotation(ring([keyVersion(1, 'decrypt_only'), keyVersion(2, 'active')]), progress());
  assert.equal(activeKeyVersion(back).version, 1);
  // ...and loses data afterwards, because rows under the new key have no other
  // reader.
  assert.equal(keyCode(() => rollbackRotation(retireOldVersion(dual, progress()), progress())), 'KEY_STATE_INVALID');
  // Rolling back onto the leaked key would undo the only thing the rotation was for.
  assert.equal(
    keyCode(() => rollbackRotation(ring([keyVersion(1, 'decrypt_only', { compromised: true }), keyVersion(2, 'active')]), progress())),
    'KEY_STATE_INVALID',
  );
});

test('a compromised blind index is overwritten rather than kept alongside the new one', () => {
  const entries = [
    { keyVersion: 1, indexValue: 'old-a' },
    { keyVersion: 1, indexValue: 'old-b' },
    { keyVersion: 2, indexValue: 'new-a' },
  ];
  const plan = planBlindIndexRotation(entries, [1], 2);
  // Lookups span every version still present, so a search keeps finding people
  // while the rotation runs.
  assert.deepEqual(plan.lookupVersions, [1, 2]);
  // But the compromised values must be destroyed, not retained for convenience:
  // anyone with the leaked key can compute the index for a person they are
  // looking for and match it.
  assert.deepEqual(plan.mustOverwrite, [1]);

  assert.equal(keyCode(() => assertNoCompromisedIndexRemains(entries, [1])), 'KEY_COMPROMISED_INDEX_RETAINED');
  assert.equal(keyCode(() => assertNoCompromisedIndexRemains(entries.filter((e) => e.keyVersion !== 1), [1])), 'NO_ERROR');
  // The active version is never in the overwrite set, even if it were flagged.
  assert.deepEqual(planBlindIndexRotation(entries, [1, 2], 2).mustOverwrite, [1]);
});

const logContext = (overrides = {}) => ({
  requestId: 'req-1', correlationId: 'corr-1', tenantId: '00000000-0000-4000-8000-000000000301',
  actorId: '00000000-0000-4000-8000-000000000302', ...overrides,
});
const obsCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.message; } };

test('a log record cannot carry a secret or a personal number', () => {
  // A deny-list by name catches the fields we thought of, whatever they hold —
  // by the time a value is in hand, a password looks like any other string.
  for (const field of ['password', 'apiKey', 'API_KEY', 'clientSecret', 'authorization', 'personalNumber', 'qrStartSecret', 'userPassword']) {
    assert.equal(isForbiddenLogField(field), true, field);
  }
  assert.equal(isForbiddenLogField('displayName'), false);
  assert.equal(isForbiddenLogField('caseId'), false);

  // Value patterns catch the fields we did not think of — a personal number
  // pasted into a free-text note is still a personal number.
  const record = buildLogRecord({
    level: 'info', event: 'signing.started', outcome: 'pending', context: logContext(),
    detail: {
      password: 'hunter2',
      note: 'Ringde 19800101-9876 om ärendet',
      header: 'Bearer abcdefghijklmnopqrstuvwx',
      // Assembled at runtime so the repository's own secret scanner does not
      // flag this fixture as a real key — it is right to flag the literal.
      nested: { apiSecret: 'x', deep: { pem: `${'-----BEGIN'} RSA PRIVATE ${'KEY-----'}abc` } },
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl',
      keep: 'Delegationsbeslut KS2026-0001',
    },
  });
  const serialised = JSON.stringify(record);
  assert.doesNotMatch(serialised, /hunter2/);
  assert.doesNotMatch(serialised, /19800101/);
  assert.doesNotMatch(serialised, /abcdefghijklmnopqrstuvwx/);
  assert.doesNotMatch(serialised, new RegExp(`BEGIN RSA PRIVATE ${'KEY'}`));
  assert.doesNotMatch(serialised, /eyJhbGciOiJIUzI1NiJ9/);
  // Redaction is not blanket deletion: the useful part of the record survives.
  assert.match(serialised, /Delegationsbeslut KS2026-0001/);
  assert.equal(record.detail.nested.apiSecret, '[redacted]');

  // A cyclic or pathological structure must not turn a log call into an outage.
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'x' } } } } } } } };
  assert.equal(obsCode(() => sanitiseLogPayload(deep)), 'NO_ERROR');
});

test('security events must be traceable to a tenant and a correlation', () => {
  // An explicit list makes "we log security events" checkable rather than an
  // intention.
  for (const event of ['auth.login.failed', 'authorization.denied', 'user.deactivated', 'retention.executed', 'tenant.access.cross_tenant_attempt']) {
    assert.equal(isSecurityEvent(event), true, event);
  }
  assert.equal(isSecurityEvent('signing.started'), false);

  const record = (overrides = {}) => buildLogRecord({
    level: 'warn', event: 'authorization.denied', outcome: 'failure', context: logContext(overrides),
  });
  assert.equal(obsCode(() => assertSecurityEventIsTraceable(record())), 'NO_ERROR');
  // A security log that cannot answer "who, in which organisation" records that
  // something happened; it is not evidence.
  assert.match(obsCode(() => assertSecurityEventIsTraceable(record({ tenantId: undefined }))), /must carry a tenantId/);
  assert.match(obsCode(() => assertSecurityEventIsTraceable(record({ correlationId: '' }))), /correlation/);
  // A failed login legitimately has no tenant yet — that is the point of it.
  const anonymous = buildLogRecord({ level: 'warn', event: 'auth.login.failed', outcome: 'failure', context: { requestId: 'r', correlationId: 'c' } });
  assert.equal(obsCode(() => assertSecurityEventIsTraceable(anonymous)), 'NO_ERROR');
});

test('metrics measure signing outcomes, not just HTTP responses', () => {
  // The failure uptime monitoring cannot see: the service answers normally and
  // no signature ever completes.
  assert.equal(stuckSigningRatio(100, 100, 0), 0);
  assert.equal(stuckSigningRatio(100, 60, 20), 0.2);
  assert.equal(stuckSigningRatio(0, 0, 0), 0);
  assert.ok(METRICS.includes('signing.started') && METRICS.includes('signing.completed'));
  assert.ok(METRICS.includes('worker.job.age_seconds') && METRICS.includes('webhook.delivery.failures'));

  const sample = (labels) => ({ name: 'signing.completed', value: 1, labels });
  assert.equal(obsCode(() => assertMetricLabelsAreSafe(sample({ tenant: 'kungalv', outcome: 'success' }))), 'NO_ERROR');
  // A high-cardinality label creates one time series per value, which both
  // destroys the metrics backend and turns the pipeline into an unredacted
  // export of personal data.
  assert.match(obsCode(() => assertMetricLabelsAreSafe(sample({ caseId: 'abc' }))), /not allowed/);
  assert.match(obsCode(() => assertMetricLabelsAreSafe(sample({ tenant: '19800101-9876' }))), /personal number/);
});

test('security and cache headers close the leaks a missing header causes', () => {
  const headers = securityHeaders({ enableHsts: true, connectSources: ['https://api.kommunsign.se'] });
  const csp = headers['Content-Security-Policy'];
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  // A signing page inside an iframe is a clickjacking target.
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.kommunsign\.se/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  // An invitation URL carries a token, and a referrer header would hand it to
  // whatever the signer clicks next — so no-referrer, not same-origin.
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Strict-Transport-Security'], /max-age=63072000/);
  // HSTS off outside production, so local development over http still works.
  assert.equal(securityHeaders({ enableHsts: false, connectSources: [] })['Strict-Transport-Security'], undefined);

  // Without Vary, an intermediary can serve one authenticated user's response
  // to the next — a cross-tenant leak caused entirely by a missing header.
  for (const cacheClass of ['PRIVATE_CACHEABLE', 'PRIVATE_NO_STORE', 'SECRET_NEVER_CACHE']) {
    assert.match(cacheHeaders(cacheClass).Vary, /Cookie/, cacheClass);
  }
  assert.match(cacheHeaders('PRIVATE_NO_STORE')['Cache-Control'], /no-store/);
  assert.match(cacheHeaders('SECRET_NEVER_CACHE')['Cache-Control'], /no-store/);
  assert.equal(cacheHeaders('PUBLIC_CACHEABLE').Vary, undefined);

  // The TLS floor is data, not prose, so a deployment check can assert it.
  assert.equal(TLS_POLICY.minimumVersion, 'TLSv1.2');
  // Forward secrecy only: a recorded session must not become readable later if
  // the server key is compromised.
  assert.ok(TLS_POLICY.allowedCipherSuites.every((suite) => /^TLS_|^ECDHE-/.test(suite)));
});

const office = (overrides = {}) => ({
  fileName: 'beslut.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  byteSize: 40_000, ...overrides,
});
const conversion = (overrides = {}) => ({
  sourceSha256: 'a'.repeat(64), convertedSha256: 'b'.repeat(64), convertedPageCount: 3,
  verifiedProfile: 'PDF/A-2b', inspectionAccepted: true, ...overrides,
});
const officeCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

const manifestDocument = (ordinal, suffix) => ({
  ordinal,
  documentVersionId: `00000000-0000-4000-8000-00000000000${ordinal}`,
  documentSha256: String(suffix).repeat(64).slice(0, 64),
  displayName: `document-${ordinal}.pdf`,
  mimeType: 'application/pdf',
  profile: 'PDF/A-2b',
  byteSize: 1024 * ordinal,
});
const manifestInput = (documents) => ({
  tenantId: '11111111-1111-4111-8111-111111111111',
  signatureCaseId: '22222222-2222-4222-8222-222222222222',
  signingIntentId: '33333333-3333-4333-8333-333333333333',
  signerId: '44444444-4444-4444-8444-444444444444',
  documents,
});
const manifestCode = (fn) => { try { fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

test('a signing intent manifest hashes the same however the documents arrive', async () => {
  const ordered = [manifestDocument(1, 'a'), manifestDocument(2, 'b'), manifestDocument(3, 'c')];
  const shuffled = [ordered[2], ordered[0], ordered[1]];

  const first = await signingIntentManifestSha256(buildSigningIntentManifest(manifestInput(ordered)));
  const second = await signingIntentManifestSha256(buildSigningIntentManifest(manifestInput(shuffled)));

  // Retrieval order is an implementation detail of whatever query produced the
  // rows. If it leaked into the hash, the same consent would produce different
  // evidence on different days and the manifest would prove nothing.
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('a signing intent manifest changes when any document in the set changes', async () => {
  const base = [manifestDocument(1, 'a'), manifestDocument(2, 'b')];
  const original = await signingIntentManifestSha256(buildSigningIntentManifest(manifestInput(base)));

  const swappedHash = await signingIntentManifestSha256(buildSigningIntentManifest(manifestInput(
    [base[0], { ...base[1], documentSha256: 'd'.repeat(64) }],
  )));
  assert.notEqual(original, swappedHash);

  const droppedDocument = await signingIntentManifestSha256(buildSigningIntentManifest(manifestInput([base[0]])));
  assert.notEqual(original, droppedDocument);

  const otherSigner = await signingIntentManifestSha256(buildSigningIntentManifest({
    ...manifestInput(base), signerId: '55555555-5555-4555-8555-555555555555',
  }));
  assert.notEqual(original, otherSigner);
});

test('a signing intent manifest refuses a document set it cannot describe honestly', () => {
  assert.equal(manifestCode(() => buildSigningIntentManifest(manifestInput([]))), 'MANIFEST_EMPTY');

  // A gap means a document went missing between reading the intent and building
  // the manifest. Renumbering around it would record a set nobody agreed to.
  assert.equal(
    manifestCode(() => buildSigningIntentManifest(manifestInput([manifestDocument(1, 'a'), manifestDocument(3, 'c')]))),
    'MANIFEST_ORDINALS_NOT_CONTIGUOUS',
  );
  assert.equal(
    manifestCode(() => buildSigningIntentManifest(manifestInput([{ ...manifestDocument(1, 'a'), documentSha256: 'not-a-hash' }]))),
    'MANIFEST_DOCUMENT_HASH_INVALID',
  );
  assert.equal(
    manifestCode(() => buildSigningIntentManifest(manifestInput([{ ...manifestDocument(1, 'a'), byteSize: 0 }]))),
    'MANIFEST_DOCUMENT_SIZE_INVALID',
  );
  const duplicated = manifestDocument(1, 'a');
  assert.equal(
    manifestCode(() => buildSigningIntentManifest(manifestInput([duplicated, { ...duplicated, ordinal: 2 }]))),
    'MANIFEST_DOCUMENT_DUPLICATED',
  );
});

test('the manifest is stored as canonical JSON, so its bytes are reproducible', () => {
  const manifest = buildSigningIntentManifest(manifestInput([manifestDocument(1, 'a'), manifestDocument(2, 'b')]));
  const bytes = signingIntentManifestBytes(manifest);
  const text = new TextDecoder().decode(bytes);
  assert.equal(JSON.parse(text).schema, 'kommunsign.signing-intent-manifest.v1');
  assert.deepEqual(signingIntentManifestBytes(manifest), bytes);
});

test('the signing service client refuses to carry a signing request over an open network', () => {
  // The request body contains the document about to be signed and the identity
  // evidence authorising it. Plain HTTP is tolerated only inside the private
  // network the signing service actually lives on.
  assert.throws(() => new SignServiceClient('http://signservice.example.com', 'token'), /SIGNSERVICE_URL_INVALID/);
  assert.throws(() => new SignServiceClient('https://signservice.example.com', '   '), /SIGNSERVICE_TOKEN_MISSING/);
  assert.ok(new SignServiceClient('http://signservice.railway.internal:8081', 'token'));
  assert.ok(new SignServiceClient('http://127.0.0.1:8081', 'token'));
  assert.ok(new SignServiceClient('https://signservice.example.com', 'token'));
});

test('a signing service that is not configured never resolves into a signature', async () => {
  const notConfigured = new SignServiceClient('http://127.0.0.1:8081', 'token', async () => new Response(
    JSON.stringify({ status: 'NOT_CONFIGURED', reason: 'no backend' }), { status: 503, headers: { 'content-type': 'application/json' } },
  ));
  await assert.rejects(() => notConfigured.sign({}), (error) => error.name === 'SignServiceNotConfiguredError');

  const refused = new SignServiceClient('http://127.0.0.1:8081', 'token', async () => new Response(
    JSON.stringify({ status: 'REFUSED', reason: 'IDENTITY_BINDING_SIGNER_MISMATCH' }), { status: 422, headers: { 'content-type': 'application/json' } },
  ));
  await assert.rejects(() => refused.sign({}), (error) => error.name === 'SignServiceRefusedError' && error.reason === 'IDENTITY_BINDING_SIGNER_MISMATCH');

  // A 200 that is not actually a signed artifact must not be read as one.
  const malformed = new SignServiceClient('http://127.0.0.1:8081', 'token', async () => new Response(
    JSON.stringify({ status: 'SIGNED' }), { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  await assert.rejects(() => malformed.sign({}), /SIGNSERVICE_PROTOCOL_INVALID/);
});

test('a webhook signature covers the event, so a subscriber can tell our POST from anyone else\'s', async () => {
  const secret = 'shared-secret-value';
  const envelope = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'signer.signed',
    occurredAt: '2026-08-18T10:00:00.000Z',
    aggregate: { type: 'signer', id: '22222222-2222-4222-8222-222222222222' },
    payloadSha256: 'a'.repeat(64),
    data: { signatureCaseId: '33333333-3333-4333-8333-333333333333' },
  };
  const signed = await signWebhook(envelope, secret, '1800000000');
  assert.equal(await verifyWebhook(signed, secret, 1800000000), true);

  // Changing the body without re-signing must fail, or the signature says
  // nothing about what was actually delivered.
  const tampered = { ...signed, body: signed.body.replace('signer.signed', 'case.completed') };
  assert.equal(await verifyWebhook(tampered, secret, 1800000000), false);

  // The timestamp is inside the signed material, so replaying an old delivery
  // with a fresh timestamp does not verify.
  assert.equal(await verifyWebhook({ ...signed, timestamp: '1800000060' }, secret, 1800000060), false);

  // And a delivery signed with someone else's secret is not ours.
  assert.equal(await verifyWebhook(signed, 'a-different-secret', 1800000000), false);

  // Freshness is enforced independently of the signature.
  assert.equal(await verifyWebhook(signed, secret, 1800000000 + 3600), false);
});

const fgsAgents = {
  archivist: 'Kungälvs kommunarkiv',
  creator: 'Kungälvs kommun',
  submitter: 'Kungälvs kommun',
  producingSoftware: 'Kommunsign',
  producingSoftwareVersion: '0.2.0',
};
const fgsCase = (overrides = {}) => ({
  tenantId: '11111111-1111-4111-8111-111111111111',
  signatureCaseId: '22222222-2222-4222-8222-222222222222',
  reference: 'KS2026/1005',
  title: 'Beslut om bygglov',
  decisionMode: 'ELECTRONIC_SIGNATURE',
  status: 'archiving',
  createdAt: '2026-08-01T09:00:00.000Z',
  closedAt: '2026-08-05T15:30:00.000Z',
  documents: [{
    documentId: '33333333-3333-4333-8333-333333333333',
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    displayName: 'beslut.pdf',
    sha256: 'a'.repeat(64),
    byteSize: 2048,
    verifiedProfile: 'PDF/A-2b',
    isSignedArtifact: true,
  }],
  signatures: [{
    signerId: '55555555-5555-4555-8555-555555555555',
    signedAt: '2026-08-05T12:00:00.000Z',
    padesLevel: 'PAdES-B',
    signatureArtifactSha256: 'b'.repeat(64),
    validationReportSha256: 'c'.repeat(64),
    timestampTokenSha256: null,
  }],
  identities: [{
    signerId: '55555555-5555-4555-8555-555555555555',
    provider: 'TIC_BANKID',
    assuranceLevel: 'HIGH',
    maskedIdentifier: '19640823-****',
    verifiedAt: '2026-08-05T11:59:00.000Z',
    evidenceSha256: 'd'.repeat(64),
  }],
  auditTrailSha256: 'e'.repeat(64),
  ...overrides,
});
const fgsFiles = () => [
  { path: 'content/beslut.pdf', bytes: new TextEncoder().encode('%PDF-1.7 beslut'), mediaType: 'application/pdf' },
  { path: 'evidence/validation-report.json', bytes: new TextEncoder().encode('{"indication":"TOTAL_PASSED"}'), mediaType: 'application/json' },
];

test('an FGS descriptor is byte-identical when the same closed case is exported twice', async () => {
  const first = await buildFgsPackage(await buildArchivePackage(fgsCase(), fgsFiles()), fgsAgents);
  const second = await buildFgsPackage(await buildArchivePackage(fgsCase(), fgsFiles()), fgsAgents);

  // The archived copy has to be provably the delivered copy. A generated UUID
  // or a wall-clock timestamp anywhere in here would quietly break that.
  assert.equal(first.descriptorSha256, second.descriptorSha256);
  assert.deepEqual(first.descriptor.bytes, second.descriptor.bytes);
  assert.equal(first.specification, FGS_SPECIFICATION);
});

test('the FGS descriptor is METS following the published Riksarkivet profile', async () => {
  const fgs = await buildFgsPackage(await buildArchivePackage(fgsCase(), fgsFiles()), fgsAgents);
  const xml = new TextDecoder().decode(fgs.descriptor.bytes);

  assert.equal(fgs.descriptor.path, 'sip.xml');
  assert.match(xml, /xmlns:mets="http:\/\/www\.loc\.gov\/METS\/"/);
  assert.match(xml, /xmlns:ext="ExtensionMETS"/);
  assert.match(xml, /PROFILE="http:\/\/xml\.ra\.se\/e-arkiv\/METS\/CommonSpecificationSwedenPackageProfile\.xml"/);
  assert.match(xml, /ext:OAISSTATUS="SIP"/);
  assert.match(xml, /<mets:metsDocumentID>sip\.xml<\/mets:metsDocumentID>/);
  assert.match(xml, /CHECKSUMTYPE="SHA-256"/);
  assert.match(xml, /<mets:structMap LABEL="Profilestructmap">/);
  // Every file the manifest describes must be referenced exactly once.
  assert.equal((xml.match(/<mets:file /g) ?? []).length, (xml.match(/<mets:fptr /g) ?? []).length);
  assert.match(xml, /xlink:href="file:\/\/\/content\/beslut\.pdf"/);
});

test('operator text in a case title cannot break out of the FGS descriptor', async () => {
  const hostile = 'Beslut" TYPE="ERMS" x="<script>alert(1)</script>&';
  const fgs = await buildFgsPackage(await buildArchivePackage(fgsCase({ title: hostile }), fgsFiles()), fgsAgents);
  const xml = new TextDecoder().decode(fgs.descriptor.bytes);

  // A raw quote would end the LABEL attribute and let the rest be read as
  // markup by an archive that ingests this file unattended.
  assert.match(xml, /LABEL="Beslut&quot; TYPE=&quot;ERMS&quot; x=&quot;&lt;script&gt;/);
  assert.equal(xml.includes('<script>'), false);
  assert.match(xml, / TYPE="Archival information"/);
  assert.equal((xml.match(/ TYPE="ERMS"/g) ?? []).length, 0);
});

test('the FGS adapter never claims schema conformance it has not verified', async () => {
  // Structure following the published profile and validating against the
  // receiving archive's XSD set are different claims. Conflating them is the
  // exact overclaim this adapter exists to remove.
  assert.equal(FGS_CONFORMANCE_STATUS.structureFollowsProfile, true);
  assert.equal(FGS_CONFORMANCE_STATUS.schemaValidated, false);
  assert.ok(FGS_CONFORMANCE_STATUS.schemaValidationBlocker.length > 0);
});

test('an FGS descriptor refuses to name an agent the profile requires and nobody supplied', async () => {
  // The archive-package refusals (unclosed case, unverified PDF/A profile,
  // missing validation report, missing audit trail) are covered by the archive
  // tests above. What is new here is the profile's own requirement: a METS
  // header without its required agents names no responsible organisation, and a
  // preservation record nobody is accountable for is not a record.
  const archive = await buildArchivePackage(fgsCase(), fgsFiles());
  const code = async (fn) => { try { await fn(); return 'NO_ERROR'; } catch (error) { return error.code; } };

  assert.equal(await code(() => buildFgsPackage(archive, { ...fgsAgents, archivist: '  ' })), 'ARCHIVE_PROFILE_NOT_VERIFIED');
  assert.equal(await code(() => buildFgsPackage(archive, { ...fgsAgents, creator: '' })), 'ARCHIVE_PROFILE_NOT_VERIFIED');
  assert.equal(await code(() => buildFgsPackage(archive, { ...fgsAgents, submitter: '' })), 'ARCHIVE_PROFILE_NOT_VERIFIED');
  assert.equal(await code(() => buildFgsPackage(archive, fgsAgents)), 'NO_ERROR');
});

test('an Office document is converted before signing, and only the PDF/A is signed', () => {
  const plan = planOfficeIngestion(office());
  assert.equal(plan.targetProfile, 'PDF/A-2b');
  assert.equal(plan.requiresConversion, true);
  for (const name of ['a.xlsx', 'a.pptx', 'a.odt', 'a.ods', 'a.rtf']) {
    const mime = {
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.odt': 'application/vnd.oasis.opendocument.text',
      '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
      '.rtf': 'application/rtf',
    }[name.slice(name.lastIndexOf('.'))];
    assert.equal(officeCode(() => planOfficeIngestion(office({ fileName: name, mimeType: mime }))), 'NO_ERROR', name);
  }

  // Macro-enabled formats are the standard delivery vehicle for Office malware,
  // and a file about to be flattened has no legitimate need for a macro.
  for (const name of ['beslut.docm', 'kalkyl.xlsm', 'bild.pptm']) {
    assert.equal(officeCode(() => planOfficeIngestion(office({ fileName: name }))), 'OFFICE_MACRO_FORMAT_REJECTED', name);
  }
  // Extension and MIME must agree: checking one lets a caller present a macro
  // file under a benign type, and the conversion service is what opens it.
  assert.equal(officeCode(() => planOfficeIngestion(office({ mimeType: 'text/plain' }))), 'OFFICE_MIME_MISMATCH');
  assert.equal(officeCode(() => planOfficeIngestion(office({ fileName: 'a.exe' }))), 'OFFICE_FORMAT_NOT_SUPPORTED');
  assert.equal(officeCode(() => planOfficeIngestion(office({ byteSize: 0 }))), 'OFFICE_TOO_LARGE');

  // The signed hash is always the converted file. An Office file is not a fixed
  // representation of itself, so a signature over it would cover bytes whose
  // visual meaning is not stable.
  const ingested = admitConvertedDocument(plan, conversion(), { tenantId: 't', documentId: 'd' });
  assert.equal(ingested.signableSha256, 'b'.repeat(64));
  assert.notEqual(ingested.signableSha256, ingested.sourceSha256);
  assert.equal(ingested.profile, 'PDF/A-2b');

  // A converter reporting PDF/A is describing its intent; only a validator's
  // verdict is evidence.
  const admit = (result) => officeCode(() => admitConvertedDocument(plan, conversion(result), { tenantId: 't', documentId: 'd' }));
  assert.equal(admit({ verifiedProfile: null }), 'OFFICE_CONVERSION_UNVERIFIED');
  assert.equal(admit({ inspectionAccepted: false }), 'OFFICE_CONVERSION_UNVERIFIED');
  // A conversion that produced its own input did not convert.
  assert.equal(admit({ convertedSha256: 'a'.repeat(64) }), 'OFFICE_CONVERSION_UNVERIFIED');
  assert.equal(admit({ convertedPageCount: 0 }), 'OFFICE_CONVERSION_PAGE_MISMATCH');

  // PAdES appends an incremental update; a tool that rewrites the file instead
  // invalidates every signature already on it, which is how a second signer
  // silently destroys the first.
  assert.equal(ADOBE_READER_COMPATIBILITY.incrementalUpdateOnly, true);
  assert.equal(ADOBE_READER_COMPATIBILITY.forbidEncryption, true);
});

test('dates and times render in the Swedish standard regardless of host locale', () => {
  // åååå-mm-dd and tt:mm, not whatever the server's locale happens to be. A
  // server drifting to en-US would render 08/07/2026 — a different date to a
  // Swedish reader, silently.
  assert.equal(formatSwedishDate('2026-08-07T10:30:00.000Z'), '2026-08-07');
  assert.equal(formatSwedishTime('2026-08-07T10:30:00.000Z'), '12:30'); // CEST
  assert.equal(formatSwedishDateTime('2026-01-15T10:30:00.000Z'), '2026-01-15 11:30'); // CET

  // Summer time starts and ends at 01:00 UTC on the last Sunday of March and
  // October. Computed rather than read from tzdata, because a container with
  // stale or stripped tzdata would shift every time by an hour without failing.
  assert.equal(swedishUtcOffsetHours(new Date('2026-03-29T00:59:00Z')), 1);
  assert.equal(swedishUtcOffsetHours(new Date('2026-03-29T01:00:00Z')), 2);
  assert.equal(swedishUtcOffsetHours(new Date('2026-10-25T00:59:00Z')), 2);
  assert.equal(swedishUtcOffsetHours(new Date('2026-10-25T01:00:00Z')), 1);

  // A midnight-crossing conversion must move the date too.
  assert.equal(formatSwedishDateTime('2026-08-07T23:30:00.000Z'), '2026-08-08 01:30');
  // Evidence output states the offset so it stays unambiguous decades later.
  assert.equal(formatSwedishTimestampWithOffset('2026-08-07T10:30:00.000Z'), '2026-08-07 12:30 (UTC+2)');

  // Messages are Swedish, and an unknown code yields a Swedish fallback rather
  // than the raw code — which would be both untranslated and a leak of internal
  // structure.
  assert.match(messageFor('WORKFLOW_STEP_NOT_REACHED'), /inte din tur/);
  assert.match(messageFor('GALLRING_SELF_APPROVAL'), /någon annan än/);
  assert.match(messageFor('PADES_NOT_VALIDATED'), /kunde inte valideras/);
  const unknown = messageFor('SOME_INTERNAL_CODE_42');
  assert.doesNotMatch(unknown, /SOME_INTERNAL_CODE_42/);
  assert.match(unknown, /Något gick fel/);
});

// --- Control-plane platform jobs -------------------------------------------

/**
 * A control database standing in for Postgres.
 *
 * Every statement the handler issues is recorded, and anything the test did not
 * anticipate raises rather than returning an empty result — a silent `{rows:[]}`
 * would let a handler that queried the wrong table still look correct.
 */
function controlDatabaseDouble(responder) {
  const statements = [];
  return {
    statements,
    transaction: async (work) => work({
      query: async (sql, parameters = []) => {
        statements.push({ sql, parameters });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
        if (sql.includes('from control.control_audit_events')) return { rows: [], rowCount: 0 };
        if (sql.includes('insert into control.control_audit_events')) return { rows: [], rowCount: 0 };
        const response = responder(sql, parameters);
        if (response === undefined) throw new Error(`unexpected control query: ${sql}`);
        return response;
      },
    }),
  };
}

const auditEvents = (database) => database.statements
  .filter((entry) => entry.sql.includes('insert into control.control_audit_events'))
  .map((entry) => ({ eventType: entry.parameters[0], payload: entry.parameters[1] }));

const platformJob = (payload) => ({ id: '11111111-1111-4111-8111-111111111111', type: 'X', tenantId: null, payload, attempt: 1, idempotencyKey: 'k' });

test('an unverified application expires rather than being recorded as withdrawn', async () => {
  const database = controlDatabaseDouble((sql) => {
    if (sql.includes('update control.onboarding_applications')) {
      return { rows: [{ id: 'a1', created_at: '2026-01-01T00:00:00.000Z' }], rowCount: 1 };
    }
    return undefined;
  });
  await handleApplicationDeadline(database, platformJob({}));

  const update = database.statements.find((entry) => entry.sql.includes('update control.onboarding_applications'));
  // Withdrawal is an act by the applicant. Writing it for an unattended timeout
  // would put a decision in the record that no human made.
  assert.match(update.sql, /set status='expired'/);
  assert.doesNotMatch(update.sql, /withdrawn/);
  // Only the two pre-submission states. An application under review is someone's
  // active work and must never be closed out from underneath them by a timer.
  assert.match(update.sql, /status in \('draft','email_verification_pending'\)/);
  // The trigger owns status_version and updated_at; setting them in the
  // statement would be silently overwritten and read as if it had taken effect.
  assert.doesNotMatch(update.sql, /status_version/);

  const events = auditEvents(database);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'onboarding.application.expired');
  assert.equal(events[0].payload.applicationId, 'a1');
});

test('readiness is evaluated through the shared model and recorded, never inferred at activation', async () => {
  const checkedAt = '2026-08-01T00:00:00.000Z';
  const database = controlDatabaseDouble((sql) => (
    sql.includes('insert into control.tenant_readiness_results') ? { rows: [], rowCount: 1 } : undefined
  ));
  await handleTenantReadiness(database, platformJob({
    tenantId: '22222222-2222-4222-8222-222222222222',
    environment: 'production',
    checks: [
      { code: 'BANKID_CREDENTIALS', passed: false, severity: 'blocking', checkedAt },
      { code: 'BRANDING', passed: false, severity: 'warning', checkedAt },
      { code: 'DOMAIN_VERIFIED', passed: true, severity: 'blocking', checkedAt },
    ],
  }));

  const insert = database.statements.find((entry) => entry.sql.includes('insert into control.tenant_readiness_results'));
  assert.equal(insert.parameters[3], false, 'one failed blocking check makes the tenant not ready');
  assert.deepEqual(insert.parameters[4].map((check) => check.code), ['BANKID_CREDENTIALS']);
  assert.deepEqual(insert.parameters[5].map((check) => check.code), ['BRANDING']);
  assert.deepEqual(insert.parameters[6].map((check) => check.code), ['DOMAIN_VERIFIED']);

  const [event] = auditEvents(database);
  assert.equal(event.eventType, 'tenant.readiness.evaluated');
  assert.deepEqual(event.payload.blockingCodes, ['BANKID_CREDENTIALS']);
});

test('a malformed readiness check is refused, never dropped', async () => {
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const valid = { code: 'DOMAIN_VERIFIED', passed: true, severity: 'blocking', checkedAt: '2026-08-01T00:00:00.000Z' };
  // Dropping the malformed entry would make the tenant look readier than it is,
  // which is the one direction this must never fail in.
  for (const broken of [
    { ...valid, severity: 'advisory' },
    { ...valid, passed: 'true' },
    { ...valid, checkedAt: 'yesterday' },
    { ...valid, code: '' },
    'DOMAIN_VERIFIED',
  ]) {
    const database = controlDatabaseDouble(() => ({ rows: [], rowCount: 1 }));
    await assert.rejects(
      () => handleTenantReadiness(database, platformJob({ tenantId, environment: 'production', checks: [valid, broken] })),
      /WORKER_PAYLOAD_CHECKS_INVALID/,
    );
    assert.equal(database.statements.length, 0, 'nothing is written when the payload cannot be trusted');
  }

  // An empty check list is not evidence of readiness either.
  const empty = controlDatabaseDouble(() => ({ rows: [], rowCount: 1 }));
  await assert.rejects(
    () => handleTenantReadiness(empty, platformJob({ tenantId, environment: 'production', checks: [] })),
    /WORKER_PAYLOAD_CHECKS_INVALID/,
  );
});

test('activation rests on a recorded production readiness result, not on the absence of a bad one', async () => {
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const activationRequestId = '33333333-3333-4333-8333-333333333333';
  const payload = { tenantId, activationRequestId };

  const scenario = (requestStatus, readinessRows) => controlDatabaseDouble((sql) => {
    if (sql.includes('from control.tenant_activation_requests')) return { rows: [{ status: requestStatus }], rowCount: 1 };
    if (sql.includes('from control.tenant_readiness_results')) return { rows: readinessRows, rowCount: readinessRows.length };
    if (sql.includes('update control.tenant_activation_requests')) return { rows: [], rowCount: 1 };
    if (sql.includes('update control.platform_tenants')) return { rows: [], rowCount: 1 };
    return undefined;
  });

  // No readiness result is not the same as a passing one, and is just as
  // disqualifying: activation must rest on evidence.
  const missing = scenario('approved', []);
  await assert.rejects(() => handleTenantActivation(missing, platformJob(payload)), /NO_PRODUCTION_READINESS_RESULT/);
  assert.ok(!missing.statements.some((entry) => entry.sql.includes('update control.platform_tenants')));
  assert.equal(auditEvents(missing)[0].eventType, 'tenant.activation.refused');

  const blocked = scenario('approved', [{ ready: false, blocking_checks: [{ code: 'BANKID_CREDENTIALS' }] }]);
  await assert.rejects(() => handleTenantActivation(blocked, platformJob(payload)), /READINESS_BLOCKED/);
  assert.ok(!blocked.statements.some((entry) => entry.sql.includes('update control.platform_tenants')));

  // An unapproved request never reaches the readiness check at all: two-person
  // approval is a separate gate, not something readiness can substitute for.
  const unapproved = scenario('pending_approval', [{ ready: true, blocking_checks: [] }]);
  await assert.rejects(() => handleTenantActivation(unapproved, platformJob(payload)), /TENANT_ACTIVATION_NOT_APPROVED/);
  assert.ok(!unapproved.statements.some((entry) => entry.sql.includes('from control.tenant_readiness_results')));

  const ready = scenario('approved', [{ ready: true, blocking_checks: [] }]);
  await handleTenantActivation(ready, platformJob(payload));
  const activation = ready.statements.find((entry) => entry.sql.includes('update control.platform_tenants'));
  assert.match(activation.sql, /status='active'/);
  // Only a tenant that is still coming up may be activated, so this cannot
  // silently un-suspend a tenant that was deliberately stopped.
  assert.match(activation.sql, /status in \('provisioning','onboarding'\)/);
  assert.equal(auditEvents(ready)[0].eventType, 'tenant.activated');

  // Re-running the job after activation is a no-op, not a second activation.
  const again = scenario('activated', [{ ready: true, blocking_checks: [] }]);
  await handleTenantActivation(again, platformJob(payload));
  assert.ok(!again.statements.some((entry) => entry.sql.includes('update control.platform_tenants')));

  // The readiness row is re-read here rather than trusted from the payload, so
  // a payload claiming readiness cannot activate a tenant on its own.
  const lying = scenario('approved', []);
  await assert.rejects(
    () => handleTenantActivation(lying, platformJob({ ...payload, ready: true })),
    /NO_PRODUCTION_READINESS_RESULT/,
  );
});

test('the certificate monitor reports having run, and uses the window the alert watches', async () => {
  const alerts = await readFile('infrastructure/monitoring/prometheus-alerts.yaml', 'utf8');
  const expiry = /kommunsign_certificate_not_after_seconds - time\(\) < (\d+)/.exec(alerts);
  assert.ok(expiry, 'the CertificateExpiringSoon alert must still express a window');

  const flagged = controlDatabaseDouble((sql) => (
    sql.includes('update control.domain_certificate_snapshots')
      ? { rows: [{ id: 'c1', tenant_id: 't1', not_after: '2026-08-20T00:00:00.000Z' }], rowCount: 1 }
      : undefined
  ));
  await handleCertificateMonitor(flagged, platformJob({}));

  const update = flagged.statements.find((entry) => entry.sql.includes('update control.domain_certificate_snapshots'));
  // The job and the alert must agree on what "expiring soon" means. If they
  // drifted, the alert would fire on certificates the system never flagged.
  assert.equal(update.parameters[0] * 24 * 60 * 60, Number(expiry[1]));
  assert.match(update.sql, /set status='renewal_required'/);
  assert.match(update.sql, /status='issued'/, 'a failed or revoked certificate is not a renewal candidate');

  const event = auditEvents(flagged)[0];
  assert.equal(event.eventType, 'certificate.monitor.completed');
  assert.equal(event.payload.flaggedCount, 1);

  // Reported even when nothing was flagged: "no certificates near expiry" and
  // "the monitor did not run" are different statements, and only one of them
  // is reassuring.
  const quiet = controlDatabaseDouble((sql) => (
    sql.includes('update control.domain_certificate_snapshots') ? { rows: [], rowCount: 0 } : undefined
  ));
  await handleCertificateMonitor(quiet, platformJob({}));
  assert.equal(auditEvents(quiet)[0].payload.flaggedCount, 0);
});

test('every control-plane platform job is wired to a handler rather than dead-lettered', async () => {
  const source = await readFile('apps/workers/src/production-handlers.ts', 'utf8');
  assert.match(source, /\.\.\.createPlatformJobHandlers\(/);
  for (const type of ['APPLICATION_DEADLINE', 'TENANT_READINESS', 'TENANT_ACTIVATION', 'CERTIFICATE_MONITOR']) {
    assert.doesNotMatch(source, new RegExp(`${type}: phaseUnsupported`), `${type} still dead-letters`);
  }
  // TENANT_PROVISION is the deliberate exception: postgres-production-adapter
  // overrides it with a handler that needs infrastructure this module lacks.
  const adapter = await readFile('apps/workers/src/postgres-production-adapter.ts', 'utf8');
  assert.match(adapter, /TENANT_PROVISION/);
});

// --- Data subject rights requests -------------------------------------------

/**
 * Drives the privacy handler against doubles for both databases.
 *
 * The doubles answer the specific queries the handler issues and raise on
 * anything else, so a handler that searched the wrong table would fail loudly
 * rather than quietly returning nothing and calling it a clean result.
 */
function privacyDoubles(overrides = {}) {
  const statements = [];
  const deleted = [];
  const dataRow = {
    id: '44444444-4444-4444-8444-444444444444',
    state: 'RECEIVED',
    right_requested: overrides.right ?? 'ACCESS',
    subject_identifier_blind_index: new Uint8Array([1, 2, 3]),
    subject_user_id: '55555555-5555-4555-8555-555555555555',
    received_at: '2026-08-01T00:00:00.000Z',
    identity_verified_at: '2026-08-01T00:05:00.000Z',
    identity_method: 'bankid',
    identity_assurance: overrides.assurance ?? 'HIGH',
    handled_by: '66666666-6666-4666-8666-666666666666',
    ...(overrides.row ?? {}),
  };
  const counts = { control: 1, data: 2, objectKeys: ['tenant/a.xml', 'tenant/b.xml'], audit: 4, holds: 0, restrictions: 0, ...(overrides.counts ?? {}) };

  const run = (sql) => {
    // set_config is the tenant-context preamble withTenantTransaction issues.
    // It is not a business statement, so it is answered but not counted.
    if (sql.includes('set_config')) return { rows: [], rowCount: 1 };
    statements.push(sql);
    if (sql.includes('from app.privacy_requests') && sql.includes('for update')) return { rows: [dataRow], rowCount: 1 };
    if (sql.includes('from control.onboarding_applications')) return { rows: [{ total: String(counts.control) }], rowCount: 1 };
    if (sql.includes('from app.signers where tenant_id=$1')) return { rows: [{ total: String(counts.data) }], rowCount: 1 };
    if (sql.includes('update app.signers')) return { rows: [], rowCount: counts.data };
    if (sql.includes('artifacts.collect_response_object_key')) {
      return { rows: counts.objectKeys.map((object_key) => ({ object_key })), rowCount: counts.objectKeys.length };
    }
    if (sql.includes('from audit.audit_events')) return { rows: [{ total: String(counts.audit) }], rowCount: 1 };
    if (sql.includes('from app.legal_holds')) return { rows: [{ held: String(counts.holds) }], rowCount: 1 };
    if (sql.includes("right_requested='RESTRICTION'")) return { rows: [{ active: String(counts.restrictions) }], rowCount: 1 };
    if (sql.includes('insert into app.privacy_request_coverage')) return { rows: [], rowCount: 1 };
    if (sql.includes('insert into app.privacy_responses')) return { rows: [], rowCount: 1 };
    if (sql.includes('update app.privacy_requests')) return { rows: [], rowCount: 1 };
    if (sql.includes('audit.append_event')) return { rows: [], rowCount: 1 };
    if (sql.includes('insert into app.outbox_events')) return { rows: [], rowCount: 1 };
    return undefined;
  };

  const database = {
    statements,
    transaction: async (work) => work({
      query: async (sql, parameters = []) => {
        const response = run(sql);
        if (response === undefined) throw new Error(`unexpected query: ${sql}`);
        if (sql.includes('insert into app.privacy_request_coverage')) {
          statements.coverage = statements.coverage ?? [];
          statements.coverage.push({
            store: parameters[2], recordCount: parameters[3], searched: parameters[4],
            exemptionReason: parameters[5], actionTaken: parameters[6],
          });
        }
        if (sql.includes('insert into app.privacy_responses')) statements.response = parameters[3];
        return response;
      },
    }),
  };

  const infrastructure = {
    objectStorage: overrides.noDelete ? {} : { deleteObject: async (_context, key) => { deleted.push(key); } },
  };
  return { database, infrastructure, deleted, statements };
}

const privacyExecuteJob = () => ({
  id: '77777777-7777-4777-8777-777777777777', type: 'PRIVACY_REQUEST_EXECUTE',
  tenantId: '88888888-8888-4888-8888-888888888888',
  payload: { privacyRequestId: '44444444-4444-4444-8444-444444444444' },
  idempotencyKey: 'k', attempt: 1,
});

test('every store is accounted for, and one that cannot be searched says so instead of reporting nothing', async () => {
  const { database, infrastructure, statements } = privacyDoubles();
  await handlePrivacyRequestExecute(database, database, infrastructure, privacyExecuteJob());

  const coverage = statements.coverage ?? [];
  assert.deepEqual(
    coverage.map((entry) => entry.store).sort(),
    ['AUDIT_LOG', 'BACKUP', 'CONTROL', 'DATA', 'OBJECT_STORAGE'],
    'a register extract that quietly omits a store is worse than no extract, because it looks complete',
  );

  // The claim that matters. A handler returning "searched, zero records"
  // without querying satisfies every type in the system and is a lie.
  const backup = coverage.find((entry) => entry.store === 'BACKUP');
  assert.equal(backup.searched, false, 'a backup set cannot be point-searched online');
  assert.ok(backup.exemptionReason && backup.exemptionReason.trim().length > 0, 'and an unsearched store must state why');
  assert.equal(backup.recordCount, 0);
  assert.equal(backup.actionTaken, 'EXEMPTED');

  // The searched stores report what the queries actually returned, not a
  // constant. Change the underlying counts and the answer changes with them.
  assert.equal(coverage.find((entry) => entry.store === 'CONTROL').recordCount, 1);
  assert.equal(coverage.find((entry) => entry.store === 'DATA').recordCount, 2);
  assert.equal(coverage.find((entry) => entry.store === 'OBJECT_STORAGE').recordCount, 2);
  assert.equal(coverage.find((entry) => entry.store === 'AUDIT_LOG').recordCount, 4);

  const response = statements.response;
  assert.equal(response.totalRecords, 1 + 2 + 2 + 4, 'the total is the sum of what was found, not a guess');
  assert.equal(response.complete, true);
  assert.deepEqual(response.exemptedStores, ['BACKUP']);
});

test('an erasure destroys object payloads and clears identifiers, but never the audit chain', async () => {
  const { database, infrastructure, deleted, statements } = privacyDoubles({ right: 'ERASURE' });
  await handlePrivacyRequestExecute(database, database, infrastructure, privacyExecuteJob());

  assert.deepEqual(deleted, ['tenant/a.xml', 'tenant/b.xml'], 'the evidence payloads are actually destroyed');
  assert.ok(
    database.statements.some((sql) => sql.includes('update app.signers') && sql.includes('verified_identifier_blind_index=null')),
    'and the identifiers on the rows that stay are cleared',
  );
  // The signer row itself survives: signature evidence has to remain
  // verifiable, and dropping the row would break the chain proving who signed.
  assert.ok(!database.statements.some((sql) => sql.includes('delete from app.signers')));

  const coverage = statements.coverage ?? [];
  const auditLog = coverage.find((entry) => entry.store === 'AUDIT_LOG');
  assert.equal(auditLog.searched, true, 'the log is searched, and reported');
  assert.equal(auditLog.actionTaken, 'EXEMPTED', 'but never deleted -- the chain is what makes every other record verifiable');
  assert.match(auditLog.exemptionReason, /PUB-avtalet 7\.5/);
  assert.equal(coverage.find((entry) => entry.store === 'OBJECT_STORAGE').actionTaken, 'CRYPTO_ERASED');
});

test('an erasure with no way to delete objects reports the store as unaddressed, not as empty', async () => {
  const { database, infrastructure, statements } = privacyDoubles({ right: 'ERASURE', noDelete: true });
  await handlePrivacyRequestExecute(database, database, infrastructure, privacyExecuteJob());

  const objectStorage = (statements.coverage ?? []).find((entry) => entry.store === 'OBJECT_STORAGE');
  // Reporting zero here would be the comfortable lie: the answer would look
  // complete while two files still held the person's evidence.
  assert.equal(objectStorage.searched, false);
  assert.ok(objectStorage.exemptionReason.length > 0);
  assert.equal(objectStorage.actionTaken, 'EXEMPTED');
});

test('an erasure stops at a legal hold and is refused with the ground, not silently skipped', async () => {
  const { database, infrastructure, deleted } = privacyDoubles({ right: 'ERASURE', counts: { holds: 1 } });
  await handlePrivacyRequestExecute(database, database, infrastructure, privacyExecuteJob());

  const refusal = database.statements.find((sql) => sql.includes("state='REFUSED'"));
  assert.ok(refusal, 'a request that cannot be carried out is refused, not left open');
  assert.ok(!database.statements.some((sql) => sql.includes('insert into app.privacy_responses')), 'and no answer is issued');
  assert.deepEqual(deleted, [], 'nothing under hold was destroyed');
});

test('an unproven identity refuses the request rather than disclosing anything', async () => {
  for (const row of [
    { identity_verified_at: null },
    { identity_method: null },
    { identity_assurance: null },
  ]) {
    const { database, infrastructure, deleted } = privacyDoubles({ row });
    await handlePrivacyRequestExecute(database, database, infrastructure, privacyExecuteJob());
    assert.ok(database.statements.some((sql) => sql.includes("state='REFUSED'")));
    assert.ok(!database.statements.some((sql) => sql.includes('from control.onboarding_applications')),
      'nothing is even searched before identity is proven');
    assert.deepEqual(deleted, []);
  }

  // A verified identity that is not strong enough for the right being
  // exercised is refused for the same reason: an address someone happens to
  // control is not proof for a register extract.
  const weak = privacyDoubles({ assurance: 'SUBSTANTIAL' });
  await handlePrivacyRequestExecute(weak.database, weak.database, weak.infrastructure, privacyExecuteJob());
  assert.ok(weak.database.statements.some((sql) => sql.includes("state='REFUSED'")));
});

test('a delivered or refused request is not re-run', async () => {
  for (const state of ['DELIVERED', 'REFUSED']) {
    const { database, infrastructure, deleted } = privacyDoubles({ right: 'ERASURE', row: { state } });
    await handlePrivacyRequestExecute(database, database, infrastructure, privacyExecuteJob());
    assert.deepEqual(deleted, [], 're-running must not re-delete');
    assert.equal(database.statements.length, 1, 'and must not re-disclose');
  }
});

test('the rights-request routes are wired and split the handling grant from the erasing one', async () => {
  const router = await readFile('apps/api/src/router.ts', 'utf8');
  assert.match(router, /'\/v1\/privacy\/requests'/);
  assert.match(router, /privacy\\\/requests\\\/\(\[\^\/\]\+\)\\\/execute/);
  // Recording that someone asked and destroying the record behind it are
  // different acts, and must not share a grant.
  assert.match(router, /authorize\(dependencies, context, 'privacy:execute'\)/);
  assert.match(router, /authorize\(dependencies, context, 'privacy:manage'\)/);

  assert.equal(hasPermission(['tenant_admin'], 'privacy:execute'), true);
  assert.equal(hasPermission(['tenant_security_admin'], 'privacy:manage'), true);
  for (const role of ['document_creator', 'document_sender', 'approver', 'readonly', 'auditor']) {
    assert.equal(hasPermission([role], 'privacy:execute'), false, `${role} must not be able to erase personal data`);
    assert.equal(hasPermission([role], 'privacy:manage'), false);
  }
});

// --- SCIM 2.0 provisioning surface ------------------------------------------

const SCIM_HTTP_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SCIM_HTTP_TENANT = '99999999-1111-4999-8999-999999999999';

/**
 * A SCIM repository double that behaves like the real one on the points the
 * router depends on: the tenant comes from the credential, and nothing else.
 */
function scimRepositoryDouble(overrides = {}) {
  const saved = [];
  const users = overrides.users ?? [];
  return {
    saved,
    async authenticate(tokenHash) {
      // A wrong token is a miss, exactly as the real lookup would be.
      const expected = await sha256Hex(new TextEncoder().encode(SCIM_HTTP_TOKEN));
      const presented = [...tokenHash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (presented !== expected) return null;
      return {
        tenantId: SCIM_HTTP_TENANT,
        clientId: '99999999-2222-4999-8999-999999999999',
        assignableRoles: overrides.assignableRoles ?? ['readonly', 'document_creator'],
        groupToRole: overrides.groupToRole ?? { 'CN=Kommunsign-Lasare': 'readonly' },
      };
    },
    async listUsers() { return users; },
    async getUser(_context, id) { return users.find((user) => user.id === id) ?? null; },
    async createUser(_context, user) { saved.push({ action: 'CREATED', user }); return user; },
    async saveUser(_context, user, action) { saved.push({ action, user }); return user; },
    async hasHistory() { return overrides.hasHistory ?? false; },
    async listGroups() { return [{ displayName: 'CN=Kommunsign-Lasare', role: 'readonly' }]; },
    async issueClient() { throw new Error('not used here'); },
  };
}

const scimHttpUser = (overrides = {}) => ({
  id: '99999999-3333-4999-8999-999999999999',
  tenantId: SCIM_HTTP_TENANT,
  externalId: 'dir-0001',
  userName: 'anna@kungalv.se',
  displayName: 'Anna Andersson',
  email: 'anna@kungalv.se',
  active: true,
  roles: [],
  groups: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const scimRequest = (path, init = {}) => new Request(`https://api.kommunsign.se${path}`, {
  headers: { authorization: `Bearer ${SCIM_HTTP_TOKEN}`, 'content-type': 'application/scim+json', ...(init.headers ?? {}) },
  ...init,
});

test('SCIM authenticates on its own credential and says nothing about which tokens exist', async () => {
  const scim = scimRepositoryDouble();

  // A missing, malformed and simply wrong token are all the same failure, so
  // probing tells an attacker nothing.
  for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ' + 'b'.repeat(42) }]) {
    const response = await handleScimRequest({ scim }, new Request('https://api.kommunsign.se/scim/v2/Users', { headers }), 'r1');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="scim"');
    const body = await response.json();
    assert.deepEqual(body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
    assert.doesNotMatch(JSON.stringify(body), /tenant|client/i, 'a 401 must not describe what would have been reached');
  }

  // A path outside SCIM is not this router's business at all.
  assert.equal(await handleScimRequest({ scim }, new Request('https://api.kommunsign.se/v1/signature-cases'), 'r2'), null);
});

test('SCIM errors come back in the SCIM error schema, not this API’s', async () => {
  const scim = scimRepositoryDouble();
  const response = await handleScimRequest({ scim }, scimRequest('/scim/v2/Users?filter=' + encodeURIComponent('displayName co "a"')), 'r3');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'application/scim+json; charset=utf-8');
  const body = await response.json();
  // A provisioning client parses one shape. Giving it another turns a
  // meaningful 400 into an unclassifiable failure that stalls the sync.
  assert.deepEqual(body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
  assert.equal(body.scimType, 'invalidFilter');
  assert.equal(body.status, '400');
});

test('provisioning is idempotent on externalId, so a re-sync is a no-op rather than a conflict', async () => {
  const existing = scimHttpUser();
  const scim = scimRepositoryDouble({ users: [existing] });
  const response = await handleScimRequest({ scim }, scimRequest('/scim/v2/Users', {
    method: 'POST',
    body: JSON.stringify({ userName: 'anna@kungalv.se', externalId: 'dir-0001' }),
  }), 'r4');

  assert.equal(response.status, 200, 'an IdP retry must not 409 and stall the sync');
  assert.equal(scim.saved.length, 0, 'and must not create a duplicate account');
  assert.equal((await response.json()).id, existing.id);
});

test('a directory group grants only what the credential was scoped for', async () => {
  // The mapping points at a role outside assignableRoles. A directory admin
  // adding someone to that group must not thereby become able to grant it.
  const scim = scimRepositoryDouble({
    assignableRoles: ['readonly'],
    groupToRole: { 'CN=Kommunsign-Admin': 'tenant_admin' },
  });
  const response = await handleScimRequest({ scim }, scimRequest('/scim/v2/Users', {
    method: 'POST',
    body: JSON.stringify({ userName: 'ny@kungalv.se', externalId: 'dir-0002', groups: [{ display: 'CN=Kommunsign-Admin' }] }),
  }), 'r5');

  assert.equal(response.status, 400);
  assert.equal((await response.json()).scimType, undefined, 'role scope is not one of the RFC scimType values');
  assert.equal(scim.saved.length, 0, 'nothing is written when the grant would exceed the scope');

  // An unmapped group grants nothing at all, rather than a default role.
  const scoped = scimRepositoryDouble({ assignableRoles: ['readonly'], groupToRole: { 'CN=Kommunsign-Lasare': 'readonly' } });
  const created = await handleScimRequest({ scim: scoped }, scimRequest('/scim/v2/Users', {
    method: 'POST',
    body: JSON.stringify({ userName: 'ny@kungalv.se', groups: [{ display: 'CN=Nagot-Annat' }, { display: 'CN=Kommunsign-Lasare' }] }),
  }), 'r6');
  assert.equal(created.status, 201);
  assert.deepEqual(scoped.saved[0].user.roles, ['readonly']);
});

test('deactivation arrives as a patch, keeps the row, and stops the grants', async () => {
  const scim = scimRepositoryDouble({ users: [scimHttpUser({ roles: ['readonly'] })] });
  const response = await handleScimRequest({ scim }, scimRequest('/scim/v2/Users/99999999-3333-4999-8999-999999999999', {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }),
  }), 'r7');

  assert.equal(response.status, 200);
  assert.equal(scim.saved[0].action, 'DEACTIVATED');
  assert.equal(scim.saved[0].user.active, false);
  // The user's history — which documents they signed, which cases they handled
  // — has to survive deprovisioning, or the trail develops holes exactly where
  // a leaver is involved.
  assert.equal((await response.json()).id, '99999999-3333-4999-8999-999999999999');
});

test('DELETE deactivates a user with history and strips their roles either way', async () => {
  for (const hasHistory of [true, false]) {
    const scim = scimRepositoryDouble({ users: [scimHttpUser({ roles: ['readonly'] })], hasHistory });
    const response = await handleScimRequest({ scim }, scimRequest('/scim/v2/Users/99999999-3333-4999-8999-999999999999', { method: 'DELETE' }), 'r8');
    assert.equal(response.status, 204);
    assert.equal(scim.saved[0].action, hasHistory ? 'DEACTIVATED' : 'DELETED');
    assert.equal(scim.saved[0].user.active, false);
    // A deprovisioned account stops granting immediately, whichever branch ran.
    assert.deepEqual(scim.saved[0].user.roles, []);
  }
});

test('SCIM pagination is 1-based, which is the bug that shows up months later', async () => {
  const users = Array.from({ length: 5 }, (_value, index) => scimHttpUser({
    id: `99999999-3333-4999-8999-00000000000${index}`, userName: `user${index}@kungalv.se`, externalId: `dir-${index}`,
  }));
  const scim = scimRepositoryDouble({ users });

  const first = await (await handleScimRequest({ scim }, scimRequest('/scim/v2/Users?startIndex=1&count=2'), 'r9')).json();
  assert.equal(first.startIndex, 1);
  assert.equal(first.totalResults, 5);
  assert.deepEqual(first.Resources.map((entry) => entry.userName), ['user0@kungalv.se', 'user1@kungalv.se']);

  // Treating startIndex as 0-based skips or repeats a user on every boundary,
  // and surfaces as "some staff were never provisioned".
  const second = await (await handleScimRequest({ scim }, scimRequest('/scim/v2/Users?startIndex=3&count=2'), 'r10')).json();
  assert.deepEqual(second.Resources.map((entry) => entry.userName), ['user2@kungalv.se', 'user3@kungalv.se']);

  const invalid = await handleScimRequest({ scim }, scimRequest('/scim/v2/Users?startIndex=0'), 'r11');
  assert.equal(invalid.status, 400, 'a broken client is visible immediately rather than syncing the wrong window');
});

test('the SCIM surface is reached before the session resolver and never takes a tenant from a request', async () => {
  const router = await readFile('apps/api/src/router.ts', 'utf8');
  const scimIndex = router.indexOf('handleScimRequest(dependencies');
  const contextIndex = router.indexOf('await dependencies.resolveContext(request)');
  assert.ok(scimIndex > 0 && contextIndex > 0);
  // A directory pushing users has no session. Running SCIM through the session
  // resolver would need a bypass that some later route inherits.
  assert.ok(scimIndex < contextIndex, 'SCIM must be handled before the session resolver');

  const scimRouter = await readFile('apps/api/src/scim-router.ts', 'utf8');
  // The tenant comes from the credential row. Reading it from a path, body or
  // header would hand out a cross-tenant write primitive with every token.
  assert.match(scimRouter, /tenantId: credential\.tenantId/);
  assert.doesNotMatch(scimRouter, /tenantId:\s*(?:body|url|request|write)\./);
});

test('replay protection is only real if it survives a restart', async () => {
  const federation = await readFile('apps/api/src/production-adapters/postgres/federation-repository.ts', 'utf8');

  // The single-use guarantee is the primary key, not a read followed by a
  // write. A check-then-insert has a race, and a race in replay protection is
  // what a replay attack looks like when it is done properly.
  assert.match(federation, /on conflict \(tenant_id,assertion_id\) do nothing/);
  assert.match(federation, /rowCount === 1/);
  assert.doesNotMatch(federation, /select .* from control\.federation_assertion_ledger[\s\S]{0,200}insert into/);

  // The tenant is bound per call. Two ACS requests for different tenants are
  // served concurrently by one process, and shared mutable tenant state would
  // let one consume the other's assertion ID.
  assert.match(federation, /ledgerFor\(tenantId\)/);
  assert.doesNotMatch(federation, /let boundTenant/);

  // Pruning is strictly past the window: removing an entry whose assertion is
  // still valid would reopen the replay it exists to close.
  assert.match(federation, /not_on_or_after < \$1/);

  // No vendor is named in the federation *code*. Connecting a different IdP is
  // a configuration row, which is the whole point of the generic provider
  // keys. Comments may discuss a vendor -- explaining why it is not hardcoded
  // is the opposite of hardcoding it -- so they are stripped before the check.
  const library = await readFile('packages/federation/src/index.ts', 'utf8');
  const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const source of [federation, library]) {
    assert.doesNotMatch(withoutComments(source), /MobilityGuard|Entra|Okta|PingFederate/i);
  }

  // And the in-memory ledger is documented as what it is, so nobody reaches
  // for it in production by accident.
  assert.match(library, /export class InMemoryAssertionLedger/);
  assert.match(library, /loses every consumed ID on restart/);
});

// --- Prometheus exposition ---------------------------------------------------

test('every alert rule watches a series this system actually emits', async () => {
  const rules = await readFile('infrastructure/monitoring/prometheus-alerts.yaml', 'utf8');
  const referenced = new Set([...rules.matchAll(/kommunsign_[a-z0-9_]+/g)].map((match) => match[0]));
  assert.ok(referenced.size >= 5, 'the alert rules must still reference metrics');

  const declared = new Set([...PROMETHEUS_COUNTERS, ...PROMETHEUS_GAUGES]);
  for (const series of referenced) {
    // An alert watching a series nobody produces is worse than no alert,
    // because a silent alert reads as "nothing is wrong". Every one of the five
    // rules was in exactly that state before this endpoint existed.
    assert.ok(declared.has(series), `${series} is alerted on but not even declared`);
  }

  // Declared is not the same as fed. The exporter is checked against what the
  // repository actually queries, so a name added to the catalogue without a
  // query behind it does not quietly satisfy the check above.
  const repository = await readFile('apps/api/src/production-adapters/postgres/metrics-repository.ts', 'utf8');
  const unfed = new Set(PROMETHEUS_UNFED_SERIES);
  for (const series of [...PROMETHEUS_COUNTERS, ...PROMETHEUS_GAUGES]) {
    const fed = repository.includes(`'${series}'`);
    if (fed) {
      assert.ok(!unfed.has(series), `${series} is fed but still listed as unfed`);
      continue;
    }
    // A series may be declared and unfed, but only if it says so out loud —
    // and then the requirement matrix has to carry the same admission.
    assert.ok(unfed.has(series), `${series} is declared but nothing produces it, and it is not listed as unfed`);
  }

  const blockers = await readFile('docs/compliance/kungalv/EXTERNAL_EVIDENCE_BLOCKERS.md', 'utf8');
  for (const series of PROMETHEUS_UNFED_SERIES) {
    assert.match(blockers, /[Bb]ackup/, `${series} is unfed, so the gap must be recorded as an external blocker`);
  }
});

test('the exposition escapes label values and omits what it could not compute', () => {
  const rendered = renderPrometheus(
    [{ name: 'kommunsign_signature_attempts_total', value: 3, labels: { outcome: 'failed' } }],
    [
      { name: 'kommunsign_webhook_queue_oldest_age_seconds', value: 42 },
      // A metric that could not be computed is omitted. Emitting NaN fails the
      // whole scrape, taking every other series down with it.
      { name: 'kommunsign_worker_queue_depth', value: Number.NaN, labels: { queue: 'EMAIL_SEND' } },
      { name: 'kommunsign_cases_awaiting_completion', value: Number.POSITIVE_INFINITY },
    ],
  );

  assert.match(rendered, /# TYPE kommunsign_signature_attempts_total counter/);
  assert.match(rendered, /# TYPE kommunsign_webhook_queue_oldest_age_seconds gauge/);
  assert.match(rendered, /kommunsign_signature_attempts_total\{outcome="failed"\} 3/);
  assert.doesNotMatch(rendered, /NaN|Inf/);

  // HELP and TYPE appear once per family. Repeating them per series makes
  // Prometheus reject the whole scrape rather than skip the duplicate.
  assert.equal(rendered.match(/# TYPE kommunsign_signature_attempts_total/g).length, 1);

  // A quote in a label value would otherwise end the label early and the rest
  // would parse as further labels — a scrape reporting the wrong series.
  const escaped = renderPrometheus([], [{ name: 'kommunsign_worker_queue_depth', value: 1, labels: { queue: 'a"b\nc' } }]);
  assert.match(escaped, /queue="a\\"b\\nc"/);

  // Two renders of the same input are byte-identical, so a diff between
  // scrapes is about the values rather than about map ordering.
  const input = [{ name: 'kommunsign_worker_queue_depth', value: 2, labels: { queue: 'b' } }, { name: 'kommunsign_worker_queue_depth', value: 1, labels: { queue: 'a' } }];
  assert.equal(renderPrometheus([], input), renderPrometheus([], [...input].reverse()));
});

test('a metric label can never carry a case id or a personal number', () => {
  // The allow-list is the real control: a high-cardinality label both destroys
  // the metrics backend and quietly turns the scrape into an unredacted export.
  assert.throws(
    () => renderPrometheus([], [{ name: 'kommunsign_worker_queue_depth', value: 1, labels: { caseId: 'abc' } }]),
    /not allowed/,
  );
  assert.throws(
    () => renderPrometheus([], [{ name: 'kommunsign_worker_queue_depth', value: 1, labels: { tenant: '19850101-1234' } }]),
    /personal number/,
  );
});

test('the scrape endpoint is absent by default and refuses a wrong credential', async () => {
  const router = await readFile('apps/api/src/router.ts', 'utf8');
  // Absent rather than open when unconfigured: an accidentally public /metrics
  // leaks cross-tenant operational state, and nothing looks wrong while it does.
  assert.match(router, /if \(!dependencies\.metrics\) return null;/);
  // Compared over digests, so a wrong token cannot be told from a nearly-right
  // one by how long the rejection took.
  assert.match(router, /sha256Hex\(new TextEncoder\(\)\.encode\(presented\)\)/);
  assert.match(router, /presentedDigest !== expectedDigest/);
  assert.match(router, /text\/plain; version=0\.0\.4/);

  const wiring = await readFile('apps/api/src/production-adapters/postgres/index.ts', 'utf8');
  assert.match(wiring, /scrapeToken\.length < 32/, 'a short or empty token must not enable the endpoint');

  // Everything is read from the databases at scrape time. A process-local
  // counter restarts at zero on deploy, which increase() reads as a reset.
  const repository = await readFile('apps/api/src/production-adapters/postgres/metrics-repository.ts', 'utf8');
  assert.doesNotMatch(repository, /new Map\(\)[\s\S]{0,80}\+= 1|let total = 0/);
  assert.match(repository, /from app\.signature_attempts/);
  assert.match(repository, /tenant\.access\.cross_tenant_attempt/);
});

// --- Delivering the finished document ---------------------------------------

test('a download link is coarsened before it is recorded, and reveals nothing when it fails', async () => {
  const { truncateClientAddress, userAgentFamily } = await import('../dist/apps/api/src/production-adapters/postgres/delivery-repository.js');

  // A full client address is personal data retained for a purpose nobody
  // stated. A /24 still answers the only question the trail has to answer:
  // "same office twice" versus "this link is being passed around".
  assert.equal(truncateClientAddress('192.0.2.147'), '192.0.2.0/24');
  assert.equal(truncateClientAddress('2001:db8:1234:5678::1'), '2001:db8:1234::/48');
  assert.equal(truncateClientAddress(''), undefined);
  assert.equal(truncateClientAddress('not-an-address'), undefined);

  // A full user agent is a fingerprint; a family is not.
  assert.equal(userAgentFamily('Mozilla/5.0 (X11) Firefox/128.0'), 'firefox');
  assert.equal(userAgentFamily('Mozilla/5.0 Chrome/126 Safari/537'), 'chrome');
  assert.equal(userAgentFamily(null), undefined);

  const repository = await readFile('apps/api/src/production-adapters/postgres/delivery-repository.ts', 'utf8');
  // Redemption is one conditional UPDATE, not read-then-write: two concurrent
  // fetches must not both see the last remaining use and both take it.
  assert.match(repository, /update app\.document_download_grants[\s\S]{0,400}use_count < maximum_uses/);
  assert.doesNotMatch(repository, /select[\s\S]{0,200}from app\.document_download_grants[\s\S]{0,200}update app\.document_download_grants/);
  // The token is stored only as a hash, so a leaked database is not a set of
  // working download links.
  assert.match(repository, /token_hash/);
  assert.doesNotMatch(repository, /token text|token: token,\s*\n\s*tokenHash/);

  const router = await readFile('apps/api/src/router.ts', 'utf8');
  // Unknown, expired, revoked and spent are one answer. Distinguishing them
  // would tell a probing caller which links once existed.
  assert.match(router, /DOWNLOAD_LINK_INVALID/);
  assert.match(router, /if \(!redeemed\) throw new ApiRequestError\('DOWNLOAD_LINK_INVALID'/);
  // Issuing a shareable link is a disclosure, so it needs the download grant.
  assert.match(router, /download-links[\s\S]{0,300}authorize\(dependencies, context, 'document:download'\)/);
});

test('a case cannot be created already completed', async () => {
  const migration = await readFile('migrations/data/0028_completion_guards_cover_insert.sql', 'utf8');
  // Every completion guard was BEFORE UPDATE OF status. Verified against a live
  // database: a case with no signers, no evidence package and no signature
  // chain inserted cleanly as completed. Migration 0021 exists to make that
  // impossible, and the promise had an INSERT-shaped hole in it.
  assert.match(migration, /BEFORE INSERT ON app\.signature_cases/);
  assert.match(migration, /BEFORE INSERT ON app\.signers/);
  assert.match(migration, /BEFORE INSERT ON app\.document_versions/);
  assert.match(migration, /case cannot be created already completed/);

  const suite = await readFile('tests/sql/document-delivery.sql', 'utf8');
  assert.match(suite, /a case was created already completed/, 'the guard needs a live-database check, not only a migration');
});

// --- Federated login over the wire ------------------------------------------

const FED_ROUTE_TENANT = '21212121-2121-4121-8121-212121212121';
const FED_REQUEST_ID = '_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function federationDoubles(overrides = {}) {
  const started = [];
  const consumed = [];
  const config = {
    tenantId: FED_ROUTE_TENANT, protocol: 'SAML2', enabled: true,
    issuer: 'https://idp.kungalv.se/saml',
    audience: 'https://kungalv.kommunsign.se/sp',
    destination: 'https://kungalv.kommunsign.se/auth/federation/GENERIC_SAML/acs',
    signingCertificateSecretReference: 'vault://idp-cert',
    requiredAuthnContexts: [], maximumAuthenticationAgeSeconds: 3600,
    subjectAttribute: 'uid', groupsAttribute: 'memberOf',
    groupToRole: { 'CN=Kommunsign-Handlaggare': 'document_creator' },
    assignableRoles: ['document_creator'],
    ...(overrides.config ?? {}),
  };
  const seen = new Set();
  const federation = {
    async configFor() { return overrides.noConfig ? null : config; },
    async startLogin(input) { started.push(input); },
    async consumeLogin(requestId) {
      consumed.push(requestId);
      if (overrides.loginMissing) return null;
      // Single use, exactly as the conditional update in the repository is.
      if (seen.has(requestId)) return null;
      seen.add(requestId);
      return {
        tenantId: FED_ROUTE_TENANT, requestId, providerKey: 'GENERIC_SAML',
        environment: 'production', redirectUri: config.destination, returnPath: '/arenden',
      };
    },
    ledgerFor() { return { async consume() { return true; } }; },
    async pruneLedger() { return 0; },
    async pruneLoginRequests() { return 0; },
  };
  const now = new Date();
  const report = {
    result: 'PASS', signatureVerified: true,
    assertionId: '_assertion-1', issuer: config.issuer, audience: config.audience,
    destination: config.destination, inResponseTo: FED_REQUEST_ID,
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    notOnOrAfter: new Date(now.getTime() + 300_000).toISOString(),
    authenticatedAt: new Date(now.getTime() - 30_000).toISOString(),
    authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor',
    subject: 'anna.andersson',
    attributes: { uid: ['anna.andersson'], memberOf: ['CN=Kommunsign-Handlaggare'] },
    ...(overrides.report ?? {}),
  };
  return {
    started, consumed, config,
    dependencies: {
      federation,
      federationValidation: { async validateSaml() { return report; }, async validateOidc() { return report; } },
      federationTrust: overrides.noTrust ? async () => null : async () => 'Y2VydA==',
      reportError() {},
    },
  };
}

const acsRequest = (relayState = FED_REQUEST_ID, samlResponse = 'PHNhbWw+') =>
  new Request('https://api.kommunsign.se/auth/federation/GENERIC_SAML/acs', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
  });

test('a federated login must answer a request this system started', async () => {
  const doubles = federationDoubles();

  // Starting a login records the binding. Held only in memory it would be lost
  // on restart and unknown to other instances, so the only flows that worked
  // would be the IdP-initiated ones the decision layer refuses.
  const start = await handleFederationRequest(doubles.dependencies, new Request(
    `https://api.kommunsign.se/auth/federation/GENERIC_SAML/login?tenantId=${FED_ROUTE_TENANT}&returnPath=/arenden`,
    { method: 'POST' },
  ), 'r1');
  assert.equal(start.status, 201);
  assert.equal(doubles.started.length, 1);
  assert.match(doubles.started[0].requestId, /^_/, 'a SAML ID may not start with a digit');
  assert.equal(doubles.started[0].returnPath, '/arenden');

  const accepted = await handleFederationRequest(doubles.dependencies, acsRequest(), 'r2');
  assert.equal(accepted.status, 200);
  const identity = await accepted.json();
  assert.equal(identity.tenantId, FED_ROUTE_TENANT, 'the tenant comes from the login we recorded');
  assert.deepEqual(identity.roles, ['document_creator']);
  assert.equal(identity.returnPath, '/arenden');

  // Replaying the same assertion answers a login that no longer exists.
  const replayed = await handleFederationRequest(doubles.dependencies, acsRequest(), 'r3');
  assert.equal(replayed.status, 401);
  assert.equal((await replayed.json()).error.code, 'FEDERATION_LOGIN_REQUEST_INVALID');
});

test('an assertion with no login behind it is refused, and unknown is indistinguishable from expired', async () => {
  const missing = federationDoubles({ loginMissing: true });
  const response = await handleFederationRequest(missing.dependencies, acsRequest(), 'r4');
  assert.equal(response.status, 401);
  // Unknown, expired and already-answered are one answer. Telling them apart
  // would confirm which request ids existed.
  assert.equal((await response.json()).error.code, 'FEDERATION_LOGIN_REQUEST_INVALID');

  // A RelayState that is not one of ours never reaches the store at all.
  const malformed = federationDoubles();
  const bad = await handleFederationRequest(malformed.dependencies, acsRequest('../../etc/passwd'), 'r5');
  assert.equal(bad.status, 400);
  assert.equal(malformed.consumed.length, 0);
});

test('federated login fails closed when the IdP certificate is not configured', async () => {
  // Without the configured certificate the only verifiable claim is that the
  // message signed itself, which is what anybody with a text editor can do.
  const doubles = federationDoubles({ noTrust: true });
  const response = await handleFederationRequest(doubles.dependencies, acsRequest(), 'r6');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'FEDERATION_TRUST_NOT_CONFIGURED');

  // And when nothing is configured at all, the endpoint refuses rather than
  // accepting an assertion it cannot check.
  const unconfigured = await handleFederationRequest({ reportError() {} }, acsRequest(), 'r7');
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error.code, 'FEDERATION_NOT_CONFIGURED');
});

test('a report that did not verify the signature can never become an accepted login', async () => {
  for (const report of [
    { result: 'FAIL', signatureVerified: false, reason: 'SIGNER_NOT_TRUSTED' },
    // The dangerous one: a PASS with the flag missing. Defaulting it to true
    // would make every check below it meaningless.
    { result: 'PASS', signatureVerified: false },
  ]) {
    const doubles = federationDoubles({ report });
    const response = await handleFederationRequest(doubles.dependencies, acsRequest(), 'r8');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'FEDERATION_SIGNATURE_NOT_VERIFIED');
  }

  // A missing validity window is not a permissive one.
  const noWindow = federationDoubles({ report: { notOnOrAfter: null } });
  const expired = await handleFederationRequest(noWindow.dependencies, acsRequest(), 'r9');
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, 'FEDERATION_ASSERTION_EXPIRED');

  // An assertion with no id cannot be consumed, so it cannot be replay-protected.
  const noId = federationDoubles({ report: { assertionId: null } });
  const unconsumable = await handleFederationRequest(noId.dependencies, acsRequest(), 'r10');
  assert.equal(unconsumable.status, 401);
});

test('the ACS refuses an assertion minted for another endpoint or another service provider', async () => {
  const wrongAudience = federationDoubles({ report: { audience: 'https://someone-else.example/sp' } });
  const audience = await handleFederationRequest(wrongAudience.dependencies, acsRequest(), 'r11');
  assert.equal(audience.status, 401);
  assert.equal((await audience.json()).error.code, 'FEDERATION_AUDIENCE_MISMATCH');

  const wrongDestination = federationDoubles({ report: { destination: 'https://evil.example/acs' } });
  const destination = await handleFederationRequest(wrongDestination.dependencies, acsRequest(), 'r12');
  assert.equal(destination.status, 401);
  assert.equal((await destination.json()).error.code, 'FEDERATION_DESTINATION_MISMATCH');

  // An assertion that answers a different login than the one we consumed.
  const wrongRequest = federationDoubles({ report: { inResponseTo: '_someone-elses-request' } });
  const mismatched = await handleFederationRequest(wrongRequest.dependencies, acsRequest(), 'r13');
  assert.equal(mismatched.status, 401);
  assert.equal((await mismatched.json()).error.code, 'FEDERATION_REQUEST_MISMATCH');
});

test('the login endpoint will not become an open redirect', async () => {
  const doubles = federationDoubles();
  for (const returnPath of ['//evil.example/steal', 'https://evil.example', '/\\evil.example']) {
    const response = await handleFederationRequest(doubles.dependencies, new Request(
      `https://api.kommunsign.se/auth/federation/GENERIC_SAML/login?tenantId=${FED_ROUTE_TENANT}&returnPath=${encodeURIComponent(returnPath)}`,
      { method: 'POST' },
    ), 'r14');
    // An open redirect on a login endpoint is exactly where phishing wants one,
    // and `//host` is protocol-relative: a browser follows it off-site.
    assert.equal(response.status, 400, `${returnPath} must be refused`);
    assert.equal((await response.json()).error.code, 'FEDERATION_RETURN_PATH_INVALID');
  }
  assert.equal(doubles.started.length, 0);
});

test('signature verification lives in the validation service, not in the router', async () => {
  const router = await readFile('apps/api/src/federation-router.ts', 'utf8');
  // The router must not verify crypto itself: one implementation, in the place
  // that already has the XML-DSig machinery and its own tests.
  assert.doesNotMatch(router, /createVerify|XMLSignature|crypto\.subtle\.verify/);
  assert.match(router, /validation\.validateSaml/);
  // And the tenant is taken from the recorded login, never from the assertion.
  assert.match(router, /tenantId: login\.tenantId/);
  assert.doesNotMatch(router, /tenantId: (?:report|assertion)\./);

  const validator = await readFile('services/validation-service/src/main/java/se/kommunsign/validation/SamlAssertionValidator.java', 'utf8');
  // The configured certificate is compared before anything is read from the
  // message. KeyInfo is attacker-supplied.
  assert.match(validator, /SIGNER_IS_CONFIGURED_IDP/);
  assert.match(validator, /EXTERNAL_REFERENCE_FORBIDDEN/);
  assert.match(validator, /disallow-doctype-decl/);
});

const callbackRequest = (state = FED_REQUEST_ID, idToken = 'header.payload.signature') =>
  new Request(`https://api.kommunsign.se/auth/federation/GENERIC_OIDC/callback?state=${encodeURIComponent(state)}&id_token=${encodeURIComponent(idToken)}`);

test('OIDC reaches the same decision layer as SAML, and the endpoint cannot pick the protocol', async () => {
  const oidcConfig = {
    protocol: 'OIDC',
    destination: 'https://kungalv.kommunsign.se/auth/federation/GENERIC_OIDC/callback',
  };
  const doubles = federationDoubles({
    config: oidcConfig,
    report: { protocol: 'OIDC', destination: null },
  });
  // The double's consumeLogin returns the SAML redirectUri, so line it up with
  // the OIDC endpoint the token was actually received at.
  const original = doubles.dependencies.federation.consumeLogin;
  doubles.dependencies.federation.consumeLogin = async (requestId) => {
    const login = await original(requestId);
    return login ? { ...login, providerKey: 'GENERIC_OIDC', redirectUri: oidcConfig.destination } : null;
  };

  const accepted = await handleFederationRequest(doubles.dependencies, callbackRequest(), 'r20');
  assert.equal(accepted.status, 200);
  const identity = await accepted.json();
  assert.equal(identity.protocol, 'OIDC');
  assert.deepEqual(identity.roles, ['document_creator'], 'the same mapping, not a second copy of it');
  assert.equal(identity.tenantId, FED_ROUTE_TENANT);

  // A tenant configured for SAML must not be able to log in with an id_token by
  // posting to the callback instead — that would be a second, weaker path into
  // the same account.
  const samlTenant = federationDoubles();
  const samlConsume = samlTenant.dependencies.federation.consumeLogin;
  samlTenant.dependencies.federation.consumeLogin = async (requestId) => {
    const login = await samlConsume(requestId);
    // The provider key lines up with the endpoint, so the earlier
    // provider check does not fire and the protocol check is what is tested.
    return login ? { ...login, providerKey: 'GENERIC_OIDC' } : null;
  };
  const wrongEndpoint = await handleFederationRequest(samlTenant.dependencies, callbackRequest(), 'r21');
  assert.equal(wrongEndpoint.status, 400);
  assert.equal((await wrongEndpoint.json()).error.code, 'FEDERATION_PROTOCOL_MISMATCH');

  // A login started for one provider cannot be answered at another's endpoint
  // either, which is the check that fires first and is worth keeping distinct.
  const crossProvider = federationDoubles();
  const mismatchedProvider = await handleFederationRequest(crossProvider.dependencies, callbackRequest(), 'r22');
  assert.equal(mismatchedProvider.status, 401);
  assert.equal((await mismatchedProvider.json()).error.code, 'FEDERATION_LOGIN_REQUEST_INVALID');
});

test('an id_token with no destination is checked against the endpoint we recorded', async () => {
  const router = await readFile('apps/api/src/federation-router.ts', 'utf8');
  // An id_token carries no destination claim. Substituting one the token
  // supplied would defeat the check; the recorded redirect URI is used instead.
  assert.match(router, /destination: report\.destination \?\? receivedAt/);
  assert.match(router, /toWorkforceAssertion\(report, config, login\.redirectUri\)/);
  // The nonce is bound to the login we started, which is the role
  // InResponseTo plays for SAML — one rule, enforced once.
  assert.match(router, /expectedNonce: login\.requestId/);

  const validator = await readFile('services/validation-service/src/main/java/se/kommunsign/validation/OidcTokenValidator.java', 'utf8');
  // A header naming where to fetch the key is refused before verification.
  assert.match(validator, /ID_TOKEN_SELECTS_ITS_OWN_KEY/);
  assert.match(validator, /\\"jku\\"/);
  // Asymmetric algorithms only: an HMAC alg with an RSA public key is the
  // classic confusion, and the allow-list is what makes `none` unreachable.
  assert.match(validator, /ALLOWED_ALGORITHMS = Set\.of\("RS256", "ES256"\)/);
  // auth_time rather than iat, so a fresh token cannot describe an old session.
  assert.match(validator, /auth_time/);

  // One verifier, shared. Two copies is two places for `alg: none` to be
  // forgotten.
  const shared = await readFile('services/commons/src/main/java/se/kommunsign/commons/CompactJwsVerifier.java', 'utf8');
  assert.match(shared, /class CompactJwsVerifier/);
  assert.match(validator, /import se\.kommunsign\.commons\.CompactJwsVerifier;/);
});

// --- S3-compatible object storage adapter -----------------------------------

const s3Settings = {
  S3_ENDPOINT: 'https://storage.example.org',
  S3_REGION: 'eu-north-1',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret-example-key',
};

const s3TenantId = '11111111-2222-3333-4444-555555555555';
const s3Context = { tenantId: s3TenantId, actorId: 'worker-1', actorKind: 'worker' };

async function withCapturedFetch(fn, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body });
    return respond(captured.length - 1, String(url), init);
  };
  try { return { result: await fn(), captured }; }
  finally { globalThis.fetch = original; }
}

function s3Response(status, headers = {}, body = new Uint8Array()) {
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

/** Independent SigV4, so the test does not agree with the adapter by construction. */
function expectedSignature({ method, canonicalUri, canonicalQuery, headers, payloadHash, amzDate, region, secret }) {
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    nodeCrypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  let key = nodeCrypto.createHmac('sha256', `AWS4${secret}`).update(amzDate.slice(0, 8)).digest();
  for (const part of [region, 's3', 'aws4_request']) key = nodeCrypto.createHmac('sha256', key).update(part).digest();
  return { signature: nodeCrypto.createHmac('sha256', key).update(stringToSign).digest('hex'), signedHeaders, scope };
}

test('s3 adapter signs writes with a signature an independent SigV4 reproduces', async () => {
  const adapter = createS3ObjectStorageAdapter(s3Settings);
  const bytes = new TextEncoder().encode('%PDF-1.7 signed revision');
  const { result, captured } = await withCapturedFetch(
    () => adapter.putObject(s3Context, `${s3TenantId}/signed/case-1.pdf`, bytes, 'application/pdf'),
    (index) => s3Response(index === 0 ? 200 : 200),
  );

  const write = captured[captured.length - 1];
  assert.equal(write.method, 'PUT');
  assert.equal(write.url, `https://storage.example.org/signed-documents/${s3TenantId}/signed/case-1.pdf`);
  // Immutability is the whole point for a signed revision.
  assert.equal(write.headers['if-none-match'], '*');

  const digest = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(result.sha256, digest);
  assert.equal(write.headers['x-amz-content-sha256'], digest);

  const { authorization, ...signedHeaderValues } = write.headers;
  const expected = expectedSignature({
    method: 'PUT',
    canonicalUri: `/signed-documents/${s3TenantId}/signed/case-1.pdf`,
    canonicalQuery: '',
    headers: signedHeaderValues,
    payloadHash: digest,
    amzDate: write.headers['x-amz-date'],
    region: s3Settings.S3_REGION,
    secret: s3Settings.S3_SECRET_ACCESS_KEY,
  });
  assert.equal(
    authorization,
    `AWS4-HMAC-SHA256 Credential=${s3Settings.S3_ACCESS_KEY_ID}/${expected.scope}, SignedHeaders=${expected.signedHeaders}, Signature=${expected.signature}`,
  );
});

test('s3 adapter refuses to overwrite an object that already exists', async () => {
  const adapter = createS3ObjectStorageAdapter(s3Settings);
  await assert.rejects(
    withCapturedFetch(
      () => adapter.putObject(s3Context, `${s3TenantId}/signed/case-1.pdf`, new Uint8Array([1]), 'application/pdf'),
      (index) => s3Response(index === 0 ? 200 : 412),
    ),
    /STORAGE_OBJECT_ALREADY_EXISTS/,
  );
});

test('s3 adapter presigns an upload that carries a signature and an expiry', async () => {
  const adapter = createS3ObjectStorageAdapter(s3Settings);
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  const { result } = await withCapturedFetch(
    () => adapter.createUploadGrant(s3Context, {
      fileName: 'beslut.pdf', mimeType: 'application/pdf', byteSize: 12, sha256: 'a'.repeat(64),
      objectKey: `${s3TenantId}/inbox/beslut.pdf`, expiresAt,
    }),
    () => s3Response(200),
  );
  const url = new URL(result.uploadUrl);
  assert.equal(url.pathname, `/document-quarantine/${s3TenantId}/inbox/beslut.pdf`);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  const expires = Number(url.searchParams.get('X-Amz-Expires'));
  assert.ok(expires > 0 && expires <= 900, `unexpected expiry ${expires}`);
  assert.equal(result.requiredHeaders['content-type'], 'application/pdf');
});

test('s3 adapter refuses an upload grant that has already expired', async () => {
  const adapter = createS3ObjectStorageAdapter(s3Settings);
  await assert.rejects(
    withCapturedFetch(
      () => adapter.createUploadGrant(s3Context, {
        fileName: 'beslut.pdf', mimeType: 'application/pdf', byteSize: 12, sha256: 'a'.repeat(64),
        objectKey: `${s3TenantId}/inbox/beslut.pdf`, expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
      () => s3Response(200),
    ),
    /STORAGE_UPLOAD_GRANT_ALREADY_EXPIRED/,
  );
});

test('s3 adapter refuses an object key belonging to another tenant', async () => {
  const adapter = createS3ObjectStorageAdapter(s3Settings);
  await assert.rejects(
    adapter.headObject(s3Context, '99999999-2222-3333-4444-555555555555/signed/case-1.pdf'),
    /STORAGE_OBJECT_TENANT_MISMATCH/,
  );
});

test('s3 adapter reads size and checksum back from object metadata', async () => {
  const adapter = createS3ObjectStorageAdapter(s3Settings);
  const digest = nodeCrypto.createHash('sha256').update('x').digest('hex');
  const { result } = await withCapturedFetch(
    () => adapter.headObject(s3Context, `${s3TenantId}/canonical/case-1.pdf`),
    () => s3Response(200, { 'content-length': '4096', 'content-type': 'application/pdf', 'x-amz-meta-sha256': digest }),
  );
  assert.deepEqual(result, { byteSize: 4096, contentType: 'application/pdf', sha256: digest });
});

test('s3 adapter rejects a plaintext endpoint outside the local stack', () => {
  assert.throws(
    () => createS3ObjectStorageAdapter({ ...s3Settings, S3_ENDPOINT: 'http://storage.example.org' }),
    /S3_ENDPOINT_HTTPS_REQUIRED/,
  );
  // The local stack is the exception, and it has to keep working.
  assert.ok(createS3ObjectStorageAdapter({ ...s3Settings, S3_ENDPOINT: 'http://minio:9000' }));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`${tests.length} tests passed`);
