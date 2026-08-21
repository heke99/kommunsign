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
  requestId: 'integration-request', source: 'api-client', authMethod: 'development',
};
await withTenantTransaction(database, context, 'trusted_service', async () => 'ok');
// The tenant context must be established in a single round trip, but every setting has to
// survive that collapse: a silently dropped app.actor_kind would disable the audit guards.
assert.equal(queries.length, 1, 'tenant context must cost exactly one round trip');
const [contextSql, contextParameters] = queries[0];
assert.deepEqual(contextParameters, [
  context.tenantId,
  'trusted_service',
  context.subjectId,
  context.requestId,
  context.authMethod,
  // The key version rides along in the same round trip: app.key_version is what
  // the BEFORE INSERT trigger from migration data/0029 stamps on every row that
  // holds a ciphertext or a blind index.
  '1',
]);
for (const [ordinal, setting] of [
  'app.tenant_id', 'app.actor_kind', 'app.actor_id', 'app.request_id', 'app.auth_method', 'app.key_version',
].entries()) {
  assert.ok(
    contextSql.includes(`set_config('${setting}', $${ordinal + 1}, true)`),
    `tenant context must set ${setting} transaction-locally from parameter $${ordinal + 1}`,
  );
}

// Failing to establish tenant context must abort the transaction, never fall through to
// unscoped work. With five awaits this was structural; with one it rides on a single promise.
let workRan = false;
await assert.rejects(
  withTenantTransaction(
    {
      transaction: async (work) => work({
        query: async () => { throw new Error('TENANT_CONTEXT_REJECTED'); },
      }),
    },
    context,
    'trusted_service',
    async () => { workRan = true; return 'ok'; },
  ),
  /TENANT_CONTEXT_REJECTED/,
);
assert.equal(workRan, false, 'work must not run when tenant context fails');

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

const policiesResponse=await request('/v1/signature-policies');
assert.equal(policiesResponse.status,200);
const policyViews=await policiesResponse.json();
assert.equal(policyViews.length,2);
assert.ok(policyViews.some((item)=>item.decisionMode==='ELECTRONIC_SIGNATURE'));
const mismatchedPolicy=await request('/v1/signature-cases','POST',{title:'Fel policy',decisionMode:'DIGITAL_APPROVAL',signaturePolicyId:'33333333-3333-4333-8333-333333333333'},{'idempotency-key':key()});
assert.equal(mismatchedPolicy.status,422);
assert.equal((await mismatchedPolicy.json()).error.code,'SIGNATURE_POLICY_DECISION_MODE_MISMATCH');

const uploadResponse = await request('/v1/uploads', 'POST', {
  fileName: 'beslut.pdf', mimeType: 'application/pdf', byteSize: 1200, sha256: 'a'.repeat(64),
}, { 'idempotency-key': key() });
assert.equal(uploadResponse.status, 201);
const upload = await uploadResponse.json();

const caseResponse = await request('/v1/signature-cases', 'POST', {
  title: 'Delegationsbeslut', decisionMode: 'DIGITAL_APPROVAL', signaturePolicyId: '44444444-4444-4444-8444-444444444444',
}, { 'idempotency-key': key() });
assert.equal(caseResponse.status, 201);
const signatureCase = await caseResponse.json();
assert.equal(signatureCase.tenantId, context.tenantId);

