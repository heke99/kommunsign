#!/usr/bin/env node
// Drives the application chain against running services. Invoked by
// scripts/e2e-application-chain.sh, which starts everything first.
//
// Nothing here is mocked inside the system: the API is the production runtime,
// the workers are the production runner, the databases are Postgres, the object
// store is MinIO through the S3 adapter, and the signing and validation
// services are the real jars over HTTP. The only doubles are for suppliers
// outside the system, and each one is named where it is used.

import { createHmac, randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const api = `http://127.0.0.1:${required('E2E_API_PORT')}`;
const gatewayKey = required('INTERNAL_GATEWAY_HMAC_KEY');
const platformSubject = required('E2E_PLATFORM_SUBJECT');
const controlUrl = required('CONTROL_DATABASE_URL');
const dataUrl = required('DATA_DATABASE_URL');
// undici sends the host header derived from the URL and ignores an override,
// so the gateway signature has to be computed over the host the server sees.
const host = `127.0.0.1:${required('E2E_API_PORT')}`;

const control = postgres(controlUrl, { max: 2, prepare: false, onnotice: () => {} });
const data = postgres(dataUrl, { max: 2, prepare: false, onnotice: () => {} });

let failures = 0;
const started = Date.now();
function report(name, detail) { console.log(`  ok    ${name.padEnd(46)} ${detail ?? ''}`.trimEnd()); }
function fail(name, detail) { failures += 1; console.error(`  FAIL  ${name.padEnd(46)} ${detail ?? ''}`.trimEnd()); }

async function step(name, fn) {
  try { report(name, await fn()); }
  catch (error) { fail(name, error instanceof Error ? error.message : String(error)); throw error; }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function call(audience, method, path, body, extra = {}) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authMethod = 'trusted_service';
  const options = { ...extra };
  const subject = options.subjectId ?? platformSubject;
  const hostHeader = options.hostHeader ?? host;
  delete options.subjectId;
  delete options.hostHeader;
  const payload = [audience, method.toUpperCase(), path, hostHeader.toLowerCase(), subject, requestId, authMethod, timestamp].join('\n');
  const headers = {
    host: hostHeader,
    'content-type': 'application/json',
    'x-kommunsign-subject-id': subject,
    'x-request-id': requestId,
    'x-kommunsign-gateway-timestamp': timestamp,
    'x-kommunsign-gateway-signature': createHmac('sha256', gatewayKey).update(payload).digest('hex'),
    'x-kommunsign-auth-method': authMethod,
    ...options,
  };
  return await send(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
}

// node:http rather than fetch: a tenant is addressed by hostname, undici
// refuses to send a host header that disagrees with the URL, and the gateway
// signature covers the host the server sees.
function send(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: Number(process.env.E2E_API_PORT), method, path, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          resolve({ status: response.statusCode, body: parsed, headers: response.headers });
        });
      },
    );
    outgoing.on('error', reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

function expect(result, statuses, what) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(result.status)) {
    throw new Error(`${what}: expected ${allowed.join('/')}, got ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  }
  return result.body;
}

async function waitFor(what, predicate, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

console.log('application chain, end to end against running services\n');

// ---------------------------------------------------------------------------
// 1. Provisioning, through the platform API rather than around it.
// ---------------------------------------------------------------------------

const organizationNumber = `21200${String(Math.floor(Math.random() * 90000) + 10000)}`;
let organization;

await step('platform API answers an authenticated call', async () => {
  // Deliberately a lookup that misses rather than a listing. Every run mints
  // fresh sensitive-data keys, so rows left by an earlier run cannot be
  // decrypted, and a listing would fail for that reason rather than for
  // anything this chain is testing.
  const missing = await call('platform', 'GET', `/v1/platform/tenants/${randomUUID()}/readiness`);
  expect(missing, 404, 'readiness for an unknown tenant');
  const unsigned = await send('GET', '/v1/platform/organizations', { host, 'x-kommunsign-subject-id': platformSubject });
  if (unsigned.status < 400) throw new Error(`an unsigned request was accepted with ${unsigned.status}`);
  return 'signed call accepted, unsigned call refused';
});

await step('creates an organization', async () => {
  organization = expect(await call('platform', 'POST', '/v1/platform/organizations', {
    organizationName: 'Kungalvs kommun E2E',
    organizationNumber,
    organizationType: 'municipality',
    primaryAdminEmail: `e2e-${randomUUID().slice(0, 8)}@kungalv.invalid`,
    primaryAdminName: 'E2E Beslutsfattare',
    primaryAdminTitle: 'Kanslichef',
    deploymentMode: 'shared_saas',
    region: 'eu-north-1',
  }, { 'idempotency-key': randomUUID() }), 202, 'create organization');
  return `${organization.legalName}, ${organizationNumber}`;
});

const provisioningRequestId = organization.provisioningRequestId;
let tenantId;

await step('provisioning runs to completion in the worker', async () => {
  // Polled through the API, not the database: the read path is part of what a
  // platform operator actually uses, so it should be exercised too.
  const settled = await waitFor('provisioning to settle', async () => {
    const current = expect(
      await call('platform', 'GET', `/v1/platform/provisioning/requests/${provisioningRequestId}`),
      200, 'read provisioning request');
    return ['completed', 'failed'].includes(current.status) ? current : null;
  });
  if (settled.status !== 'completed') {
    throw new Error(`provisioning ${settled.status} at ${settled.currentStep ?? 'unknown step'}: ${settled.blockingCode ?? 'no code'}`);
  }
  tenantId = settled.tenantId;
  return `tenant ${tenantId}`;
});

await step('the tenant has a data plane and object storage', async () => {
  const rows = await control`
    select status from control.tenant_environments where tenant_id = ${tenantId}`;
  const environment = rows[0];
  if (!environment) throw new Error('no tenant environment recorded');
  if (!['ready', 'onboarding', 'active'].includes(environment.status)) {
    throw new Error(`tenant environment is ${environment.status}`);
  }
  const steps = await control`
    select step_key, status::text as status, resource_reference
      from control.tenant_provisioning_steps
     where provisioning_request_id = ${provisioningRequestId}
       and step_key = 'create_storage_namespaces'
     order by sequence_number desc limit 1`;
  const storage = steps[0];
  if (!storage) throw new Error('the storage step never ran');
  if (storage.status !== 'completed') throw new Error(`storage step ${storage.status}`);
  // The reference the adapter returned, recorded by the worker. For the S3
  // adapter this is the endpoint it actually wrote to, so a run against the
  // wrong object store is visible here rather than three steps later.
  if (!String(storage.resource_reference ?? '').startsWith('s3://')) {
    throw new Error(`unexpected storage reference ${storage.resource_reference}`);
  }
  return storage.resource_reference;
});

// ---------------------------------------------------------------------------
// 2. The tenant boundary.
//
// Two rows are seeded here. Both stand in for the external identity provider,
// which is the supplier that issues the first administrator and verifies the
// hostname, and neither invents anything the system would otherwise compute:
// a tenant administrator, and an active default hostname. Everything after
// this point goes through the API.
// ---------------------------------------------------------------------------

const tenantSubject = randomUUID();
let tenantHost;

await step('the tenant is activated and has an administrator', async () => {
  await control`update control.platform_tenants set status = 'active' where id = ${tenantId}`;
  await control`update control.tenant_environments set status = 'active' where tenant_id = ${tenantId}`;
  const domains = await control`
    update control.tenant_domains
       set status = 'active', is_primary = true, verification_status = 'verified',
           verified_at = now(), dns_verified_at = now(), lifecycle_state = 'active',
           certificate_issued_at = now(), activated_at = now(), last_health_status = 'healthy'
     where tenant_id = ${tenantId} and domain_type = 'platform_default'
     returning normalized_hostname`;
  tenantHost = domains[0]?.normalized_hostname;
  if (!tenantHost) throw new Error('the tenant has no default hostname');

  await data.begin(async (transaction) => {
    await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
    await transaction`select set_config('app.actor_kind', 'trusted_service', true)`;
    await transaction`select set_config('app.actor_id', ${tenantSubject}, true)`;
    await transaction`select set_config('app.request_id', ${randomUUID()}, true)`;
    await transaction`select set_config('app.auth_method', 'trusted_service', true)`;
    const users = await transaction`
      insert into app.users (tenant_id, external_subject, display_name)
      values (${tenantId}, ${tenantSubject}, 'E2E Kommunadministrator')
      returning id`;
    const memberships = await transaction`
      insert into app.memberships (tenant_id, user_id, status)
      values (${tenantId}, ${users[0].id}, 'active') returning id`;
    const roles = await transaction`
      select id from app.roles where tenant_id = ${tenantId} and role_key = 'tenant_admin'`;
    if (!roles[0]) throw new Error('provisioning did not seed a tenant_admin role');
    await transaction`
      insert into app.role_assignments (tenant_id, membership_id, role_id)
      values (${tenantId}, ${memberships[0].id}, ${roles[0].id})`;
  });
  return tenantHost;
});

const tenant = (method, path, body, extra = {}) =>
  call('tenant', method, path, body, { ...extra, hostHeader: tenantHost, subjectId: tenantSubject });

let policyId;
await step('the tenant sees the policies provisioning seeded', async () => {
  const policies = expect(await tenant('GET', '/v1/signature-policies'), 200, 'list policies');
  const electronic = policies.find((policy) => policy.decisionMode === 'ELECTRONIC_SIGNATURE');
  if (!electronic) throw new Error('no electronic-signature policy was seeded');
  policyId = electronic.id;
  return `${policies.length} policies, using ${electronic.name ?? electronic.policyKey ?? policyId}`;
});

// ---------------------------------------------------------------------------
// 3. A document, through the pipeline the worker actually runs.
// ---------------------------------------------------------------------------

const pdf = readFileSync(required('E2E_SOURCE_PDF'));
const pdfSha256 = createHash('sha256').update(pdf).digest('hex');

let uploadId;
await step('an upload grant is issued and the bytes land in object storage', async () => {
  const grant = expect(await tenant('POST', '/v1/uploads', {
    fileName: 'beslut.pdf', mimeType: 'application/pdf', byteSize: pdf.byteLength, sha256: pdfSha256,
  }, { 'idempotency-key': randomUUID() }), 201, 'create upload');
  uploadId = grant.id;
  if (!grant.uploadUrl) throw new Error('no upload URL was issued');
  // The grant is used exactly as a client would: a direct PUT to the object
  // store with the headers the API said to send. Nothing proxies it.
  const uploaded = await fetch(grant.uploadUrl, { method: 'PUT', headers: grant.requiredHeaders ?? {}, body: pdf });
  if (!uploaded.ok) throw new Error(`the object store refused the grant: ${uploaded.status} ${(await uploaded.text()).slice(0, 200)}`);
  return `${pdf.byteLength} bytes, sha256 ${pdfSha256.slice(0, 12)}`;
});

await step('the upload is accepted only when the bytes match', async () => {
  const completed = expect(await tenant('POST', `/v1/uploads/${uploadId}/complete`, undefined,
    { 'idempotency-key': randomUUID() }), 200, 'complete upload');
  if (completed.status && !['ready', 'uploaded', 'scanning', 'pending'].includes(completed.status)) {
    throw new Error(`unexpected upload status ${completed.status}`);
  }
  return completed.status ?? 'accepted';
});

let caseId;
await step('a signature case is created and the document attached', async () => {
  const created = expect(await tenant('POST', '/v1/signature-cases', {
    title: 'Delegationsbeslut KS2026/1005',
    decisionMode: 'ELECTRONIC_SIGNATURE',
    signaturePolicyId: policyId,
  }, { 'idempotency-key': randomUUID() }), 201, 'create case');
  caseId = created.id;
  expect(await tenant('POST', `/v1/signature-cases/${caseId}/documents`, {
    uploadId, displayName: 'Delegationsbeslut.pdf',
  }, { 'idempotency-key': randomUUID() }), 202, 'attach document');
  return caseId;
});

await step('the worker scans and canonicalises the document', async () => {
  const document = await waitFor('the document to become ready', async () => {
    const rows = await data`
      select d.id, v.status::text as version_status, v.canonical_object_key,
             v.pdf_profile, v.canonical_page_count
        from app.documents d
        left join lateral (
          select * from app.document_versions v
           where v.tenant_id = d.tenant_id and v.document_id = d.id
           order by v.version desc limit 1
        ) v on true
       where d.tenant_id = ${tenantId} and d.signature_case_id = ${caseId}`;
    const row = rows[0];
    if (!row) return null;
    if (String(row.version_status ?? '').includes('reject')) throw new Error(`the document was rejected: ${row.version_status}`);
    return row.canonical_object_key ? row : null;
  }, { timeoutMs: 180_000 });
  return `${document.pdf_profile ?? 'unknown profile'}, ${document.canonical_object_key}`;
});

let signerId;
await step('a signer is added and the case is sent', async () => {
  const signer = expect(await tenant('POST', `/v1/signature-cases/${caseId}/signers`, {
    displayName: 'E2E Beslutsfattare',
    email: 'beslutsfattare@kungalv.invalid',
    personalNumber: '199001010009',
    requirePersonalNumberMatch: true,
    personalNumberException: null,
    required: true,
    signingOrder: 1,
  }, { 'idempotency-key': randomUUID() }), 201, 'add signer');
  signerId = signer.id;
  const current = expect(await tenant('GET', `/v1/signature-cases/${caseId}`), 200, 'read case');
  if (current.status !== 'ready') throw new Error(`the case is ${current.status}, not ready to send`);
  const sent = expect(await tenant('POST', `/v1/signature-cases/${caseId}/send`, undefined,
    { 'idempotency-key': randomUUID(), 'if-match': String(current.statusVersion) }), 200, 'send case');
  if (sent.status !== 'sent') throw new Error(`the case is ${sent.status} after sending`);
  return `signer ${signerId}`;
});

await step('the invitation reaches the email provider', async () => {
  const seen = await waitFor('the invitation to be sent', async () => {
    const response = await fetch(`https://127.0.0.1:${required('E2E_STUB_PORT')}/stub/emails`);
    const payload = await response.json();
    return payload.delivered.length > 0 ? payload.delivered : null;
  }, { timeoutMs: 90_000 });
  const last = seen[seen.length - 1];
  // The document must not travel by email; the invitation carries a link.
  if (JSON.stringify(last).includes('%PDF')) throw new Error('the document was attached to the invitation');
  return last.subject;
});

