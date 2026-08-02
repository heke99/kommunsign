#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const manifestPath = resolve(process.argv[2] ?? 'document_manifest.json');
const base = dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schema !== 'kommunsign.evidence-package.v1' || !Array.isArray(manifest.entries)) {
  throw new Error('Unsupported evidence manifest');
}
let failed = 0;
console.log(`Ärende: ${manifest.signatureCaseId}`);
for (const entry of manifest.entries) {
  if (typeof entry.path !== 'string' || entry.path.includes('..') || entry.path.startsWith('/')) {
    console.error(`OGILTIG SÖKVÄG: ${entry.path}`); failed += 1; continue;
  }
  const path = join(base, entry.path);
  try {
    const file = await readFile(path);
    const fileStat = await stat(path);
    const digest = createHash('sha256').update(file).digest('hex');
    const ok = digest === entry.sha256 && fileStat.size === entry.bytes;
    console.log(`${ok ? 'OK' : 'FEL'} ${entry.path} (${entry.mediaType})`);
    if (!ok) failed += 1;
  } catch {
    console.error(`SAKNAS ${entry.path}`); failed += 1;
  }
}
if (failed) { console.error(`${failed} verifieringsfel`); process.exitCode = 2; }
else console.log('Bevispaketets filer matchar manifestet. Kryptografisk signaturvalidering kräver DSS-läge i verifieraren.');
