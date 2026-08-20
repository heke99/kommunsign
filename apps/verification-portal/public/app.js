const idForm = document.getElementById('id-form');
const packageForm = document.getElementById('package-form');
const idStatus = document.getElementById('id-status');
const packageStatus = document.getElementById('package-status');
const idResult = document.getElementById('id-result');
const packageResult = document.getElementById('package-result');
const documents = document.getElementById('documents');
const documentList = document.getElementById('document-list');

function apiBase() {
  const configured = document.querySelector('meta[name="kommunsign-api-base"]')?.content?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return 'https://api.kommunsign.se';
  return 'http://127.0.0.1:8080';
}

function setStatus(element, message, kind = '') {
  element.textContent = message;
  element.className = `status${kind ? ` ${kind}` : ''}`;
}

function renderDefinitionList(element, entries) {
  element.replaceChildren();
  for (const [label, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    element.append(dt, dd);
  }
}

function safeMessage(data, response) {
  return messageFor(data?.error?.code || data?.code || `HTTP_${response.status}`);
}

idForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  idResult.replaceChildren();
  documentList.replaceChildren();
  documents.classList.add('hidden');
  const id = document.getElementById('verification-id').value.trim();
  if (!/^[A-Za-z0-9_-]{12,160}$/.test(id)) {
    setStatus(idStatus, 'Verifierings-ID har ogiltigt format.', 'error');
    return;
  }
  setStatus(idStatus, 'Hämtar verifieringsresultat…');
  try {
    const response = await fetch(`${apiBase()}/v1/public/verifications/${encodeURIComponent(id)}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeMessage(data, response));
    const passed = data.status === 'verified' || data.verified === true;
    setStatus(idStatus, passed ? 'Beviset är verifierat.' : 'Beviset är inte verifierat.', passed ? 'success' : 'error');
    renderDefinitionList(idResult, [
      ['Status', data.status || (data.verified ? 'verified' : 'failed')],
      ['Organisation', data.organizationName || data.organization],
      ['Ärende', data.caseReference],
      ['Antal signerare', data.signerCount],
      ['Signeringstid', data.signedAt || data.completedAt],
      ['Verifieringsmotor', data.verifierEngine || data.verificationEngine],
      ['Policyversion', data.verifierPolicyVersion || data.verificationPolicyVersion],
      ['Paketets SHA-256', data.packageSha256 || data.packageHash]
    ]);
    const rows = Array.isArray(data.documents) ? data.documents : [];
    for (const item of rows) {
      const li = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = item.displayName || item.name || 'Handling';
      const hash = document.createElement('code');
      hash.textContent = item.sha256 || 'Hash saknas';
      li.append(name, document.createElement('br'), hash);
      documentList.append(li);
    }
    documents.classList.toggle('hidden', rows.length === 0);
  } catch (error) {
    setStatus(idStatus, `Verifieringen kunde inte hämtas: ${error.message}`, 'error');
  }
});

packageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  packageResult.replaceChildren();
  const file = document.getElementById('package').files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.zip')) {
    setStatus(packageStatus, 'Välj ett evidenspaket i ZIP-format.', 'error');
    return;
  }
  const maxBytes = 150 * 1024 * 1024;
  if (file.size <= 0 || file.size > maxBytes) {
    setStatus(packageStatus, 'Paketets storlek ligger utanför tillåtet intervall.', 'error');
    return;
  }
  setStatus(packageStatus, 'Beräknar paketets SHA-256…');
  const bytes = await file.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  renderDefinitionList(packageResult, [
    ['Fil', file.name],
    ['Storlek', `${file.size} byte`],
    ['Uppladdad ZIP SHA-256', digest]
  ]);
  setStatus(packageStatus, 'Kontrollerar paketmanifest och samtliga kontrollsummor…');
  try {
    const response = await fetch(`${apiBase()}/v1/public/verifications/packages/verify`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/zip', accept: 'application/json' },
      body: bytes
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeMessage(data, response));
    const passed = data.status === 'verified' || data.verified === true;
    setStatus(packageStatus, passed ? 'Paketets kryptografiska integritet är verifierad.' : 'Paketet underkändes.', passed ? 'success' : 'error');
    renderDefinitionList(packageResult, [
      ['Fil', file.name],
      ['Storlek', `${file.size} byte`],
      ['Uppladdad ZIP SHA-256', digest],
      ['Resultat', data.status || (data.verified ? 'verified' : 'failed')],
      ['Paketschema', data.schema],
      ['Manifest SHA-256', data.manifestSha256],
      ['Antal filer', data.fileCount],
      ['Verifieringsmotor', data.verifierEngine || data.verificationEngine],
      ['Underkända kontroller', Array.isArray(data.failures) && data.failures.length ? data.failures.join(', ') : 'Inga'],
      ['Kontroller', Array.isArray(data.checks) ? data.checks.join(', ') : undefined]
    ]);
  } catch (error) {
    setStatus(packageStatus, `Paketet kunde inte verifieras: ${error.message}`, 'error');
  }
});
