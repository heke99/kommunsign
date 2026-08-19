/**
 * The assertions for the real signing chain. Driven by scripts/e2e-signing-chain.sh,
 * which starts the services this talks to.
 *
 * Each check here is one the component suites cannot make, because each depends
 * on two processes agreeing over a wire.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const dir = process.env.E2E_DIR;
const SIGN = `http://127.0.0.1:${process.env.SIGN_PORT}`;
const VALIDATE = `http://127.0.0.1:${process.env.VALIDATE_PORT}`;
const signToken = process.env.SIGN_TOKEN;
const validateToken = process.env.VALIDATE_TOKEN;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const log = (name, detail) => console.log(`  ${name.padEnd(44)} ${detail}`);
const failures = [];
const expect = (condition, description) => {
  if (!condition) failures.push(description);
  return condition;
};

const pdf = await readFile(`${dir}/source.pdf`);
const canonicalSha = sha256(pdf);
const pemToDer = (pem) => Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const caDer = pemToDer(await readFile(`${dir}/ca.pem`, 'utf8'));
const foreignCaDer = pemToDer(await readFile(`${dir}/foreign-ca.pem`, 'utf8'));

const ids = {
  tenantId: '41414141-4141-4141-8141-414141414141',
  signatureCaseId: '41414141-3333-4141-8141-414141414141',
  signingIntentId: '41414141-7777-4141-8141-414141414141',
  signerId: '41414141-6666-4141-8141-414141414141',
  documentVersionId: '41414141-5555-4141-8141-414141414141',
};
const evidenceSha = sha256(Buffer.from('tic-verification-report-e2e'));

const signResponse = await fetch(`${SIGN}/v1/sign`, {
  method: 'POST',
  headers: { authorization: `Bearer ${signToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    ...ids,
    documentSha256: canonicalSha,
    inputRevisionSha256: canonicalSha,
    verifiedIdentityEvidenceReference: evidenceSha,
    policyReference: 'kungalv-aes-v1',
    requestedPadesLevel: 'PAdES-B',
    signerSubjectAttributes: [],
    documentBase64: pdf.toString('base64'),
    identityAssertion: {
      tenantId: ids.tenantId,
      signatureCaseId: ids.signatureCaseId,
      signingIntentId: ids.signingIntentId,
      signerId: ids.signerId,
      verificationReportSha256: evidenceSha,
      assuranceLevel: 'HIGH',
      verifiedAt: new Date().toISOString(),
      documentSha256List: [canonicalSha],
    },
  }),
});
const signed = await signResponse.json();
log('POST /v1/sign', `${signResponse.status} ${signed.status ?? signed.reason}`);
if (!expect(signed.status === 'SIGNED', `signing failed: ${JSON.stringify(signed)}`)) {
  console.error(failures.join('\n')); process.exit(1);
}

const signedPdf = Buffer.from(signed.signedDocumentBase64, 'base64');
const signedSha = sha256(signedPdf);
log('signed revision', `${signedPdf.length} bytes (source ${pdf.length})`);

// The multi-signer guarantee rests entirely on this: the signed file must be
// the source bytes plus an appended revision, or a second signer would be
// signing a fork rather than a continuation.
expect(signedPdf.subarray(0, pdf.length).equals(pdf), 'the signed file does not extend the source byte for byte');
log('extends the source exactly', signedPdf.subarray(0, pdf.length).equals(pdf) ? 'YES (incremental revision)' : 'NO');

// The service must report the hash of what it produced, and it must match.
expect(signed.signedRevisionSha256 === signedSha, 'the reported revision hash does not match the returned bytes');
log('reported revision hash matches', signed.signedRevisionSha256 === signedSha ? 'YES' : 'NO');

const validate = async (bytes, anchors) => {
  const response = await fetch(`${VALIDATE}/v1/validate/pades`, {
    method: 'POST',
    headers: { authorization: `Bearer ${validateToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      pdfBase64: bytes.toString('base64'),
      expectedDocumentSha256: sha256(bytes),
      trustAnchorsBase64: anchors,
      policyVersion: 'e2e-1',
    }),
  });
  return { status: response.status, report: await response.json() };
};

const trusted = await validate(signedPdf, [caDer.toString('base64')]);
log('POST /v1/validate/pades', `${trusted.status} ${trusted.report.result} / ${trusted.report.indication}`);
for (const check of trusted.report.checks ?? []) {
  log(`  ${check.code ?? check.name}`, `${check.passed ? 'pass' : 'absent'}${check.mandatory === false ? ' (informational)' : ''}`);
  if (check.mandatory !== false) expect(check.passed, `mandatory check ${check.code ?? check.name} did not pass`);
}
expect(trusted.report.result === 'PASS', 'a genuine signature was not accepted');
expect(trusted.report.indication === 'TOTAL_PASSED', 'the indication is not TOTAL_PASSED');

// The anti-overclaim property: with no timestamp the evidence must not support
// anything above B, and the report must say so rather than imply more.
const evidence = trusted.report.levelEvidence ?? {};
log('level evidence', JSON.stringify(evidence));
expect(evidence.hasTrustedCertificatePath === true, 'the path was not reported as trusted');
expect(evidence.hasSignatureTimestamp === false, 'a timestamp was claimed that no TSA produced');
expect(evidence.hasRevocationEvidence === false, 'revocation evidence was claimed that was never collected');

const untrusted = await validate(signedPdf, [foreignCaDer.toString('base64')]);
log('against an untrusted CA', `${untrusted.status} ${untrusted.report.result} / ${untrusted.report.indication}`);
expect(untrusted.report.result === 'FAIL', 'a signature was accepted against a CA it does not chain to');

// Flipped inside the original document body, which the ByteRange covers.
// Flipping inside the signature container would prove nothing.
const tampered = Buffer.from(signedPdf);
tampered[Math.floor(pdf.length / 2)] ^= 0xff;
const altered = await validate(tampered, [caDer.toString('base64')]);
log('with one byte altered', `${altered.status} ${altered.report.result} / ${altered.report.indication}`);
expect(altered.report.result === 'FAIL', 'an altered document was accepted');

if (failures.length > 0) {
  console.error(`\n  SIGNING CHAIN FAILED:\n${failures.map((f) => `    - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\n  signing chain: real signature, independently validated, fails closed.');
