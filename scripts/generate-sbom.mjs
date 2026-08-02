import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const components = [];
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || !metadata || typeof metadata !== 'object') continue;
  const name = path.replace(/^node_modules\//, '');
  if (!metadata.version) continue;
  components.push({
    type: 'library',
    'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${metadata.version}`,
    name,
    version: metadata.version,
    purl: `pkg:npm/${encodeURIComponent(name)}@${metadata.version}`,
    scope: metadata.dev ? 'optional' : 'required',
  });
}
components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
const serialSeed = JSON.stringify({ name: packageJson.name, version: packageJson.version, components });
const serial = createHash('sha256').update(serialSeed).digest('hex');
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${serial.slice(0,8)}-${serial.slice(8,12)}-4${serial.slice(13,16)}-8${serial.slice(17,20)}-${serial.slice(20,32)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'kommunsign-sbom-generator', version: packageJson.version }] },
    component: { type: 'application', name: packageJson.name, version: packageJson.version },
  },
  components,
};
await mkdir('build/sbom', { recursive: true });
await writeFile('build/sbom/kommunsign.cdx.json', `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`SBOM generated: build/sbom/kommunsign.cdx.json (${components.length} dependency components)`);
