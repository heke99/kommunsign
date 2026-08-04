import { resolveAny } from 'node:dns/promises';

const checks = [
  { name: 'Publik webbplats', url: 'https://kommunsign.se/', title: 'KommunSign – säker e-underskrift', marker: 'id="main"' },
  { name: 'Ansökan', url: 'https://kommunsign.se/ansok/', marker: '<html lang="sv">' },
  { name: 'Inloggning', url: 'https://app.kommunsign.se/login/', title: 'Logga in – Kommunsign', marker: 'id="login-form"' },
  { name: 'Verksamhetsportal', url: 'https://app.kommunsign.se/', title: 'Kommunsign – verksamhetsportal', marker: 'id="protected-app" hidden' },
  { name: 'Administration', url: 'https://admin.kommunsign.se/', title: 'Kommunsign administration', marker: 'id="protected-app" hidden' },
];

let failures = 0;

for (const hostname of ['kommunsign.se', 'app.kommunsign.se', 'admin.kommunsign.se']) {
  try {
    const records = await resolveAny(hostname);
    console.log(`DNS PASS ${hostname}: ${records.map((entry) => entry.address ?? entry.value ?? entry.exchange ?? entry.type).join(', ')}`);
  } catch (error) {
    failures += 1;
    console.error(`DNS FAIL ${hostname}: ${error.code ?? error.message}`);
  }
}

for (const check of checks) {
  try {
    const response = await fetch(check.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Kommunsign-live-verifier/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    const title = body.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '';
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    if (check.title && !title.includes(check.title)) throw new Error(`UNEXPECTED_TITLE:${title || 'missing'}`);
    if (check.marker && !body.includes(check.marker)) throw new Error(`EXPECTED_MARKER_MISSING:${check.marker}`);
    console.log(`HTTP PASS ${check.name}: ${response.status} ${response.url} ${title ? `— ${title}` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`HTTP FAIL ${check.name}: ${error.message}`);
  }
}

if (failures) {
  console.error(`Live web verification failed with ${failures} problem(s).`);
  process.exit(1);
}
console.log('Live web verification passed.');
