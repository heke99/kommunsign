import { canonicalJson } from '../dist/packages/crypto/src/canonical-json.js';
import { createEvidenceManifest } from '../dist/packages/evidence/src/index.js';
import { createEvidenceZip, verifyEvidenceZip } from '../dist/packages/evidence/src/zip.js';

const encoder = new TextEncoder();
const signatureCaseId = '11111111-1111-4111-8111-111111111111';
const createdAt = '2026-08-03T12:00:00.000Z';
const evidenceFiles = [
  { path: 'documents/001-production-verification.pdf', bytes: encoder.encode('%PDF-1.7\nKommunsign fixture\n%%EOF\n'), mediaType: 'application/pdf' },
  { path: 'signers/22222222-2222-4222-8222-222222222222/visible-data.txt', bytes: encoder.encode('Kommunsign evidence fixture'), mediaType: 'text/plain' },
];
const manifest = await createEvidenceManifest(signatureCaseId, evidenceFiles, { fixture: 'bankid-production-v1' }, createdAt);
const manifestBytes = encoder.encode(canonicalJson(manifest));
const checksums = encoder.encode(`${manifest.entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`);
const archive = createEvidenceZip([
  ...evidenceFiles.map(({ path, bytes }) => ({ path, bytes })),
  { path: 'manifest.json', bytes: manifestBytes },
  { path: 'checksums.sha256', bytes: checksums },
]);
const secondArchive = createEvidenceZip([
  ...evidenceFiles.map(({ path, bytes }) => ({ path, bytes })),
  { path: 'manifest.json', bytes: manifestBytes },
  { path: 'checksums.sha256', bytes: checksums },
]);
if (!equalBytes(archive, secondArchive)) throw new Error('EVIDENCE_FIXTURE_NOT_DETERMINISTIC');
const verified = await verifyEvidenceZip(archive);
if (!verified.verified) throw new Error(`EVIDENCE_FIXTURE_REJECTED:${verified.failures.join(',')}`);
const tampered = archive.slice();
tampered[Math.floor(tampered.length / 3)] ^= 0x01;
const rejected = await verifyEvidenceZip(tampered);
if (rejected.verified) throw new Error('EVIDENCE_TAMPER_FIXTURE_ACCEPTED');
console.log(`evidence fixture verification: OK (${verified.packageSha256})`);

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
