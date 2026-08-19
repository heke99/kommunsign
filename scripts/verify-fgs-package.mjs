#!/usr/bin/env node
// Validates a real FGS submission descriptor against Riksarkivet's published
// schema set, through the validation service.
//
// The package already followed the profile. What was missing is anyone other
// than its author saying so: "structure follows the published profile" is a
// claim made by the code that writes the structure. This runs the descriptor
// the exporter actually produces through a schema processor, and then breaks it
// on purpose to check the processor is looking.
//
// It does not prove conformance with the archive that will receive the package
// — that archive picks its FGS version and may mandate local extensions — and
// the report says so in every response.
//
//   VALIDATION_SERVICE_URL=... VALIDATION_SERVICE_TOKEN=... npm run verify:fgs

import { buildFgsPackage } from '../dist/packages/archive/src/fgs.js';
import { buildArchivePackage } from '../dist/packages/archive/src/index.js';

const baseUrl = (process.env.VALIDATION_SERVICE_URL ?? '').replace(/\/$/, '');
const token = process.env.VALIDATION_SERVICE_TOKEN ?? '';
if (!baseUrl || !token) {
  console.error('VALIDATION_SERVICE_URL and VALIDATION_SERVICE_TOKEN are required');
  console.error('the application-chain E2E sets both and runs this against the service it starts');
  process.exit(1);
}

let failures = 0;
async function step(name, fn) {
  try { console.log(`  ok    ${name.padEnd(46)} ${(await fn()) ?? ''}`.trimEnd()); }
  catch (error) { failures += 1; console.error(`  FAIL  ${name.padEnd(46)} ${error instanceof Error ? error.message : String(error)}`); }
}

async function validate(xml) {
  const response = await fetch(`${baseUrl}/v1/validate/fgs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ packageDescriptorBase64: Buffer.from(xml).toString('base64') }),
  });
  // 422 is a completed validation that answered "no", exactly as for PAdES.
  if (!response.ok && response.status !== 422) throw new Error(`the validator failed with ${response.status}`);
  return { status: response.status, report: await response.json() };
}

const agents = {
  archivist: 'Kungälvs kommunarkiv',
  creator: 'Kungälvs kommun',
  submitter: 'Kungälvs kommun',
  producingSoftware: 'Kommunsign',
  producingSoftwareVersion: '0.2.0',
};
const archiveCase = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  signatureCaseId: '22222222-2222-4222-8222-222222222222',
  reference: 'KS2026/1005',
  title: 'Beslut om bygglov',
  decisionMode: 'ELECTRONIC_SIGNATURE',
  status: 'archiving',
  createdAt: '2026-08-01T09:00:00.000Z',
  closedAt: '2026-08-05T15:30:00.000Z',
  documents: [{
    documentId: '33333333-3333-4333-8333-333333333333',
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    displayName: 'beslut.pdf',
    sha256: 'a'.repeat(64),
    byteSize: 2048,
    verifiedProfile: 'PDF/A-2b',
    isSignedArtifact: true,
  }],
  signatures: [{
    signerId: '55555555-5555-4555-8555-555555555555',
    signedAt: '2026-08-05T12:00:00.000Z',
    padesLevel: 'PAdES-B',
    signatureArtifactSha256: 'b'.repeat(64),
    validationReportSha256: 'c'.repeat(64),
    timestampTokenSha256: null,
  }],
  identities: [{
    signerId: '55555555-5555-4555-8555-555555555555',
    provider: 'TIC_BANKID',
    assuranceLevel: 'HIGH',
    maskedIdentifier: '19640823-****',
    verifiedAt: '2026-08-05T11:59:00.000Z',
    evidenceSha256: 'd'.repeat(64),
  }],
  auditTrailSha256: 'e'.repeat(64),
};
const files = [
  { path: 'content/beslut.pdf', bytes: new TextEncoder().encode('%PDF-1.7 beslut'), mediaType: 'application/pdf' },
  { path: 'evidence/validation-report.json', bytes: new TextEncoder().encode('{"indication":"TOTAL_PASSED"}'), mediaType: 'application/json' },
];

console.log(`FGS package verification against ${baseUrl}`);

const fgs = await buildFgsPackage(await buildArchivePackage(archiveCase, files), agents);
const descriptor = new TextDecoder().decode(fgs.descriptor.bytes);

await step('the exporter produces a descriptor', () => `${fgs.descriptor.bytes.length} bytes, ${fgs.descriptor.path}`);

await step('it validates against the published schema set', async () => {
  const { status, report } = await validate(descriptor);
  if (status !== 200 || report.result !== 'PASS') {
    const detail = (report.checks ?? []).map((check) => check.detail).filter(Boolean).join(' | ');
    throw new Error(`${report.result ?? status}: ${detail || 'no detail'}`);
  }
  return `${report.specification}, ${report.engine}`;
});

await step('the report never claims the receiving archive accepted it', async () => {
  const { report } = await validate(descriptor);
  if (report.receivingArchiveSchemaValidated !== false) {
    throw new Error('the report implies conformance with the receiving archive, which was not checked');
  }
  return 'receivingArchiveSchemaValidated: false';
});

await step('a descriptor missing a required attribute is refused', async () => {
  // ID on amdSec is required by the profile though optional in METS core, and
  // that difference is exactly what a structural inspection misses and a schema
  // processor does not. It was missing until this check existed.
  const broken = descriptor.replace(/<mets:amdSec ID="[^"]*">/, '<mets:amdSec>');
  if (broken === descriptor) throw new Error('the fixture no longer carries amdSec ID, so this proves nothing');
  const { status, report } = await validate(broken);
  if (status !== 422 || report.result !== 'FAIL') throw new Error(`a broken descriptor was accepted: ${status} ${report.result}`);
  return 'refused';
});

await step('a descriptor missing the mandatory alternative identifier is refused', async () => {
  // The profile makes altRecordID mandatory. It was absent until this check
  // existed, which is the second thing following the profile by inspection had
  // not caught.
  const broken = descriptor.replace(/\s*<mets:altRecordID[^>]*>[^<]*<\/mets:altRecordID>/, '');
  if (broken === descriptor) throw new Error('the fixture no longer carries altRecordID, so this proves nothing');
  const { status, report } = await validate(broken);
  if (status !== 422 || report.result !== 'FAIL') throw new Error(`a descriptor without altRecordID was accepted: ${status} ${report.result}`);
  return 'refused';
});

await step('a descriptor with an element the profile does not allow is refused', async () => {
  const broken = descriptor.replace('</mets:mets>', '<mets:notAThing/></mets:mets>');
  const { status, report } = await validate(broken);
  if (status !== 422 || report.result !== 'FAIL') throw new Error(`an unknown element was accepted: ${status} ${report.result}`);
  return 'refused';
});

await step('a document that is not XML at all is refused rather than crashing', async () => {
  const { status, report } = await validate('this is not xml');
  if (status !== 422 || report.result !== 'FAIL') throw new Error(`non-XML was accepted: ${status} ${report.result}`);
  return 'refused';
});

if (failures) {
  console.error(`\nFGS package verification FAILED (${failures})`);
  process.exit(1);
}
console.log('\nFGS package verification: OK');
