import { access, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const source = new URL('../apps/public-website/public/', import.meta.url);
const output = new URL('../build/public-site/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const required = [
  'index.html',
  '404.html',
  'app.css',
  'app.js',
  'favicon.svg',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
  'assets/logo.svg',
  'assets/og-image.png',
  'sakerhet/index.html',
  'integritet/index.html',
  'tillganglighet/index.html',
  'kontakt/index.html',
];

for (const path of required) await access(new URL(path, output));

const htmlFiles = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) await walk(child);
    else if (extname(entry.name) === '.html') htmlFiles.push(child);
  }
}
await walk(output);

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const name = relative(output.pathname, file.pathname);
  if (!html.includes('<html lang="sv">')) throw new Error(`${name} saknar lang=sv`);
  if (!html.includes('name="viewport"')) throw new Error(`${name} saknar viewport`);
  if (/\sstyle=/.test(html)) throw new Error(`${name} innehåller inline style och bryter strikt CSP`);
  if (/<script(?![^>]*\ssrc=)/.test(html)) throw new Error(`${name} innehåller inline script`);

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (!target || target.startsWith('#') || target.startsWith('mailto:') || target.startsWith('http://') || target.startsWith('https://')) continue;
    const pathname = target.split('#')[0].split('?')[0];
    if (!pathname) continue;
    const local = pathname.startsWith('/') ? pathname.slice(1) : join(relative(output.pathname, new URL('.', file).pathname), pathname);
    const candidate = local.endsWith('/') ? `${local}index.html` : local;
    try { await access(new URL(candidate, output)); }
    catch { throw new Error(`${name} länkar till saknad lokal resurs: ${target}`); }
  }
}

console.log(`public website build: OK (${htmlFiles.length} HTML pages → build/public-site)`);
