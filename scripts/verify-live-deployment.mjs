const webChecks = [
  { name: 'Publik webbplats', url: process.env.PUBLIC_WEBSITE_URL || 'https://kommunsign.se/', title: /KommunSign|Kommunsign/i, portal: 'public' },
  { name: 'Ansökan', url: process.env.ONBOARDING_PORTAL_URL || 'https://kommunsign.se/ansok/', title: /ansök|Kommunsign/i, portal: 'apply' },
  { name: 'Verksamhetsportal', url: process.env.TENANT_DISCOVERY_URL || 'https://app.kommunsign.se/', title: /verksamhetsportal/i, portal: 'tenant', authGate: true },
  { name: 'Inloggning', url: process.env.AUTH_LOGIN_URL || 'https://app.kommunsign.se/login/', title: /Logga in/i, portal: 'auth' },
  { name: 'Administration', url: process.env.PLATFORM_ADMIN_URL || 'https://admin.kommunsign.se/', title: /administration/i, portal: 'admin', authGate: true },
];
const verifyApi = (process.env.VERIFY_API ?? 'true').toLowerCase() === 'true';
const failures = [];

async function fetchFollowingRedirects(url, maximum = 8) {
  const visited = [];
  let current = new URL(url);
  for (let index = 0; index <= maximum; index += 1) {
    const key = current.href;
    if (visited.includes(key)) throw new Error(`REDIRECT_LOOP:${[...visited, key].join(' -> ')}`);
    visited.push(key);
    const response = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'Kommunsign deployment verifier/0.2.0' } });
    if (![301,302,303,307,308].includes(response.status)) return { response, visited, finalUrl: current.href };
    const location = response.headers.get('location');
    if (!location) throw new Error(`REDIRECT_WITHOUT_LOCATION:${response.status}`);
    current = new URL(location, current);
  }
  throw new Error(`TOO_MANY_REDIRECTS:${visited.join(' -> ')}`);
}

for (const check of webChecks) {
  try {
    const { response, visited, finalUrl } = await fetchFollowingRedirects(check.url);
    const body = await response.text();
    const portal = response.headers.get('x-kommunsign-portal');
    if (response.status !== 200) failures.push(`${check.name}: HTTP ${response.status} (${finalUrl})`);
    if (!check.title.test(body)) failures.push(`${check.name}: fel portalinnehåll eller titel`);
    if (portal && portal !== check.portal) failures.push(`${check.name}: X-Kommunsign-Portal=${portal}, väntade ${check.portal}`);
    if (check.authGate && (!body.includes('id="auth-gate"') || !body.includes('id="protected-app" hidden'))) failures.push(`${check.name}: skyddat innehåll är inte fail-closed`);
    console.log(`${check.name}: HTTP ${response.status}, ${visited.length - 1} redirect(s), portal=${portal ?? 'header saknas'}, url=${finalUrl}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    failures.push(`${check.name}: ${message}`);
    console.error(`${check.name}: ${message}`);
  }
}

if (verifyApi) {
  const api = (process.env.API_BASE_URL || 'https://api.kommunsign.se').replace(/\/$/, '');
  for (const path of ['/health/live','/health/ready']) {
    try {
      const response = await fetch(`${api}${path}`, { redirect: 'manual', headers: { accept: 'application/json' } });
      const body = await response.text();
      console.log(`API ${path}: HTTP ${response.status} ${body.slice(0, 180)}`);
      if (path === '/health/live' && response.status !== 200) failures.push(`API ${path}: ska vara 200`);
      if (path === '/health/ready' && response.status !== 200) failures.push(`API ${path}: runtime är inte redo`);
    } catch (cause) {
      failures.push(`API ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

if (failures.length) {
  console.error(`Liveverifieringen misslyckades:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Liveverifiering: PASS.');