assert.equal((await request(`/v1/signature-cases/${signatureCase.id}/documents`, 'POST', {
  uploadId: upload.id, displayName: 'Delegationsbeslut.pdf',
}, { 'idempotency-key': key() })).status, 202);
assert.equal((await request(`/v1/signature-cases/${signatureCase.id}/signers`, 'POST', {
  displayName: 'Beslutsfattare', email: 'beslutsfattare@testkommunen.se', personalNumber: '199001010009', requirePersonalNumberMatch: true, personalNumberException: null, required: true, signingOrder: 1,
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


let onboardingSequence = 0;
const onboardingKey = () => `onboarding-integration-${String(++onboardingSequence).padStart(5, '0')}`;
async function onboardingRequest(path, method = 'GET', body, headers = {}) {
  return handler(new Request(`https://api.example${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers, ...(method === 'GET' ? {} : { 'idempotency-key': onboardingKey() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
const createdApplicationResponse = await onboardingRequest('/v1/onboarding/applications', 'POST', {
  organizationName: 'Testkommunen', organizationNumber: '2120009999', organizationType: 'municipality',
  primaryEmail: 'it@testkommunen.se', primaryContactName: 'Test Person', primaryContactTitle: 'IT-chef',
});
assert.equal(createdApplicationResponse.status, 201);
const createdApplication = await createdApplicationResponse.json();
assert.equal(createdApplication.application.status, 'email_verification_pending');
assert.match(createdApplication.accessToken, /^[0-9a-f]{64}$/);
const applicationId = createdApplication.application.id;
const applicantHeaders = { authorization: `Bearer ${createdApplication.accessToken}` };

const wrongAccess = await onboardingRequest(`/v1/onboarding/applications/${applicationId}`, 'GET', undefined, { authorization: `Bearer ${'f'.repeat(64)}` });
assert.equal(wrongAccess.status, 403);
const verifiedResponse = await onboardingRequest(`/v1/onboarding/applications/${applicationId}/verify-email`, 'POST', { token: createdApplication.developmentVerificationToken });
assert.equal(verifiedResponse.status, 200);
let application = await verifiedResponse.json();
assert.equal(application.status, 'email_verified');
const patchedResponse = await onboardingRequest(`/v1/onboarding/applications/${applicationId}`, 'PATCH', {
  profile: { officialEmailDomain: 'testkommunen.se', deployment: { mode: 'shared_saas', region: 'se-central', classification: 'CONFIDENTIAL' } },
}, { ...applicantHeaders, 'if-match': String(application.statusVersion) });
assert.equal(patchedResponse.status, 200);
application = await patchedResponse.json();
const submitResponse = await onboardingRequest(`/v1/onboarding/applications/${applicationId}/submit`, 'POST', undefined, { ...applicantHeaders, 'if-match': String(application.statusVersion) });
assert.equal(submitResponse.status, 200);
application = await submitResponse.json();
assert.equal(application.status, 'submitted');
assert.match(application.applicationReference, /^ONB-\d{4}-\d{6}$/);

const platformHeaders = {
  'x-kommunsign-platform-subject-id': '99999999-9999-4999-8999-999999999999',
  'x-kommunsign-platform-roles': 'platform_super_admin',
};
const informationReviewResponse = await onboardingRequest(`/v1/platform/onboarding/applications/${applicationId}/reviews`, 'POST', {
  reviewType: 'commercial', result: 'requires_information', riskLevel: 'low', summary: 'Valfri komplettering registrerad',
}, platformHeaders);
assert.equal(informationReviewResponse.status, 201);
assert.equal((await informationReviewResponse.json()).status, 'additional_information_requested');

const approveResponse = await onboardingRequest(`/v1/platform/onboarding/applications/${applicationId}/approve`, 'POST', { reason: 'Godkänd av superadministratör' }, platformHeaders);
assert.equal(approveResponse.status, 200);
assert.equal((await approveResponse.json()).status, 'approved');
const repeatedApproveResponse = await onboardingRequest(`/v1/platform/onboarding/applications/${applicationId}/approve`, 'POST', { reason: 'Godkänd av superadministratör' }, platformHeaders);
assert.equal(repeatedApproveResponse.status, 200);
assert.equal((await repeatedApproveResponse.json()).status, 'approved');

const provisionResponse = await onboardingRequest(`/v1/platform/onboarding/applications/${applicationId}/provision`, 'POST', undefined, platformHeaders);
assert.equal(provisionResponse.status, 202);
const provisioned = await provisionResponse.json();
assert.equal(provisioned.status, 'completed');
assert.ok(provisioned.tenantId);
const repeatedProvisionResponse = await onboardingRequest(`/v1/platform/onboarding/applications/${applicationId}/provision`, 'POST', undefined, platformHeaders);
assert.equal(repeatedProvisionResponse.status, 202);
assert.equal((await repeatedProvisionResponse.json()).id, provisioned.id);
const readinessResponse = await onboardingRequest(`/v1/platform/tenants/${provisioned.tenantId}/readiness/run`, 'POST', undefined, platformHeaders);
assert.equal(readinessResponse.status, 200);
assert.equal((await readinessResponse.json()).ready, false);
const activationBlocked = await onboardingRequest(`/v1/platform/tenants/${provisioned.tenantId}/activation-requests`, 'POST', undefined, platformHeaders);
assert.equal(activationBlocked.status, 409);
assert.equal((await activationBlocked.json()).error.code, 'TENANT_NOT_READY_FOR_ACTIVATION');

console.log('integration tests: simple approval, provisioning and fail-closed activation passed');

const unauthorizedDirectOrganization=await onboardingRequest('/v1/platform/organizations','POST',{
  organizationName:'Otillåten direktkommun',organizationNumber:'2120007777',organizationType:'municipality',
  primaryAdminEmail:'admin@otillaten.se',primaryAdminName:'Olle Operatör',primaryAdminTitle:'Driftoperatör',
  deploymentMode:'shared_saas',region:'se-central',
},{'x-kommunsign-platform-subject-id':'88888888-8888-4888-8888-888888888888','x-kommunsign-platform-roles':'platform_operations'});
assert.equal(unauthorizedDirectOrganization.status,403);
assert.equal((await unauthorizedDirectOrganization.json()).error.code,'FORBIDDEN');

const directOrganization=await onboardingRequest('/v1/platform/organizations','POST',{
  organizationName:'Direktkommunen',organizationNumber:'2120008888',organizationType:'municipality',
  primaryAdminEmail:'admin@direktkommunen.se',primaryAdminName:'Anna Admin',primaryAdminTitle:'Kanslichef',
  deploymentMode:'shared_saas',region:'se-central',
},platformHeaders);
assert.equal(directOrganization.status,202);
const directView=await directOrganization.json();
assert.equal(directView.provisioningStatus,'completed');
assert.equal(directView.domainReady,true);
assert.ok(directView.tenantId);
const organizationList=await onboardingRequest('/v1/platform/organizations?search=Direktkommunen','GET',undefined,platformHeaders);
assert.equal(organizationList.status,200);
const listedOrganizations=await organizationList.json();
assert.equal(listedOrganizations.data.length,1);
assert.equal(listedOrganizations.data[0].primaryAdminEmail,'admin@direktkommunen.se');
const duplicateOrganization=await onboardingRequest('/v1/platform/organizations','POST',{
  organizationName:'Direktkommunen igen',organizationNumber:'2120008888',organizationType:'municipality',
  primaryAdminEmail:'annan@direktkommunen.se',primaryAdminName:'Annan Admin',primaryAdminTitle:'Administratör',
  deploymentMode:'shared_saas',region:'se-central',
},platformHeaders);
assert.equal(duplicateOrganization.status,409);
assert.equal((await duplicateOrganization.json()).error.code,'ORGANIZATION_ALREADY_EXISTS');

console.log('integration tests: direct superadmin organization creation, listing and duplicate protection passed');
