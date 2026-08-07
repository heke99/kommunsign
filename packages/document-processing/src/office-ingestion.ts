/**
 * Office document ingestion.
 *
 * Kungälv 2005 and 2006: the solution must work together with Microsoft 365 for
 * editing office documents, on both personal and shared computers. 2007 adds
 * Adobe Reader DC for PDF.
 *
 * Working "together with" M365 does not mean embedding in it. A municipality
 * drafts a decision in Word and then needs it signed, so what the requirement
 * actually asks is that an Office document can enter the signing flow without
 * the user converting it by hand — and that the file they get back opens
 * correctly in Adobe Reader DC.
 *
 * The load-bearing rule here is that **only the converted PDF/A is ever
 * signed.** An Office file is not a fixed representation of itself: it repaginates
 * across versions, resolves fonts differently on a shared machine than on a
 * personal one, and can contain fields that render differently for the next
 * reader. Signing one would produce a signature over bytes whose visual meaning
 * is not stable, which is precisely what an advanced electronic signature is
 * supposed to rule out. So conversion happens once, server-side, and the
 * resulting PDF/A is the only artifact with legal standing.
 */

import type { UUID } from '../../contracts/src/index.js';

export type OfficeIngestionCode =
  | 'OFFICE_FORMAT_NOT_SUPPORTED'
  | 'OFFICE_MIME_MISMATCH'
  | 'OFFICE_MACRO_FORMAT_REJECTED'
  | 'OFFICE_TOO_LARGE'
  | 'OFFICE_CONVERSION_UNVERIFIED'
  | 'OFFICE_CONVERSION_PAGE_MISMATCH'
  | 'OFFICE_SOURCE_SIGNED';

export class OfficeIngestionError extends Error {
  constructor(readonly code: OfficeIngestionCode, message: string) {
    super(message);
    this.name = 'OfficeIngestionError';
  }
}

/**
 * Accepted source formats, with the extension each must carry.
 *
 * Macro-enabled formats (`.docm`, `.xlsm`, `.pptm`) are deliberately absent.
 * They are the standard delivery vehicle for Office malware, and a document
 * that is about to be converted to a fixed representation has no legitimate
 * need for a macro — so refusing them costs the user nothing.
 */
