import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const outputRoot = 'build/vercel';
const sources = {
  public: 'apps/public-website/public',
  apply: 'apps/onboarding-portal/public',
  admin: 'apps/platform-admin/public',
  auth: 'apps/auth-portal/public',
  tenant: 'apps/tenant-portal/public',
  sign: 'apps/signer-portal/public',
  verify: 'apps/verification-portal/public',
};

async function validatePortal(name, source) {
  const html = await readFile(`${source}/index.html`, 'utf8');
  if (!html.includes('<html lang="sv">')) throw new Error(`${source}: lang=sv saknas`);
  if (/\sstyle=/.test(html) || /<script(?![^>]*\ssrc=)/.test(html)) {
    throw new Error(`${source}: strict CSP bryts`);
  }
  return name;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(`${outputRoot}/__portals`, { recursive: true });
await Promise.all(Object.entries(sources).map(([name, source]) => validatePortal(name, source)));

// Keep every portal below an internal, non-public path. No index.html or shared
// assets are written to the deployment root. This is intentional: Vercel checks
// the filesystem before applying rewrites, so a root index.html would otherwise
// override hostname-based routing for app.kommunsign.se and admin.kommunsign.se.
await Promise.all(
  Object.entries(sources).map(([name, source]) =>
    cp(source, `${outputRoot}/__portals/${name}`, { recursive: true }),
  ),
);

await writeFile(
  `${outputRoot}/deployment.json`,
  `${JSON.stringify({
    product: 'Kommunsign',
    topology: 'single-vercel-web-project',
    publicOrigin: 'https://kommunsign.se',
    publicPaths: ['/ansok/', '/signera/', '/verifiera/'],
    authenticatedHosts: ['app.kommunsign.se', 'admin.kommunsign.se'],
    portals: Object.keys(sources),
    routingInvariant: 'deployment-root-must-not-contain-index-html',
  }, null, 2)}\n`,
  'utf8',
);

console.log(`Vercel unified build: ${Object.keys(sources).length} portaler i ${outputRoot}/__portals`);
console.log('Vercel routing invariant: ingen root index.html; all trafik väljs av rewrites');
