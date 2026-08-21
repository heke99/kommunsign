import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = [
  'README.md','AGENTS.md','SECURITY.md','THREAT_MODEL.md','DATA_PROCESSING.md','LICENSE_POLICY.md',
  'docs/api/openapi.yaml','migrations/control/0001_control_plane.sql','migrations/control/0003_domain_and_profile_integrity.sql',
  'migrations/control/0004_versioned_configuration_integrity.sql','migrations/control/0005_auth_domain_and_break_glass_runtime.sql','migrations/data/0005_rls.sql',
  'migrations/data/0009_integrity_and_worker_recovery.sql','migrations/data/0010_immutability_and_evidence_states.sql','migrations/data/0011_upload_notification_and_invitation_runtime.sql',
  'upstream/manifests/source-inventory.yaml','upstream/manifests/reuse-map.json',
  'upstream/permissions/PERMISSION_EVIDENCE_REQUIRED.md','docker-compose.yml','.github/workflows/ci.yml',
  'apps/api/server.mjs','infrastructure/docker/api.Dockerfile','infrastructure/docker/workers.Dockerfile','.dockerignore','SBOM.cdx.json','PROVENANCE_REPORT.txt',
  'docs/operations/synchronization.md','docs/operations/vercel-deployment.md','docs/architecture/review-2026-08-02.md',
  'docs/architecture/current-state-verified.md','docs/architecture/target-architecture.md','docs/architecture/remaining-implementation-plan.md','docs/architecture/onboarding-architecture.md','docs/verification/requirements-traceability.md','docs/verification/production-readiness.md',
  'vercel.json','apps/public-website/public/index.html','apps/public-website/public/app.css','scripts/build-public-site.mjs','scripts/build-portals.mjs',
  'apps/onboarding-portal/public/index.html','apps/onboarding-portal/public/app.js','apps/auth-portal/public/index.html','apps/auth-portal/public/app.js','apps/tenant-portal/public/app.js','apps/platform-admin/public/app.js','apps/signer-portal/public/app.js','apps/verification-portal/public/app.js',
  'migrations/control/0006_onboarding_and_activation.sql','migrations/control/0011_managed_accounts_and_password_sessions.sql','migrations/data/0014_managed_organization_accounts.sql','tests/sql/onboarding-control.sql','apps/api/src/onboarding-router.ts','apps/api/src/production-runtime.ts','apps/workers/src/production-runner.ts','packages/onboarding/src/index.ts','packages/readiness/src/index.ts',
  'packages/branding/src/index.ts','packages/custom-domains/src/index.ts','packages/uploads/src/index.ts',
  'sdks/typescript/src/client.ts','sdks/csharp/src/KommunSignClient.cs','sdks/java/src/main/java/se/kommunsign/sdk/KommunSignClient.java','scripts/verify-sdk-sync.mjs',
  'scripts/verify-deployment-config.mjs','scripts/verify-live-deployment.mjs','RAILWAY_API_RUNTIME_SETUP.md','COMPLETE_WEB_API_FIX_REPORT.md',
  'infrastructure/railway/api.railway.json','infrastructure/railway/workers.railway.json','infrastructure/railway/validation-service.railway.json','infrastructure/railway/runtime-services.json',
  'infrastructure/railway/shared.runtime.env.example','infrastructure/railway/api.env.example','infrastructure/railway/workers.env.example','infrastructure/railway/validation-service.env.example',
  'services/pom.xml','services/commons/pom.xml','services/signservice/pom.xml','services/validation-service/pom.xml','services/integration-tests/pom.xml',
  'scripts/build-java-maven.sh','docs/architecture/adr/0004-sweden-connect-signing-backend.md',
  'infrastructure/railway/signservice.railway.json','infrastructure/railway/signservice.env.example',
  'infrastructure/docker/signservice.Dockerfile','infrastructure/docker/validation-service.Dockerfile',
];
for (const path of required) await access(path);

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
if (workflow.includes('REPLACE_WITH') || /uses:\s+[^@]+@v\d/.test(workflow)) throw new Error('GitHub Actions must be pinned to full SHAs');
if (/run:\s+echo\s+["'](?:Run|Generate)/.test(workflow)) throw new Error('CI contains a placeholder security step');

// The signing service holds key material. If it were ever published, the blast
// radius of any other bug in it would be the whole signing chain, so its being
// private is an invariant rather than a deployment preference.
const runtimeServices = JSON.parse(await readFile('infrastructure/railway/runtime-services.json', 'utf8'));
const signService = runtimeServices.services.find((service) => service.name === 'signservice');
if (!signService) throw new Error('signservice must be a declared runtime service');
if (signService.public !== false) throw new Error('signservice must never be publicly exposed');
if (signService.customDomain) throw new Error('signservice must not have a public domain');

// A SNAPSHOT in the build that signs municipal documents means the bytes that
// produced a signature cannot be reconstructed later.
for (const pom of ['services/pom.xml','services/signservice/pom.xml','services/validation-service/pom.xml','services/commons/pom.xml','services/integration-tests/pom.xml']) {
  const contents = await readFile(pom, 'utf8');
  // Match version elements only. The poms mention SNAPSHOT in the enforcer rule
  // that forbids it, and a substring check would flag that as the thing it bans.
  if (/<version>[^<]*SNAPSHOT[^<]*<\/version>/.test(contents)) throw new Error(`${pom} must not reference SNAPSHOT versions`);
}

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
const databaseWrapper = await readFile('packages/database/src/index.ts', 'utf8');
for (const setting of ['app.tenant_id','app.actor_id','app.request_id','app.auth_method']) {
  if (!databaseWrapper.includes(setting)) throw new Error(`Tenant transaction wrapper lacks ${setting}`);
}
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


const onboardingMigration = await readFile('migrations/control/0006_onboarding_and_activation.sql', 'utf8');
for (const marker of ['next_onboarding_application_reference','guard_onboarding_application_update','prevent_activation_self_approval','tenant_readiness_results','tenant_provisioning_steps']) {
  if (!onboardingMigration.includes(marker)) throw new Error(`Onboarding migration lacks ${marker}`);
}
const onboardingRouter = await readFile('apps/api/src/onboarding-router.ts', 'utf8');
for (const marker of ['/v1/onboarding/applications','/v1/platform/onboarding/applications','INVALID_APPLICATION_STATE_TRANSITION']) {
  if (!onboardingRouter.includes(marker)) throw new Error(`Onboarding API lacks ${marker}`);
}
const productionRuntime = await readFile('apps/api/src/production-runtime.ts', 'utf8');
if (!productionRuntime.includes('KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE') || !productionRuntime.includes('DEVELOPMENT_RUNTIME_FORBIDDEN_IN_PRODUCTION')) throw new Error('Production API bootstrap must fail closed without reviewed adapters');
const productionWorker = await readFile('apps/workers/src/production-runner.ts', 'utf8');
if (!productionWorker.includes('KOMMUNSIGN_WORKER_ADAPTER_MODULE') || !productionWorker.includes('DEVELOPMENT_WORKER_FORBIDDEN_IN_PRODUCTION')) throw new Error('Production worker must fail closed without reviewed adapters');
const workerDockerfile = await readFile('infrastructure/docker/workers.Dockerfile', 'utf8');
if (workerDockerfile.includes('dev-runner') || !workerDockerfile.includes('production-runner')) throw new Error('Production worker image may not start the development runner');
if (!workerDockerfile.includes('/app/package.json') || !workerDockerfile.includes('/app/node_modules')) throw new Error('Production worker image must retain ESM metadata and runtime dependencies');
const server = await readFile('apps/api/server.mjs', 'utf8');
if (!server.includes('x-kommunsign-application-token') || !server.includes('PATCH')) throw new Error('API CORS contract must support onboarding auth and draft updates');

const api = await readFile('docs/api/openapi.yaml', 'utf8');
if (api.includes('tenantId:') && !api.includes('Organization context is derived')) throw new Error('OpenAPI may not accept arbitrary organization context');
if (!api.includes('additionalProperties: false')) throw new Error('Create payload must reject unknown fields');
if ((api.match(/x-kommunsign-implementation-status: runtime/g) ?? []).length < 18) throw new Error('OpenAPI must expose all required runtime operations');
if (api.includes('x-kommunsign-implementation-status: contract-only')) throw new Error('Required OpenAPI operations may not remain contract-only');
for (const operation of ['createOnboardingApplication','submitOnboardingApplication','approveOnboardingApplication','provisionApprovedApplication','approveTenantActivation']) {
  if (!api.includes(`operationId: ${operation}`)) throw new Error(`OpenAPI onboarding operation missing: ${operation}`);
}
const router = await readFile('apps/api/src/router.ts', 'utf8');
if (router.includes("cause instanceof Error ? cause.message")) throw new Error('API must not return internal exception messages');
if (!router.includes("await dependencies.authorize")) throw new Error('API routes must pass through authorization');
if (!router.includes('assertSafeWebhookUrl') || !router.includes('validateUploadMetadata')) throw new Error('API must enforce webhook SSRF and upload metadata guards');
const devRuntime = await readFile('apps/api/src/dev-runtime.ts', 'utf8');
if (!devRuntime.includes('DEVELOPMENT_RUNTIME_FORBIDDEN_IN_PRODUCTION')) throw new Error('Development API runtime must be blocked in production');

const dockerfile = await readFile('infrastructure/docker/api.Dockerfile', 'utf8');
if (!dockerfile.includes('npm ci --ignore-scripts') || !dockerfile.includes('apps/api/server.mjs')) throw new Error('API container is not reproducibly bootstrapped');
if (!dockerfile.includes('/app/package.json') || !dockerfile.includes('/app/node_modules')) throw new Error('API image must retain ESM metadata and runtime dependencies');

// The image once copied server.mjs by name while server.mjs imported siblings beside it. The
// container then crashlooped on ERR_MODULE_NOT_FOUND at boot, and because it never became healthy
// the platform kept serving the previous image -- so the deployment looked stuck rather than
// broken, and nothing in the repository disagreed. Every sibling module the entrypoint imports must
// be reachable in the runtime stage, checked here rather than discovered in production.
const serverEntrypoint = await readFile('apps/api/server.mjs', 'utf8');
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
for (const [, specifier] of serverEntrypoint.matchAll(/^import[^']*'(\.\/[^']+\.mjs)'/gm)) {
  const name = specifier.slice(2);
  const copied = runtimeStage.includes(`/app/apps/api/${name}`) || /COPY[^\n]*\/app\/apps\/api\/\*\.mjs/.test(runtimeStage);
  if (!copied) throw new Error(`API image does not copy ${name}, which apps/api/server.mjs imports`);
  await readFile(`apps/api/${name}`, 'utf8');
}
const kubernetes = await readFile('infrastructure/kubernetes/base/api-deployment.yaml', 'utf8');
if (/:latest\b/.test(kubernetes)) throw new Error('Production manifests may not use latest tags');
if (!kubernetes.includes('registry.invalid/')) throw new Error('Provider-neutral manifest must remain fail-closed until release digest injection');

const vercelConfig = JSON.parse(await readFile('vercel.json', 'utf8'));
if (vercelConfig.buildCommand !== 'npm run build:vercel') throw new Error('Vercel must use the unified portal build');
if (vercelConfig.outputDirectory !== 'build/vercel') throw new Error('Vercel unified output directory is incorrect');
const requiredPortalHosts = ['admin.kommunsign.se','app.kommunsign.se'];
const configuredRoutes = [
  ...(vercelConfig.rewrites ?? []),
  ...(vercelConfig.routes ?? []),
];
for (const host of requiredPortalHosts) {
  if (!configuredRoutes.some((entry) => entry.has?.some((condition) => condition.type === 'host' && condition.value === host))) {
    throw new Error(`Vercel unified routing is missing ${host}`);
  }
}
if (!vercelConfig.routes?.some((entry) => entry.handle === 'filesystem')) {
  throw new Error('Vercel routing must explicitly preserve the public filesystem after host routing');
}
const vercelBuild = await readFile('scripts/build-vercel-unified.mjs', 'utf8');
if (!vercelBuild.includes("await cp(sources.public, outputRoot")) throw new Error('Vercel deployment must publish the public website at the output root');
if (!vercelBuild.includes("`${outputRoot}/ansok`")) throw new Error('Vercel deployment must publish onboarding under /ansok/');
if (!vercelBuild.includes("`${outputRoot}/signera`")) throw new Error('Vercel deployment must publish signing under /signera/');
if (!vercelBuild.includes("`${outputRoot}/verifiera`")) throw new Error('Vercel deployment must publish verification under /verifiera/');
const tenantPortalHtml = await readFile('apps/tenant-portal/public/index.html', 'utf8');
const adminPortalHtml = await readFile('apps/platform-admin/public/index.html', 'utf8');
for (const [name, html] of [['tenant', tenantPortalHtml], ['admin', adminPortalHtml]]) {
  if (!html.includes('id="auth-gate"') || !html.includes('id="protected-app" hidden')) throw new Error(`${name} portal must remain hidden until session verification`);
}
const tenantPortalScript = await readFile('apps/tenant-portal/public/app.js', 'utf8');
const adminPortalScript = await readFile('apps/platform-admin/public/app.js', 'utf8');
for (const [name, source] of [['tenant', tenantPortalScript], ['admin', adminPortalScript]]) {
  if (!source.includes('/v1/auth/session') || !source.includes('showSessionFailure')) throw new Error(`${name} portal session gate is incomplete`);
}
const gatewaySource = await readFile('packages/tenant-gateway/src/index.ts', 'utf8');
if (!gatewaySource.includes("'railway'") || !gatewaySource.includes('x-railway-request-id') || !gatewaySource.includes('x-real-ip')) throw new Error('Railway trusted proxy support is incomplete');
const runtimeManifest = JSON.parse(await readFile('infrastructure/railway/runtime-services.json', 'utf8'));
if (runtimeManifest.region !== 'europe-west4-drams3a') throw new Error('Railway runtime manifest must use the current EU West region identifier');
for (const service of ['api','workers','validation-service','clamav','gotenberg','verapdf']) {
  if (!runtimeManifest.services?.some((entry) => entry.name === service)) throw new Error(`Railway runtime manifest lacks ${service}`);
}
const website = await readFile('apps/public-website/public/index.html', 'utf8');
if (!website.includes('Säker signering med BankID')) throw new Error('Public website must describe the production product clearly');
if (/Pilotplattform under utveckling|inte produktionsklar|ej redo|under utveckling/i.test(website)) throw new Error('Public website contains obsolete development messaging');
const applicationLanding = await readFile('apps/public-website/public/ansok/index.html', 'utf8');
if (!applicationLanding.includes('/ansok/')) throw new Error('Application landing page must route to /ansok/');
if (/\sstyle=/.test(website) || /<script(?![^>]*\ssrc=)/.test(website)) throw new Error('Public website must remain compatible with strict CSP');

const packageConfig = JSON.parse(await readFile('package.json', 'utf8'));
for (const command of ['dev','dev:api','dev:workers','db:up','db:migrate','db:verify','db:reset:test','test:unit','test:integration','test:e2e','test:security','test:accessibility','verify:sdk','verify:env-contract','verify:env','auth:bootstrap-superadmin','verify:deployment-config','verify:deployment:live']) {
  if (!packageConfig.scripts?.[command]) throw new Error(`Missing root command: ${command}`);
}
console.log('repository verification: OK');
