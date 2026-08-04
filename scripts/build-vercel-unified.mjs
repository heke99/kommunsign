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
await mkdir(outputRoot, { recursive: true });
await Promise.all(Object.entries(sources).map(([name, source]) => validatePortal(name, source)));

// The public website is copied to the deployment root. This guarantees that
// both the generated *.vercel.app URL and kommunsign.se have a real index.html
// without depending on a Host rewrite.
await cp(sources.public, outputRoot, { recursive: true });

// Public flows share kommunsign.se and use explicit paths.
await rm(`${outputRoot}/ansok`, { recursive: true, force: true });
await cp(sources.apply, `${outputRoot}/ansok`, { recursive: true });
await cp(sources.sign, `${outputRoot}/signera`, { recursive: true });
await cp(sources.verify, `${outputRoot}/verifiera`, { recursive: true });

// Authenticated boundaries retain separate hostnames for host-bound cookies.
await mkdir(`${outputRoot}/__portals`, { recursive: true });
await cp(sources.admin, `${outputRoot}/__portals/admin`, { recursive: true });
await cp(sources.auth, `${outputRoot}/__portals/auth`, { recursive: true });
await cp(sources.tenant, `${outputRoot}/__portals/tenant`, { recursive: true });

await writeFile(
  `${outputRoot}/deployment.json`,
  `${JSON.stringify({
    product: 'Kommunsign',
    topology: 'single-vercel-web-project',
    publicOrigin: 'https://kommunsign.se',
    publicPaths: ['/ansok/', '/signera/', '/verifiera/'],
    authenticatedHosts: ['app.kommunsign.se', 'admin.kommunsign.se'],
    portals: Object.keys(sources),
  }, null, 2)}\n`,
  'utf8',
);

console.log(`Vercel unified build: ${Object.keys(sources).length} portaler i ${outputRoot}`);
console.log('Vercel root fallback: build/vercel/index.html');
