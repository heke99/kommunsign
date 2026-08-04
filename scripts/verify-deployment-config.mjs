import { access, readFile } from 'node:fs/promises';

const failures = [];
const requireMatch = (source, pattern, message) => { if (!pattern.test(source)) failures.push(message); };
const rejectMatch = (source, pattern, message) => { if (pattern.test(source)) failures.push(message); };

const vercel = JSON.parse(await readFile('vercel.json', 'utf8'));
if (vercel.outputDirectory !== 'build/vercel') failures.push('Vercel outputDirectory måste vara build/vercel');
if (Array.isArray(vercel.redirects) && vercel.redirects.some((item) => /(?:www\.)?kommunsign\.se/i.test(JSON.stringify(item)))) {
  failures.push('Apex/www-redirect får inte dubbleras i vercel.json; den konfigureras endast i Vercel Domains');
}
const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
const routeText = JSON.stringify(routes);
for (const expected of ['kommunsign.se','app.kommunsign.se','admin.kommunsign.se','/__portals/tenant/index.html','/__portals/admin/index.html','/__portals/auth/index.html']) {
  if (!routeText.includes(expected)) failures.push(`Vercel-routing saknar ${expected}`);
}
if (!routes.some((item) => item.handle === 'filesystem')) failures.push('Vercel-routing saknar filesystem-fas');

for (const path of [
  'build/vercel/index.html',
  'build/vercel/ansok/index.html',
  'build/vercel/signera/index.html',
  'build/vercel/verifiera/index.html',
  'build/vercel/__portals/tenant/index.html',
  'build/vercel/__portals/admin/index.html',
  'build/vercel/__portals/auth/index.html',
]) {
  try { await access(path); } catch { failures.push(`Buildoutput saknar ${path}`); }
}

for (const [portal, expected] of [
  ['tenant-portal', /id="auth-gate"[\s\S]*id="protected-app" hidden/],
  ['platform-admin', /id="auth-gate"[\s\S]*id="protected-app" hidden/],
]) {
  const html = await readFile(`apps/${portal}/public/index.html`, 'utf8');
  requireMatch(html, expected, `${portal} måste vara dold tills servern verifierat sessionen`);
  const app = await readFile(`apps/${portal}/public/app.js`, 'utf8');
  requireMatch(app, /\/v1\/auth\/session/, `${portal} måste verifiera /v1/auth/session`);
  requireMatch(app, /AUTH_SESSION_INVALID|showSessionFailure/, `${portal} måste stänga vid saknad/ogiltig session`);
}

for (const [portal, prefixes] of [
  ['onboarding-portal', ['/ansok/app.css','/ansok/app.js']],
  ['signer-portal', ['/signera/app.css','/signera/app.js']],
  ['verification-portal', ['/verifiera/app.css','/verifiera/app.js']],
]) {
  const html = await readFile(`apps/${portal}/public/index.html`, 'utf8');
  for (const prefix of prefixes) if (!html.includes(prefix)) failures.push(`${portal} måste använda absolut asset-sökväg ${prefix}`);
}

for (const [name, path, command] of [
  ['API','infrastructure/docker/api.Dockerfile','apps/api/server.mjs'],
  ['worker','infrastructure/docker/workers.Dockerfile','dist/apps/workers/src/production-runner.js'],
]) {
  const dockerfile = await readFile(path, 'utf8');
  requireMatch(dockerfile, /COPY --from=build[^\n]*\/app\/package\.json/, `${name}-imagen måste innehålla package.json för ESM-runtime`);
  requireMatch(dockerfile, /COPY --from=build[^\n]*\/app\/node_modules/, `${name}-imagen måste innehålla produktionsberoenden`);
  requireMatch(dockerfile, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}-imagen startar inte rätt produktionskommando`);
  rejectMatch(dockerfile, /dev-runtime|dev-runner/, `${name}-imagen får inte starta utvecklingsruntime`);
}

for (const path of [
  'infrastructure/railway/api.railway.json',
  'infrastructure/railway/workers.railway.json',
  'infrastructure/railway/validation-service.railway.json',
  'infrastructure/railway/runtime-services.json',
]) {
  try { JSON.parse(await readFile(path, 'utf8')); } catch { failures.push(`${path} saknas eller är ogiltig JSON`); }
}

const gateway = await readFile('packages/tenant-gateway/src/index.ts', 'utf8');
requireMatch(gateway, /trustedProxyProvider: 'vercel' \| 'cloudflare' \| 'railway' \| 'none'/, 'Tenant gateway saknar Railway som betrodd proxyprovider');
requireMatch(gateway, /x-railway-request-id[\s\S]*x-real-ip/, 'Railway-proxyverifiering saknar Railway-headerbindning');

const validationClient = await readFile('packages/validation-client/src/index.ts', 'utf8');
requireMatch(validationClient, /\.railway\.internal/, 'Valideringsklienten tillåter inte Railways privata nät');

if (failures.length) {
  console.error(`Deploymentkonfigurationen har ${failures.length} fel:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Deploymentkonfiguration: OK (Vercel root/routing, auth-gates, images och Railway-tjänster).');
