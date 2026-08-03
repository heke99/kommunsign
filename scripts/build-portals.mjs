import { cp, mkdir, readFile } from 'node:fs/promises';
const portals = ['auth-portal','onboarding-portal','platform-admin','tenant-portal','signer-portal','verification-portal'];
await mkdir('build/portals', { recursive: true });
for (const portal of portals) {
  const root = `apps/${portal}/public`;
  const html = await readFile(`${root}/index.html`, 'utf8');
  if (!html.includes('<html lang="sv">')) throw new Error(`${portal}: lang=sv saknas`);
  if (/\sstyle=/.test(html) || /<script(?![^>]*\ssrc=)/.test(html)) throw new Error(`${portal}: strict CSP bryts`);
  await cp(root, `build/portals/${portal}`, { recursive: true });
}
console.log(`portal build: ${portals.length} portals`);
