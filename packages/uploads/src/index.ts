export interface UploadMetadata {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE_NAME = /^[^\u0000-\u001f\u007f\\/]{1,200}$/;

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
  if (!SHA256.test(sha256)) throw new Error('UPLOAD_SHA256_INVALID');
  return { fileName, mimeType, byteSize: input.byteSize, sha256 };
}

export function detectDocumentMimeType(bytes: Uint8Array): 'application/pdf' | 'unknown' {
  return bytes.byteLength >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
    ? 'application/pdf'
    : 'unknown';
}

export function assertMagicBytesMatch(declaredMimeType: string, bytes: Uint8Array): void {
  const detected = detectDocumentMimeType(bytes);
  if (declaredMimeType === 'application/pdf' && detected !== 'application/pdf') throw new Error('UPLOAD_MAGIC_BYTES_MISMATCH');
}
