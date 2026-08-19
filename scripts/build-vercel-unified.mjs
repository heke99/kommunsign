import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix, relative } from 'node:path';

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


// Portal JavaScript and CSS were served `private, no-store` because the filenames never changed,
// so there was no safe way to cache them: every navigation re-downloaded every asset. Deriving the
// filename from a hash of the contents makes a stale response impossible by construction, which is
// what lets vercel.json serve these immutable for a year. The HTML documents stay `no-store` --
// they are per-authenticated-host and they are what points at the current hash.
const FINGERPRINTED = /^(app|qr|office-upload)\.(js|css)$/;
// vercel.json rewrites this public prefix onto the auth portal's build directory.
const PATH_ALIASES = [['/auth-assets/', '__portals/auth/']];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function fingerprintAssets(root) {
  const hashedByPath = new Map();
  for await (const path of walk(root)) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const match = FINGERPRINTED.exec(name);
    if (!match) continue;
    const contents = await readFile(path);
    const digest = createHash('sha256').update(contents).digest('base64url').slice(0, 16);
    const hashedName = `${match[1]}.${digest}.${match[2]}`;
    await rename(path, join(dirname(path), hashedName));
    hashedByPath.set(posix.normalize(relative(root, path)), hashedName);
  }

  // Resolve a reference exactly the way the browser will, so a rewritten path always points at the
  // file that was actually hashed rather than at a same-named asset in another portal.
  const resolve = (reference, htmlPath) => {
    for (const [prefix, target] of PATH_ALIASES) {
      if (reference.startsWith(prefix)) return posix.normalize(target + reference.slice(prefix.length));
    }
    if (reference.startsWith('/')) return posix.normalize(reference.slice(1));
    return posix.normalize(posix.join(posix.dirname(posix.normalize(relative(root, htmlPath))), reference));
  };

  let rewritten = 0;
  for await (const htmlPath of walk(root)) {
    if (!htmlPath.endsWith('.html')) continue;
    const original = await readFile(htmlPath, 'utf8');
    const updated = original.replace(/(href|src)="([^"]+\.(?:js|css))"/g, (whole, attribute, reference) => {
      const hashedName = hashedByPath.get(resolve(reference, htmlPath));
      if (!hashedName) return whole;
      const prefix = reference.slice(0, reference.lastIndexOf('/') + 1);
      rewritten += 1;
      return `${attribute}="${prefix}${hashedName}"`;
    });
    if (updated !== original) await writeFile(htmlPath, updated, 'utf8');
  }

  // Every fingerprinted asset must be pointed at by something, or a portal is silently shipping a
  // page whose script 404s.
  if (rewritten < hashedByPath.size) {
    throw new Error(`fingerprinting: ${hashedByPath.size} assets hashed but only ${rewritten} references rewritten`);
  }
  return { assets: hashedByPath.size, references: rewritten };
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

const fingerprinted = await fingerprintAssets(outputRoot);

console.log(`Vercel unified build: ${Object.keys(sources).length} portaler i ${outputRoot}`);
console.log(`Vercel asset fingerprinting: ${fingerprinted.assets} filer, ${fingerprinted.references} referenser`);
console.log('Vercel root fallback: build/vercel/index.html');