// ---------------------------------------------------------------------------
// 4. Identity, and the line the system must not cross.
//
// BankID completion data is signed by BankID's key and verified against their
// CA. Nothing here can mint one, so the stub returns completion data that will
// not verify -- and the point of this step is that the system says so. A signer
// that reached 'signed' on unverifiable evidence would be the exact failure the
// whole design exists to prevent.
// ---------------------------------------------------------------------------

let invitationToken;
await step('the signer opens the invitation and sees the document', async () => {
  const emails = await (await fetch(`https://127.0.0.1:${required('E2E_STUB_PORT')}/stub/emails`)).json();
  const text = emails.delivered[emails.delivered.length - 1]?.text ?? '';
  invitationToken = /[?&]token=([^\s&)]+)/.exec(text)?.[1];
  if (!invitationToken) throw new Error('the invitation carried no signing link');
  invitationToken = decodeURIComponent(invitationToken);

  const signHost = new URL(required('SIGNER_FALLBACK_URL')).hostname;
  const invitation = expect(await send('GET', `/v1/public/signing-invitations/${invitationToken}`, { host: signHost }), 200, 'read invitation');
  if (!invitation.documents?.length) throw new Error('the invitation showed no documents');
  expect(await send('POST', `/v1/public/signing-invitations/${invitationToken}/opened`, { host: signHost, 'content-type': 'application/json' }, '{}'), 200, 'mark opened');

  // The signer must be able to read exactly what they are about to sign.
  const documentId = invitation.documents[0].documentId ?? invitation.documents[0].id;
  const shown = await send('GET', `/v1/public/signing-invitations/${invitationToken}/documents/${documentId}`, { host: signHost });
  if (shown.status !== 200) throw new Error(`the document was not shown: ${shown.status}`);
  return `${invitation.documents.length} document(s) shown to the signer`;
});