export const SUPPORTED_OFFICE_FORMATS: readonly {
  readonly mimeType: string;
  readonly extension: string;
  readonly label: string;
}[] = [
  { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx', label: 'Word' },
  { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx', label: 'Excel' },
  { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx', label: 'PowerPoint' },
  { mimeType: 'application/vnd.oasis.opendocument.text', extension: '.odt', label: 'OpenDocument text' },
  { mimeType: 'application/vnd.oasis.opendocument.spreadsheet', extension: '.ods', label: 'OpenDocument spreadsheet' },
  { mimeType: 'application/rtf', extension: '.rtf', label: 'RTF' },
];

const MACRO_EXTENSIONS = ['.docm', '.xlsm', '.pptm', '.dotm', '.xltm', '.potm'];

export const OFFICE_MAX_BYTES = 50 * 1024 * 1024;

export interface OfficeUpload {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface OfficeIngestionPlan {
  readonly sourceFormat: string;
  readonly sourceLabel: string;
  /** Always PDF/A: the converted file is the only artifact that gets signed. */
  readonly targetProfile: 'PDF/A-2b';
  readonly requiresConversion: true;
}

/**
 * Decides whether an uploaded Office file may enter the pipeline.
 *
 * Both the extension and the declared MIME type must agree. Checking only one
 * lets a caller present a macro-enabled file under a benign MIME type, or a
 * benign extension over arbitrary bytes — and the conversion service is the
 * thing that would then open it.
 */
export function planOfficeIngestion(upload: OfficeUpload): OfficeIngestionPlan {
  const lowerName = upload.fileName.toLowerCase();
  const lowerMime = upload.mimeType.toLowerCase().split(';')[0]!.trim();

  if (MACRO_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new OfficeIngestionError(
      'OFFICE_MACRO_FORMAT_REJECTED',
      'Makroaktiverade Office-format tas inte emot. Spara om dokumentet utan makron.',
    );
  }

  const format = SUPPORTED_OFFICE_FORMATS.find((candidate) => lowerName.endsWith(candidate.extension));
  if (format === undefined) {
    throw new OfficeIngestionError('OFFICE_FORMAT_NOT_SUPPORTED', `Filformatet stöds inte: ${upload.fileName}`);
  }
  if (lowerMime !== format.mimeType) {
    throw new OfficeIngestionError(
      'OFFICE_MIME_MISMATCH',
      `Filändelsen ${format.extension} stämmer inte med angiven typ ${lowerMime}`,
    );
  }
  if (!Number.isSafeInteger(upload.byteSize) || upload.byteSize < 1 || upload.byteSize > OFFICE_MAX_BYTES) {
    throw new OfficeIngestionError('OFFICE_TOO_LARGE', 'Filen är för stor eller tom');
  }

  return {
    sourceFormat: format.mimeType,
    sourceLabel: format.label,
    targetProfile: 'PDF/A-2b',
    requiresConversion: true,
  };
}

export interface ConversionResult {
  readonly sourceSha256: string;
  readonly convertedSha256: string;
  readonly convertedPageCount: number;
  /** Reported by veraPDF or equivalent, never claimed by the converter. */
  readonly verifiedProfile: 'PDF/A-2b' | 'PDF/A-3b' | null;
  /** True when the converted PDF passed the same inspection as a direct upload. */
  readonly inspectionAccepted: boolean;
}

export interface IngestedDocument {
  readonly tenantId: UUID;
  readonly documentId: UUID;
  readonly sourceSha256: string;
  /** The hash that will be signed. Always the converted file. */
  readonly signableSha256: string;
  readonly profile: 'PDF/A-2b' | 'PDF/A-3b';
  readonly pageCount: number;
  readonly convertedFrom: string;
}

/**
 * Admits a converted document.
 *
 * The profile must have been *verified*, not asserted by the converter. A
 * converter reporting "PDF/A" is describing its intent; only a validator's
 * verdict is evidence, and the archive export refuses a document whose profile
 * was never verified.
 */
export function admitConvertedDocument(
  plan: OfficeIngestionPlan,
  result: ConversionResult,
  identity: { readonly tenantId: UUID; readonly documentId: UUID },
): IngestedDocument {
  if (result.verifiedProfile === null || !result.inspectionAccepted) {
    throw new OfficeIngestionError(
      'OFFICE_CONVERSION_UNVERIFIED',
      'Den konverterade filen har ingen verifierad PDF/A-profil eller underkändes vid granskning',
    );
  }
  if (!Number.isSafeInteger(result.convertedPageCount) || result.convertedPageCount < 1) {
    throw new OfficeIngestionError('OFFICE_CONVERSION_PAGE_MISMATCH', 'Den konverterade filen saknar sidor');
  }
  // A conversion that produced the same bytes as its source did not convert.
  if (result.convertedSha256 === result.sourceSha256) {
    throw new OfficeIngestionError('OFFICE_CONVERSION_UNVERIFIED', 'Konverteringen producerade ingen ny fil');
  }
  return {
    tenantId: identity.tenantId,
    documentId: identity.documentId,
    sourceSha256: result.sourceSha256,
    // The converted file, never the source. An Office file is not a fixed
    // representation of itself, so a signature over it would cover bytes whose
    // visual meaning is not stable.
    signableSha256: result.convertedSha256,
    profile: result.verifiedProfile,
    pageCount: result.convertedPageCount,
    convertedFrom: plan.sourceFormat,
  };
}

/**
 * Requirements the delivered PDF must meet to open correctly in Adobe Reader DC
 * (krav 2007), stated as data so a check can assert them.
 *
 * `incrementalUpdateOnly` is the one that actually bites: PAdES signatures are
 * appended as an incremental update, and a tool that rewrites the file instead
 * invalidates every signature already on it. That is how a second signer
 * silently destroys the first signature.
 */
export const ADOBE_READER_COMPATIBILITY = {
  pdfVersionAtMost: '1.7',
  requireDocumentIdArray: true,
  requireCrossReferenceTable: true,
  incrementalUpdateOnly: true,
  embedAllFonts: true,
  forbidEncryption: true,
} as const;
