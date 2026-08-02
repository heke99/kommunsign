import type { CanonicalJsonValue } from '../../crypto/src/canonical-json.js';
import { canonicalJson } from '../../crypto/src/canonical-json.js';
import { sha256Hex } from '../../crypto/src/hash.js';

export interface EvidenceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}
export interface EvidenceManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}
export interface EvidenceManifest {
  readonly schema: 'kommunsign.evidence-package.v1';
  readonly createdAt: string;
  readonly signatureCaseId: string;
  readonly entries: readonly EvidenceManifestEntry[];
  readonly metadata: CanonicalJsonValue;
}

export async function createEvidenceManifest(
  signatureCaseId: string,
  files: readonly EvidenceFile[],
  metadata: CanonicalJsonValue,
  createdAt = new Date().toISOString(),
): Promise<EvidenceManifest> {
  const entries = await Promise.all(files.map(async (file) => ({
    path: file.path,
    sha256: await sha256Hex(file.bytes),
    bytes: file.bytes.byteLength,
    mediaType: file.mediaType,
  })));
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { schema: 'kommunsign.evidence-package.v1', createdAt, signatureCaseId, entries, metadata };
}

export async function evidenceManifestSha256(manifest: EvidenceManifest): Promise<string> {
  return sha256Hex(canonicalJson(manifest as unknown as CanonicalJsonValue));
}

export async function verifyEvidenceFiles(manifest: EvidenceManifest, files: readonly EvidenceFile[]): Promise<readonly string[]> {
  const failures: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const entry of manifest.entries) {
    const file = byPath.get(entry.path);
    if (!file) { failures.push(`Missing file: ${entry.path}`); continue; }
    if (file.bytes.byteLength !== entry.bytes) failures.push(`Size mismatch: ${entry.path}`);
    if (await sha256Hex(file.bytes) !== entry.sha256) failures.push(`Hash mismatch: ${entry.path}`);
  }
  for (const file of files) if (!manifest.entries.some((entry) => entry.path === file.path)) failures.push(`Unexpected file: ${file.path}`);
  return failures;
}
