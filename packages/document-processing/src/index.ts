import { sha256Hex } from '../../crypto/src/hash.js';

export const PDF_HARD_MAX_BYTES = 100 * 1024 * 1024;
export const PDF_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_DEFAULT_MAX_PAGES = 500;
export const PDF_HARD_MAX_DOCUMENTS_PER_CASE = 20;

export interface PdfUploadPolicy { readonly maximumBytes: number; readonly maximumPages: number; readonly maximumDocumentsPerCase: number; }
export interface PdfPolicyFinding { readonly code: string; readonly detail?: string; }
export interface PdfInspectionResult { readonly accepted: boolean; readonly sha256: string; readonly findings: readonly PdfPolicyFinding[]; }

export function validatePdfUploadMetadata(input: { readonly fileName: string; readonly mimeType: string; readonly byteSize: number; readonly policy?: Partial<PdfUploadPolicy> }): PdfUploadPolicy {
  const policy: PdfUploadPolicy = {
    maximumBytes: input.policy?.maximumBytes ?? PDF_DEFAULT_MAX_BYTES,
    maximumPages: input.policy?.maximumPages ?? PDF_DEFAULT_MAX_PAGES,
    maximumDocumentsPerCase: input.policy?.maximumDocumentsPerCase ?? PDF_HARD_MAX_DOCUMENTS_PER_CASE,
  };
  if (policy.maximumBytes < 1 || policy.maximumBytes > PDF_HARD_MAX_BYTES) throw documentError('DOCUMENT_SIZE_POLICY_INVALID');
  if (policy.maximumPages < 1 || policy.maximumPages > PDF_DEFAULT_MAX_PAGES) throw documentError('DOCUMENT_PAGE_POLICY_INVALID');
  if (policy.maximumDocumentsPerCase < 1 || policy.maximumDocumentsPerCase > PDF_HARD_MAX_DOCUMENTS_PER_CASE) throw documentError('DOCUMENT_COUNT_POLICY_INVALID');
  if (!input.fileName.toLowerCase().endsWith('.pdf') || input.mimeType.toLowerCase() !== 'application/pdf') throw documentError('DOCUMENT_PDF_POLICY_REJECTED');
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 5 || input.byteSize > policy.maximumBytes) throw documentError('DOCUMENT_TOO_LARGE');
  return policy;
}

export async function inspectPdfBytes(bytes: Uint8Array): Promise<PdfInspectionResult> {
  const findings: PdfPolicyFinding[] = [];
  if (bytes.length < 5 || new TextDecoder('ascii').decode(bytes.slice(0, 5)) !== '%PDF-') findings.push({ code: 'PDF_MAGIC_BYTES_INVALID' });
  const text = new TextDecoder('latin1').decode(bytes);
  const forbidden: readonly [RegExp, string][] = [
    [/\/Encrypt\b/, 'PDF_ENCRYPTED'], [/\/JavaScript\b|\/JS\b/, 'PDF_JAVASCRIPT'],
    [/\/Launch\b/, 'PDF_LAUNCH_ACTION'], [/\/OpenAction\b/, 'PDF_OPEN_ACTION'],
    [/\/EmbeddedFiles\b|\/EmbeddedFile\b/, 'PDF_EMBEDDED_FILE'], [/\/XFA\b/, 'PDF_XFA'],
  ];
  for (const [pattern, code] of forbidden) if (pattern.test(text)) findings.push({ code });
  return { accepted: findings.length === 0, sha256: await sha256Hex(bytes), findings };
}

export function assertExpectedPageCount(sourcePages: number, canonicalPages: number): void {
  if (!Number.isSafeInteger(sourcePages) || !Number.isSafeInteger(canonicalPages) || sourcePages < 1 || canonicalPages !== sourcePages) throw documentError('DOCUMENT_PAGE_COUNT_CHANGED');
}

export function documentObjectKeys(input: { readonly tenantId: string; readonly caseId: string; readonly documentId: string; readonly versionId: string }): Readonly<Record<'source' | 'canonical' | 'scanReport' | 'pdfaReport', string>> {
  const prefix = `${input.tenantId}/cases/${input.caseId}/documents/${input.documentId}/versions/${input.versionId}`;
  return { source: `${prefix}/source.pdf`, canonical: `${prefix}/canonical.pdf`, scanReport: `${prefix}/validation/scan-report.json`, pdfaReport: `${prefix}/validation/pdfa-report.json` };
}

function documentError(code: string): Error { const error = new Error(code); error.name = code; return error; }
