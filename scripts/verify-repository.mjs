import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = [
  'README.md','AGENTS.md','SECURITY.md','THREAT_MODEL.md','DATA_PROCESSING.md','LICENSE_POLICY.md',
  'docs/api/openapi.yaml','migrations/control/0001_control_plane.sql','migrations/data/0005_rls.sql',
  'upstream/manifests/source-inventory.yaml','docker-compose.yml','.github/workflows/ci.yml',
];
for (const path of required) await access(path);

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
if (workflow.includes('REPLACE_WITH') || /uses:\s+[^@]+@v\d/.test(workflow)) throw new Error('GitHub Actions must be pinned to full SHAs');

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
const api = await readFile('docs/api/openapi.yaml', 'utf8');
if (api.includes('tenantId:') && !api.includes('Tenant is derived')) throw new Error('OpenAPI may not accept arbitrary tenantId');
console.log('repository verification: OK');
