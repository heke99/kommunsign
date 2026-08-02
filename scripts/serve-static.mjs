import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'apps/public-website/public');
const port = Number(process.argv[3] ?? process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ogiltig port');

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.xml', 'application/xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'], ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0] ?? '/');
  const candidate = resolve(root, `.${normalize(decoded)}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

async function existingFile(candidate) {
  const attempts = [candidate];
  if (candidate.endsWith(sep) || extname(candidate) === '') attempts.push(join(candidate, 'index.html'));
  for (const path of attempts) {
    try { if ((await stat(path)).isFile()) return path; } catch { /* continue */ }
  }
  return null;
}

const server = createServer(async (request, response) => {
  try {
    const requested = safePath(request.url ?? '/');
    if (!requested) { response.writeHead(400).end('Bad request'); return; }
    const file = await existingFile(requested) ?? join(root, '404.html');
    await access(file);
    const status = file.endsWith('404.html') ? 404 : 200;
    response.writeHead(status, {
      'Content-Type': mimeTypes.get(extname(file)) ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Serverfel');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`KommunSign webb: http://localhost:${port}`);
  console.log(`Serverar: ${root}`);
});