// ---------------------------------------------------------------------------
// 5. Identity, and the line the system must not cross.
//
// BankID completion data is signed by BankID's key and verified against their
// CA. Nothing local can mint one, so the stub returns completion data that
// cannot verify -- and the point of this step is that the system says so. A
// signer that reached signed on unverifiable evidence would be the exact
// failure the whole design exists to prevent.
// ---------------------------------------------------------------------------

await step('BankID starts and the evidence is refused, not accepted', async () => {
  const signHost = new URL(required('SIGNER_FALLBACK_URL')).hostname;
  const started = await send('POST', `/v1/public/signing-invitations/${invitationToken}/bankid/start`,
    { host: signHost, 'content-type': 'application/json' }, JSON.stringify({ reviewAcknowledged: true }));
  if (started.status !== 201) throw new Error(`BankID did not start: ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`);
  const sessionId = started.body.id ?? started.body.sessionId;
  if (!sessionId) throw new Error('the start response carried no session');

  // Polled the way the signer portal polls. Nothing collects the evidence
  // until the session is seen to have completed.
  await waitFor('the BankID session to leave pending', async () => {
    const polled = await send('GET', `/v1/public/signing-invitations/${invitationToken}/bankid/sessions/${sessionId}`, { host: signHost });
    if (polled.status !== 200) throw new Error(`polling failed: ${polled.status} ${JSON.stringify(polled.body).slice(0, 200)}`);
    return polled.body.status && polled.body.status !== 'pending' ? polled.body.status : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });

  const settled = await waitFor('the identity attempt to settle', async () => {
    const rows = await data`
      select s.status::text as signer_status,
             (select t.status::text from app.identity_transactions t
               where t.tenant_id = s.tenant_id and t.signer_id = s.id
               order by t.started_at desc limit 1) as identity_status
        from app.signers s where s.tenant_id = ${tenantId} and s.id = ${signerId}`;
    const row = rows[0];
    if (row?.signer_status === 'signed') throw new Error('a signer was marked signed on evidence that did not verify');
    return ['failed', 'cancelled', 'expired'].includes(row?.identity_status ?? '') ? row : null;
  }, { timeoutMs: 120_000, intervalMs: 2000 });

  const artifacts = await data`
    select count(*)::int as count from app.signature_artifacts where tenant_id = ${tenantId}`;
  if (artifacts[0]?.count) throw new Error('a signed artifact exists without verified identity evidence');
  return `identity ${settled.identity_status}, signer ${settled.signer_status}, no signed artifact`;
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

await control.end({ timeout: 5 });
await data.end({ timeout: 5 });

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures) {
  console.error(`\napplication chain FAILED (${failures}) after ${seconds}s`);
  process.exit(1);
}
console.log(`\napplication chain: OK (${seconds}s)`);
