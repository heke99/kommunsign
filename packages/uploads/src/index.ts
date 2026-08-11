export interface UploadMetadata {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE_NAME = /^[^\u0000-\u001f\u007f\\/]{1,200}$/;

export const MICROSOFT_365_SOURCE_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export const OFFICE_SOURCE_MIME_TYPES = [
  ...MICROSOFT_365_SOURCE_MIME_TYPES,
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/rtf',
] as const;

export const SIGNING_SOURCE_MIME_TYPES = ['application/pdf', ...OFFICE_SOURCE_MIME_TYPES] as const;
export const SIGNING_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
export const OFFICE_SOURCE_MAX_BYTES = 50 * 1024 * 1024;

const OFFICE_EXTENSION_BY_MIME: Readonly<Record<(typeof OFFICE_SOURCE_MIME_TYPES)[number], string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/rtf': '.rtf',
};
const MACRO_OFFICE_EXTENSIONS = ['.docm', '.xlsm', '.pptm', '.dotm', '.xltm', '.potm'] as const;

export function validateUploadMetadata(
  input: UploadMetadata,
  policy: { readonly allowedMimeTypes: readonly string[]; readonly maximumBytes: number },
): UploadMetadata {
  const fileName = input.fileName.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  const sha256 = input.sha256.trim().toLowerCase();
  if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') throw new Error('UPLOAD_FILE_NAME_INVALID');
  if (!policy.allowedMimeTypes.includes(mimeType)) throw new Error('UPLOAD_MIME_TYPE_FORBIDDEN');
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > policy.maximumBytes) {
    throw new Error('UPLOAD_SIZE_FORBIDDEN');
  }
  const lowerFileName = fileName.toLowerCase();
  if (MACRO_OFFICE_EXTENSIONS.some((extension) => lowerFileName.endsWith(extension))) throw new Error('UPLOAD_OFFICE_MACRO_FORMAT_FORBIDDEN');
  if (OFFICE_SOURCE_MIME_TYPES.includes(mimeType as (typeof OFFICE_SOURCE_MIME_TYPES)[number])) {
    if (input.byteSize > OFFICE_SOURCE_MAX_BYTES) throw new Error('UPLOAD_SIZE_FORBIDDEN');
    const expectedExtension = OFFICE_EXTENSION_BY_MIME[mimeType as (typeof OFFICE_SOURCE_MIME_TYPES)[number]];
    if (!lowerFileName.endsWith(expectedExtension)) throw new Error('UPLOAD_OFFICE_MIME_EXTENSION_MISMATCH');
  }
  if (!SHA256.test(sha256)) throw new Error('UPLOAD_SHA256_INVALID');
  return { fileName, mimeType, byteSize: input.byteSize, sha256 };
}

export type DetectedDocumentContainer = 'application/pdf' | 'application/zip' | 'application/rtf' | 'unknown';

export function detectDocumentMimeType(bytes: Uint8Array): DetectedDocumentContainer {
  if (bytes.byteLength >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'application/pdf';
  if (bytes.byteLength >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08))) return 'application/zip';
  if (bytes.byteLength >= 5
    && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) return 'application/rtf';
  return 'unknown';
}

export function assertMagicBytesMatch(declaredMimeType: string, bytes: Uint8Array): void {
  const declared = declaredMimeType.trim().toLowerCase();
  const detected = detectDocumentMimeType(bytes);
  if (declared === 'application/pdf' && detected !== 'application/pdf') throw new Error('UPLOAD_MAGIC_BYTES_MISMATCH');
  if (declared === 'application/rtf' && detected !== 'application/rtf') throw new Error('UPLOAD_MAGIC_BYTES_MISMATCH');
  if ((MICROSOFT_365_SOURCE_MIME_TYPES as readonly string[]).includes(declared) && detected !== 'application/zip') throw new Error('UPLOAD_MAGIC_BYTES_MISMATCH');
  if ((['application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet'] as readonly string[]).includes(declared) && detected !== 'application/zip') throw new Error('UPLOAD_MAGIC_BYTES_MISMATCH');
}
