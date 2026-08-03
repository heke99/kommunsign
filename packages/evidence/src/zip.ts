import { sha256Hex } from '../../crypto/src/hash.js';
import { verifyEvidenceFiles, type EvidenceFile, type EvidenceManifest } from './index.js';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_FILE_COUNT = 2_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01
const FIXED_DOS_TIME = 0x0000;

export interface EvidenceZipInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface EvidenceZipVerification {
  readonly verified: boolean;
  readonly packageSha256: string;
  readonly failures: readonly string[];
  readonly manifest?: EvidenceManifest;
}

/**
 * Builds a byte-for-byte deterministic ZIP archive using the STORE method.
 * Evidence files are already compressed PDFs/XML/DER, so deflate adds little
 * value and would make deterministic output dependent on a compression engine.
 */
export function createEvidenceZip(files: readonly EvidenceZipInput[]): Uint8Array {
  if (files.length === 0 || files.length > MAX_FILE_COUNT) throw new Error('EVIDENCE_ZIP_FILE_COUNT_INVALID');
  const ordered = [...files].map((file) => ({ ...file, path: validatePath(file.path) }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  assertUniquePaths(ordered.map((file) => file.path));

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of ordered) {
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new Error('EVIDENCE_ZIP_FILE_TOO_LARGE');
    const name = new TextEncoder().encode(file.path);
    const crc = crc32(file.bytes);
    const localHeader = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, UTF8_FLAG, true);
    localView.setUint16(8, STORE_METHOD, true);
    localView.setUint16(10, FIXED_DOS_TIME, true);
    localView.setUint16(12, FIXED_DOS_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(name, 30);
    localParts.push(localHeader, file.bytes);

    const centralHeader = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
    centralView.setUint16(4, 0x0314, true); // UNIX, ZIP 2.0
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, UTF8_FLAG, true);
    centralView.setUint16(10, STORE_METHOD, true);
    centralView.setUint16(12, FIXED_DOS_TIME, true);
    centralView.setUint16(14, FIXED_DOS_DATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.byteLength, true);
    centralView.setUint32(24, file.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0o100644 << 16, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(name, 46);
    centralParts.push(centralHeader);
    offset += localHeader.byteLength + file.bytes.byteLength;
  }

  const centralDirectory = concat(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, ordered.length, true);
  endView.setUint16(10, ordered.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  const archive = concat([...localParts, centralDirectory, end]);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('EVIDENCE_ZIP_TOO_LARGE');
  return archive;
}

export async function verifyEvidenceZip(bytes: Uint8Array): Promise<EvidenceZipVerification> {
  const packageSha256 = await sha256Hex(bytes);
  const failures: string[] = [];
  let manifest: EvidenceManifest | undefined;
  try {
    const files = parseEvidenceZip(bytes);
    const manifestFile = files.find((file) => file.path === 'manifest.json');
    if (!manifestFile) {
      failures.push('Missing file: manifest.json');
    } else {
      manifest = parseManifest(manifestFile.bytes);
      const checksumFile = files.find((file) => file.path === 'checksums.sha256');
      if (!checksumFile) failures.push('Missing file: checksums.sha256');
      const evidenceFiles: EvidenceFile[] = files
        .filter((file) => file.path !== 'manifest.json' && file.path !== 'checksums.sha256')
        .map((file) => ({ path: file.path, bytes: file.bytes, mediaType: mediaTypeFor(file.path) }));
      failures.push(...await verifyEvidenceFiles(manifest, evidenceFiles));
      if (checksumFile) failures.push(...verifyChecksumFile(manifest, checksumFile.bytes));
      const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
      if (manifestPaths.has('manifest.json') || manifestPaths.has('checksums.sha256')) failures.push('Manifest must not self-reference package metadata files');
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'EVIDENCE_ZIP_INVALID');
  }
  return { verified: failures.length === 0, packageSha256, failures, ...(manifest ? { manifest } : {}) };
}


function verifyChecksumFile(manifest: EvidenceManifest, bytes: Uint8Array): readonly string[] {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return ['CHECKSUM_FILE_INVALID_ENCODING']; }
  const failures: string[] = [];
  const actual = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) { failures.push('CHECKSUM_FILE_INVALID_LINE'); continue; }
    const path = validatePath(match[2]!);
    if (actual.has(path)) failures.push(`Duplicate checksum: ${path}`);
    actual.set(path, match[1]!);
  }
  for (const entry of manifest.entries) {
    const checksum = actual.get(entry.path);
    if (!checksum) failures.push(`Missing checksum: ${entry.path}`);
    else if (checksum !== entry.sha256) failures.push(`Checksum mismatch: ${entry.path}`);
  }
  for (const path of actual.keys()) if (!manifest.entries.some((entry) => entry.path === path)) failures.push(`Unexpected checksum: ${path}`);
  return failures;
}

