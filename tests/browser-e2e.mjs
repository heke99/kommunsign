import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = new URL('../', import.meta.url);
const API = 'http://127.0.0.1:8787';
const PORTAL = 'http://127.0.0.1:3002';
const children = [];

function spawnService(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  children.push({ child, output: () => output.slice(-12_000) });
  return child;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`E2E_SERVICE_NOT_READY ${url}: ${last}`);
}

function createUploadSink() {
  return createServer((request, response) => {
    const requestedHeaders = request.headers['access-control-request-headers'];
    const headers = {
      'access-control-allow-origin': PORTAL,
      'access-control-allow-methods': 'PUT,OPTIONS',
      'access-control-allow-headers': requestedHeaders || 'content-type,x-amz-checksum-sha256',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '60',
      vary: 'Origin, Access-Control-Request-Headers',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (request.method !== 'PUT') {
      response.writeHead(405, headers);
      response.end();
      return;
    }
    let size = 0;
    request.on('data', (chunk) => { size += chunk.length; });
    request.on('end', () => {
      response.writeHead(size > 0 ? 200 : 400, headers);
      response.end();
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`E2E_ASSERTION_FAILED: ${message}`);
}

async function selectCase(page, selector, title) {
  const option = page.locator(`${selector} option`, { hasText: title }).first();
  const value = await option.getAttribute('value');
  assert(value, `No ${selector} option exists for ${title}`);
  await page.locator(selector).selectOption(value);
}

async function waitForStatus(page, selector, text, context) {
  try {
    await page.locator(selector).filter({ hasText: text }).waitFor({ timeout: 30_000 });
  } catch (error) {
    const actual = await page.locator(selector).textContent().catch(() => 'status unavailable');
    throw new Error(`${context}: expected ${JSON.stringify(text)}, actual ${JSON.stringify(actual)}; ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertCaseDetail(page, title) {
  const detail = page.locator('#case-detail-content');
  await detail.filter({ hasText: title }).waitFor();
  await detail.filter({ hasText: 'e2e.pdf' }).waitFor();
  await detail.filter({ hasText: 'E2E Signerare' }).waitFor();
}

async function assertIndependentBrowserState(browser, title) {
  const context = await browser.newContext({ locale: 'sv-SE' });
  try {
    const page = await context.newPage();
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
    await page.locator('#protected-app').waitFor({ state: 'visible' });
    const row = page.locator('#case-list tr', { hasText: title });
    await row.waitFor();
    await row.getByRole('button', { name: 'Visa' }).click();
    await assertCaseDetail(page, title);
  } finally {
    await context.close();
  }
}

function tenantHeaders(tenantId, subjectId, extra = {}) {
  return {
    'content-type': 'application/json',
    'x-kommunsign-tenant-id': tenantId,
    'x-kommunsign-subject-id': subjectId,
    'x-kommunsign-roles': 'tenant_admin',
    'x-request-id': crypto.randomUUID(),
    ...extra,
  };
}

async function exerciseTenantIsolation() {
  const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const subjectA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const subjectB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const create = await fetch(`${API}/v1/signature-cases`, {
    method: 'POST',
    headers: tenantHeaders(tenantA, subjectA, { 'idempotency-key': `e2e-tenant-${crypto.randomUUID()}` }),
    body: JSON.stringify({
      title: `Tenant isolation ${crypto.randomUUID().slice(0, 8)}`,
      decisionMode: 'ELECTRONIC_SIGNATURE',
      signaturePolicyId: '33333333-3333-4333-8333-333333333333',
    }),
  });
  assert(create.ok, `tenant A case creation returned ${create.status}`);
  const created = await create.json();
  assert(typeof created.id === 'string', 'tenant A case creation returned no id');

  const ownDetail = await fetch(`${API}/v1/signature-cases/${created.id}`, { headers: tenantHeaders(tenantA, subjectA) });
  assert(ownDetail.ok, `tenant A cannot read its own case (${ownDetail.status})`);

  const crossTenantDetail = await fetch(`${API}/v1/signature-cases/${created.id}`, { headers: tenantHeaders(tenantB, subjectB) });
  assert(crossTenantDetail.status === 404, `tenant B read tenant A case: HTTP ${crossTenantDetail.status}`);

  const tenantBList = await fetch(`${API}/v1/signature-cases?limit=50`, { headers: tenantHeaders(tenantB, subjectB) });
  assert(tenantBList.ok, `tenant B list returned ${tenantBList.status}`);
  const tenantBPayload = await tenantBList.json();
  assert(!tenantBPayload.data?.some((item) => item.id === created.id), 'tenant A case leaked into tenant B list');

  const crossTenantMutation = await fetch(`${API}/v1/signature-cases/${created.id}/signers`, {
    method: 'POST',
    headers: tenantHeaders(tenantB, subjectB, { 'idempotency-key': `e2e-idor-${crypto.randomUUID()}` }),
    body: JSON.stringify({
      displayName: 'Cross tenant attacker',
      email: 'attacker@example.invalid',
      personalNumber: '199001010017',
      requirePersonalNumberMatch: true,
      personalNumberException: null,
      required: true,
      signingOrder: 1,
    }),
  });
  assert(crossTenantMutation.status === 404, `tenant B mutated tenant A case: HTTP ${crossTenantMutation.status}`);
  process.stdout.write('browser-e2e tenant-isolation: PASS\n');
}

async function exerciseBrowser(name, browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'sv-SE' });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
    await page.locator('#protected-app').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#policy option').length > 0);

    const title = `E2E ${name} ${crypto.randomUUID().slice(0, 8)}`;
    await page.locator('#title').fill(title);
    await page.locator('#external-reference').fill(`E2E-${name.toUpperCase()}`);
    await page.locator('#case-form button[type="submit"]').click();
    await waitForStatus(page, '#case-status', `Skapade ${title}`, `${name} create case`);
    await page.locator('#case-list tr', { hasText: title }).waitFor();

    await selectCase(page, '#document-case', title);
    await page.locator('#document-file').setInputFiles({
      name: 'e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'),
    });
    await page.locator('#document-form button[type="submit"]').click();
    await waitForStatus(page, '#document-status', 'ligger i karantän', `${name} upload`);

    await selectCase(page, '#signer-case', title);
    await page.locator('#signer-name').fill('E2E Signerare');
    await page.locator('#signer-email').fill('e2e-signer@example.invalid');
    await page.locator('#personal-number').fill('199001010017');
    await page.locator('#signer-form button[type="submit"]').click();
    await waitForStatus(page, '#signer-status', 'har lagts till', `${name} signer`);

    const row = page.locator('#case-list tr', { hasText: title });
    await row.getByRole('button', { name: 'Visa' }).click();
    await assertCaseDetail(page, title);

    // A refresh must reconstruct business state from the API, not from JS memory.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#protected-app').waitFor({ state: 'visible' });
    const reloadedRow = page.locator('#case-list tr', { hasText: title });
    await reloadedRow.waitFor();
    await reloadedRow.getByRole('button', { name: 'Visa' }).click();
    await assertCaseDetail(page, title);

    // A separate browser context must see the same server-authoritative state.
    await assertIndependentBrowserState(browser, title);

    await reloadedRow.getByRole('button', { name: 'Skicka' }).click();
    await waitForStatus(page, '#case-status', 'har skickats', `${name} send`);
    await page.locator('#case-list tr', { hasText: title }).filter({ hasText: 'Skickad' }).waitFor();

    assert(consoleErrors.length === 0, `${name} emitted browser errors: ${consoleErrors.join(' | ')}`);
    await context.close();
    process.stdout.write(`browser-e2e ${name}: PASS\n`);
  } finally {
    await browser.close();
  }
}

const uploadSink = createUploadSink();
await new Promise((resolve, reject) => {
  uploadSink.once('error', reject);
  uploadSink.listen(9000, '127.0.0.1', resolve);
});

try {
  spawnService(process.execPath, ['apps/api/server.mjs'], {
    APP_ENV: 'development',
    PORT: '8787',
    KOMMUNSIGN_API_BOOTSTRAP_MODULE: '../../dist/apps/api/src/dev-runtime.js',
    CORS_ALLOWED_ORIGINS: PORTAL,
    TRUST_PROXY: 'false',
  });
  spawnService(process.execPath, ['scripts/serve-static.mjs', 'apps/tenant-portal/public', '3002']);

  await Promise.all([
    waitFor(`${API}/health/ready`),
    waitFor(PORTAL),
  ]);

  await exerciseTenantIsolation();
  for (const [name, browserType] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    await exerciseBrowser(name, browserType);
  }
} catch (error) {
  for (const entry of children) {
    const output = entry.output();
    if (output) process.stderr.write(`\n--- service output ---\n${output}\n`);
  }
  throw error;
} finally {
  await new Promise((resolve) => uploadSink.close(resolve));
  for (const entry of children) entry.child.kill('SIGTERM');
}
