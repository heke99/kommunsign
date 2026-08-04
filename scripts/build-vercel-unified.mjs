import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const outputRoot = 'build/vercel';
const portals = [
  ['public', 'apps/public-website/public'],
  ['apply', 'apps/onboarding-portal/public'],
  ['admin', 'apps/platform-admin/public'],
  ['auth', 'apps/auth-portal/public'],
  ['tenant', 'apps/tenant-portal/public'],
  ['sign', 'apps/signer-portal/public'],
  ['verify', 'apps/verification-portal/public'],
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(`${outputRoot}/__portals`, { recursive: true });

for (const [target, source] of portals) {
  const html = await readFile(`${source}/index.html`, 'utf8');
  if (!html.includes('<html lang="sv">')) throw new Error(`${source}: lang=sv saknas`);
  if (/\sstyle=/.test(html) || /<script(?![^>]*\ssrc=)/.test(html)) {
    throw new Error(`${source}: strict CSP bryts`);
  }
  await cp(source, `${outputRoot}/__portals/${target}`, { recursive: true });
}

await writeFile(
  `${outputRoot}/deployment.json`,
  `${JSON.stringify({ product: 'Kommunsign', topology: 'single-vercel-web-project', portals: portals.map(([name]) => name) }, null, 2)}\n`,
  'utf8',
);

console.log(`Vercel unified build: ${portals.length} portaler i ${outputRoot}`);