function parseEvidenceZip(bytes: Uint8Array): readonly EvidenceZipInput[] {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('EVIDENCE_ZIP_SIZE_INVALID');
  const endOffset = findEndOfCentralDirectory(bytes);
  const end = new DataView(bytes.buffer, bytes.byteOffset + endOffset, 22);
  if (end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0) throw new Error('EVIDENCE_ZIP_MULTIDISK_UNSUPPORTED');
  const entryCount = end.getUint16(10, true);
  const centralSize = end.getUint32(12, true);
  const centralOffset = end.getUint32(16, true);
  const commentLength = end.getUint16(20, true);
  if (entryCount === 0 || entryCount > MAX_FILE_COUNT) throw new Error('EVIDENCE_ZIP_FILE_COUNT_INVALID');
  if (endOffset + 22 + commentLength !== bytes.byteLength) throw new Error('EVIDENCE_ZIP_TRAILING_DATA');
  if (centralOffset + centralSize !== endOffset) throw new Error('EVIDENCE_ZIP_CENTRAL_DIRECTORY_INVALID');

  const files: EvidenceZipInput[] = [];
  const paths: string[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset) throw new Error('EVIDENCE_ZIP_CENTRAL_ENTRY_TRUNCATED');
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 46);
    if (view.getUint32(0, true) !== CENTRAL_DIRECTORY_SIGNATURE) throw new Error('EVIDENCE_ZIP_CENTRAL_SIGNATURE_INVALID');
    const flags = view.getUint16(8, true);
    const method = view.getUint16(10, true);
    const expectedCrc = view.getUint32(16, true);
    const compressedSize = view.getUint32(20, true);
    const uncompressedSize = view.getUint32(24, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const fileCommentLength = view.getUint16(32, true);
    const disk = view.getUint16(34, true);
    const localOffset = view.getUint32(42, true);
    if ((flags & 0x0001) !== 0) throw new Error('EVIDENCE_ZIP_ENCRYPTED_UNSUPPORTED');
    if ((flags & 0x0008) !== 0) throw new Error('EVIDENCE_ZIP_DATA_DESCRIPTOR_UNSUPPORTED');
    if (method !== STORE_METHOD || compressedSize !== uncompressedSize) throw new Error('EVIDENCE_ZIP_COMPRESSION_UNSUPPORTED');
    if (uncompressedSize > MAX_FILE_BYTES) throw new Error('EVIDENCE_ZIP_FILE_TOO_LARGE');
    if (disk !== 0) throw new Error('EVIDENCE_ZIP_MULTIDISK_UNSUPPORTED');
    const centralEnd = cursor + 46 + nameLength + extraLength + fileCommentLength;
    if (centralEnd > endOffset) throw new Error('EVIDENCE_ZIP_CENTRAL_ENTRY_TRUNCATED');
    const path = validatePath(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    paths.push(path);

    if (localOffset + 30 > centralOffset) throw new Error('EVIDENCE_ZIP_LOCAL_ENTRY_INVALID');
    const localView = new DataView(bytes.buffer, bytes.byteOffset + localOffset, 30);
    if (localView.getUint32(0, true) !== LOCAL_FILE_HEADER_SIGNATURE) throw new Error('EVIDENCE_ZIP_LOCAL_SIGNATURE_INVALID');
    if (localView.getUint16(6, true) !== flags || localView.getUint16(8, true) !== method) throw new Error('EVIDENCE_ZIP_HEADER_MISMATCH');
    if (localView.getUint32(14, true) !== expectedCrc || localView.getUint32(18, true) !== compressedSize || localView.getUint32(22, true) !== uncompressedSize) throw new Error('EVIDENCE_ZIP_HEADER_MISMATCH');
    const localNameLength = localView.getUint16(26, true);
    const localExtraLength = localView.getUint16(28, true);
    const localNameStart = localOffset + 30;
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(localNameStart, localNameStart + localNameLength));
    if (localName !== path) throw new Error('EVIDENCE_ZIP_NAME_MISMATCH');
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw new Error('EVIDENCE_ZIP_FILE_TRUNCATED');
    const fileBytes = bytes.slice(dataStart, dataEnd);
    if (crc32(fileBytes) !== expectedCrc) throw new Error(`CRC mismatch: ${path}`);
    files.push({ path, bytes: fileBytes });
    cursor = centralEnd;
  }
  if (cursor !== endOffset) throw new Error('EVIDENCE_ZIP_CENTRAL_DIRECTORY_INVALID');
  assertUniquePaths(paths);
  return files;
}

function parseManifest(bytes: Uint8Array): EvidenceManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('EVIDENCE_MANIFEST_INVALID_JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('EVIDENCE_MANIFEST_INVALID');
  const candidate = parsed as Partial<EvidenceManifest>;
  if (candidate.schema !== 'kommunsign.evidence-package.v1' || typeof candidate.signatureCaseId !== 'string' || typeof candidate.createdAt !== 'string' || !Array.isArray(candidate.entries)) throw new Error('EVIDENCE_MANIFEST_INVALID');
  for (const entry of candidate.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('EVIDENCE_MANIFEST_ENTRY_INVALID');
    const item = entry as Partial<EvidenceManifest['entries'][number]>;
    if (typeof item.path !== 'string' || validatePath(item.path) !== item.path || !/^[0-9a-f]{64}$/.test(String(item.sha256)) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || typeof item.mediaType !== 'string') throw new Error('EVIDENCE_MANIFEST_ENTRY_INVALID');
  }
  assertUniquePaths(candidate.entries.map((entry) => entry.path));
  return candidate as EvidenceManifest;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 22 - 65_535);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(bytes, offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw new Error('EVIDENCE_ZIP_END_NOT_FOUND');
}

function validatePath(input: string): string {
  if (!input || input.length > 512 || input.startsWith('/') || input.endsWith('/') || input.includes('\\') || input.includes('\0')) throw new Error('EVIDENCE_ZIP_PATH_INVALID');
  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error('EVIDENCE_ZIP_PATH_INVALID');
  return input.normalize('NFC');
}

function assertUniquePaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) throw new Error('EVIDENCE_ZIP_DUPLICATE_PATH');
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) return -1;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function mediaTypeFor(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.pdf')) return 'application/pdf';
  if (path.endsWith('.xml')) return 'application/xml';
  if (path.endsWith('.der')) return 'application/ocsp-response';
  if (path.endsWith('.txt') || path.endsWith('.sha256')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
