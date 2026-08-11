import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApiHandler } from '../dist/apps/api/src/router.js';
import { GotenbergOfficePdfAClient } from '../dist/packages/document-processing/src/office-production.js';
import { planOfficeIngestion } from '../dist/packages/document-processing/src/office-ingestion.js';
import {
  MICROSOFT_365_SOURCE_MIME_TYPES,
  SIGNING_SOURCE_MIME_TYPES,
  assertMagicBytesMatch,
  validateUploadMetadata,
} from '../dist/packages/uploads/src/index.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '22222222-2222-4222-8222-222222222222';
const uploadPolicy = { allowedMimeTypes: SIGNING_SOURCE_MIME_TYPES, maximumBytes: 100 * 1024 * 1024 };

assert.deepEqual([...MICROSOFT_365_SOURCE_MIME_TYPES], [DOCX, XLSX, PPTX]);
for (const [fileName, mimeType] of [['beslut.docx', DOCX], ['budget.xlsx', XLSX], ['presentation.pptx', PPTX]]) {
  const plan = planOfficeIngestion({ fileName, mimeType, byteSize: 1024 });
  assert.equal(plan.targetProfile, 'PDF/A-2b');
  assert.equal(plan.requiresConversion, true);
  assert.equal(plan.sourceFormat, mimeType);
  const validated = validateUploadMetadata(
    { fileName, mimeType, byteSize: 1024, sha256: 'a'.repeat(64) },
    uploadPolicy,
  );
  assert.equal(validated.mimeType, mimeType);
}
assert.throws(
  () => planOfficeIngestion({ fileName: 'macro.docm', mimeType: DOCX, byteSize: 1024 }),
  /Makroaktiverade|OFFICE_MACRO_FORMAT_REJECTED/,
);
assert.throws(
  () => planOfficeIngestion({ fileName: 'fel.docx', mimeType: XLSX, byteSize: 1024 }),
  /stämmer inte|OFFICE_MIME_MISMATCH/,
);
assert.throws(
  () => validateUploadMetadata(
    { fileName: 'macro.docm', mimeType: DOCX, byteSize: 1024, sha256: 'a'.repeat(64) },
    uploadPolicy,
  ),
  /UPLOAD_OFFICE_MACRO_FORMAT_FORBIDDEN/,
);
assert.throws(
  () => validateUploadMetadata(
    { fileName: 'fel.xlsx', mimeType: DOCX, byteSize: 1024, sha256: 'a'.repeat(64) },
    uploadPolicy,
  ),
  /UPLOAD_OFFICE_MIME_EXTENSION_MISMATCH/,
);

const zipBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
assert.doesNotThrow(() => assertMagicBytesMatch(DOCX, zipBytes));
assert.throws(() => assertMagicBytesMatch(DOCX, new TextEncoder().encode('%PDF-1.7')), /UPLOAD_MAGIC_BYTES_MISMATCH/);

let converterRequest;
const converter = new GotenbergOfficePdfAClient('http://gotenberg.internal:3000', 5_000, async (url, init) => {
  converterRequest = { url: String(url), init };
  return new Response(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'gotenberg-version': '8.test' },
  });
});
const converted = await converter.convertToPdfA2b({
  bytes: zipBytes,
  fileName: 'beslut.docx',
  mimeType: DOCX,
  traceId: 'm365-test-trace',
});
assert.equal(converterRequest.url, 'http://gotenberg.internal:3000/forms/libreoffice/convert');
assert.ok(converterRequest.init.body instanceof FormData);
assert.equal(converterRequest.init.body.get('pdfa'), 'PDF/A-2b');
assert.equal(converterRequest.init.body.get('pdfua'), 'false');
assert.equal(converted.engine, 'Gotenberg/LibreOffice');
assert.equal(converted.engineVersion, '8.test');
assert.equal(converted.profile, 'PDF/A-2b');
assert.equal(new TextDecoder().decode(converted.bytes.slice(0, 5)), '%PDF-');

let apiUploadInput;
const handler = createApiHandler({
  resolveContext: async () => ({
    tenantId: TENANT_ID,
    subjectId: SUBJECT_ID,
    requestId: crypto.randomUUID(),
    authMethod: 'development',
    source: 'development',
  }),
  authorize: async () => undefined,
  uploads: {
    create: async (_context, input) => {
      apiUploadInput = input;
      return {
        ...input,
        id: '55555555-5555-4555-8555-555555555555',
        uploadUrl: 'http://127.0.0.1:9000/quarantine/source',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requiredHeaders: { 'content-type': input.mimeType },
      };
    },
    complete: async () => ({ id: '55555555-5555-4555-8555-555555555555', status: 'uploaded', sha256: 'a'.repeat(64), byteSize: 1024 }),
  },
});
const response = await handler(new Request('http://127.0.0.1:8787/v1/uploads', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': 'm365-office-test-0001' },
  body: JSON.stringify({ fileName: 'beslut.docx', mimeType: DOCX, byteSize: 1024, sha256: 'a'.repeat(64) }),
}));
assert.equal(response.status, 201);
assert.equal(apiUploadInput.mimeType, DOCX);
assert.equal(apiUploadInput.fileName, 'beslut.docx');

const portalHtml = await readFile(new URL('../apps/tenant-portal/public/index.html', import.meta.url), 'utf8');
const portalOfficeJs = await readFile(new URL('../apps/tenant-portal/public/office-upload.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../apps/workers/src/office-document-handlers.ts', import.meta.url), 'utf8');
const productionAdapter = await readFile(new URL('../apps/workers/src/postgres-production-adapter.ts', import.meta.url), 'utf8');
assert.match(portalHtml, /\.docx,\.xlsx,\.pptx/);
assert.match(portalHtml, /Microsoft 365 online och desktop/);
assert.match(portalHtml, /Delad dator/);
assert.match(portalOfficeJs, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
assert.match(workerSource, /forms\/libreoffice\/convert|GotenbergOfficePdfAClient/);
assert.match(workerSource, /ClamAvInstreamClient/);
assert.match(workerSource, /VeraPdfRestClient/);
assert.match(productionAdapter, /createOfficeSourceJobHandlers/);

console.log('m365-office: native Office upload, rejection rules, quarantine and PDF/A conversion contract verified');
