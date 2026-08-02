import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = [
  'README.md','AGENTS.md','SECURITY.md','THREAT_MODEL.md','DATA_PROCESSING.md','LICENSE_POLICY.md',
  'docs/api/openapi.yaml','migrations/control/0001_control_plane.sql','migrations/control/0003_domain_and_profile_integrity.sql',
  'migrations/control/0004_versioned_configuration_integrity.sql','migrations/control/0005_auth_domain_and_break_glass_runtime.sql','migrations/data/0005_rls.sql',
  'migrations/data/0009_integrity_and_worker_recovery.sql','migrations/data/0010_immutability_and_evidence_states.sql','migrations/data/0011_upload_notification_and_invitation_runtime.sql',
  'upstream/manifests/source-inventory.yaml','upstream/manifests/reuse-map.json',
  'upstream/permissions/PERMISSION_EVIDENCE_REQUIRED.md','docker-compose.yml','.github/workflows/ci.yml',
  'apps/api/server.mjs','infrastructure/docker/api.Dockerfile','SBOM.cdx.json','PROVENANCE_REPORT.txt',
  'docs/operations/synchronization.md','docs/operations/vercel-deployment.md','docs/architecture/review-2026-08-02.md',
  'docs/architecture/current-state-verified.md','docs/architecture/remaining-implementation-plan.md','docs/verification/requirements-traceability.md',
  'vercel.json','apps/public-website/public/index.html','apps/public-website/public/app.css','scripts/build-public-site.mjs','scripts/build-portals.mjs',
  'apps/tenant-portal/public/app.js','apps/platform-admin/public/app.js','apps/signer-portal/public/app.js','apps/verification-portal/public/app.js',
  'packages/auth/src/index.ts','packages/branding/src/index.ts','packages/custom-domains/src/index.ts','packages/invitations/src/index.ts','packages/uploads/src/index.ts',
  'sdks/typescript/src/client.ts','sdks/csharp/src/KommunSignClient.cs','sdks/java/src/main/java/se/kommunsign/sdk/KommunSignClient.java','scripts/verify-sdk-sync.mjs',
];
for (const path of required) await access(path);

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
if (workflow.includes('REPLACE_WITH') || /uses:\s+[^@]+@v\d/.test(workflow)) throw new Error('GitHub Actions must be pinned to full SHAs');
if (/run:\s+echo\s+["'](?:Run|Generate)/.test(workflow)) throw new Error('CI contains a placeholder security step');

const forbiddenExtensions = ['.pem','.key','.p12','.pfx','.jks','.keystore'];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['.git','dist','build','node_modules'].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (forbiddenExtensions.some((extension) => entry.name.endsWith(extension))) throw new Error(`Forbidden secret file: ${child}`);
  }
}
await walk('.');

const rls = await readFile('migrations/data/0005_rls.sql', 'utf8');
if (!rls.includes('FORCE ROW LEVEL SECURITY')) throw new Error('RLS migration must force row level security');
const core = await readFile('migrations/data/0002_core_tables.sql', 'utf8');
if (!core.includes('FOREIGN KEY (tenant_id,')) throw new Error('Composite tenant foreign keys missing');
const hardening = await readFile('migrations/data/0009_integrity_and_worker_recovery.sql', 'utf8');
for (const marker of ['digital_approval_evidence','assert_case_completion_evidence','assert_valid_status_transition',"candidate.status = 'leased'"]) {
  if (!hardening.includes(marker)) throw new Error(`Database hardening lacks ${marker}`);
}
const immutability = await readFile('migrations/data/0010_immutability_and_evidence_states.sql', 'utf8');
for (const marker of ['protect_document_version_binding','protect_case_policy_snapshot','require_trusted_cryptographic_service']) {
  if (!immutability.includes(marker)) throw new Error(`Immutability migration lacks ${marker}`);
}

const api = await readFile('docs/api/openapi.yaml', 'utf8');
if (api.includes('tenantId:') && !api.includes('Tenant is derived')) throw new Error('OpenAPI may not accept arbitrary tenantId');
if (!api.includes('additionalProperties: false')) throw new Error('Create payload must reject unknown fields');
if ((api.match(/x-kommunsign-implementation-status: runtime/g) ?? []).length !== 16) throw new Error('OpenAPI must expose all sixteen required runtime operations');
if (api.includes('x-kommunsign-implementation-status: contract-only')) throw new Error('Required OpenAPI operations may not remain contract-only');
const router = await readFile('apps/api/src/router.ts', 'utf8');
if (router.includes("cause instanceof Error ? cause.message")) throw new Error('API must not return internal exception messages');
if (!router.includes("await dependencies.authorize")) throw new Error('API routes must pass through authorization');
if (!router.includes('assertSafeWebhookUrl') || !router.includes('validateUploadMetadata')) throw new Error('API must enforce webhook SSRF and upload metadata guards');
const devRuntime = await readFile('apps/api/src/dev-runtime.ts', 'utf8');
if (!devRuntime.includes('DEVELOPMENT_RUNTIME_FORBIDDEN_IN_PRODUCTION')) throw new Error('Development API runtime must be blocked in production');

const dockerfile = await readFile('infrastructure/docker/api.Dockerfile', 'utf8');
if (!dockerfile.includes('npm ci --ignore-scripts') || !dockerfile.includes('apps/api/server.mjs')) throw new Error('API container is not reproducibly bootstrapped');
const kubernetes = await readFile('infrastructure/kubernetes/base/api-deployment.yaml', 'utf8');
if (/:latest\b/.test(kubernetes)) throw new Error('Production manifests may not use latest tags');
if (!kubernetes.includes('registry.invalid/')) throw new Error('Provider-neutral manifest must remain fail-closed until release digest injection');

const vercelConfig = JSON.parse(await readFile('vercel.json', 'utf8'));
if (vercelConfig.buildCommand !== 'npm run web:build') throw new Error('Vercel must use the isolated public website build');
if (vercelConfig.outputDirectory !== 'build/public-site') throw new Error('Vercel output directory is incorrect');
const website = await readFile('apps/public-website/public/index.html', 'utf8');
if (!website.includes('Pilotplattform under utveckling')) throw new Error('Public website must not imply production readiness');
if (/\sstyle=/.test(website) || /<script(?![^>]*\ssrc=)/.test(website)) throw new Error('Public website must remain compatible with strict CSP');

const packageConfig = JSON.parse(await readFile('package.json', 'utf8'));
for (const command of ['dev','dev:api','dev:workers','db:up','db:migrate','db:verify','db:reset:test','test:unit','test:integration','test:e2e','test:security','test:accessibility','verify:sdk']) {
  if (!packageConfig.scripts?.[command]) throw new Error(`Missing root command: ${command}`);
}
console.log('repository verification: OK');
