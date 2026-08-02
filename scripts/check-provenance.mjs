import { readFile } from 'node:fs/promises';
const manifest = await readFile('upstream/manifests/source-inventory.yaml', 'utf8');
const reused = [...manifest.matchAll(/reused_loc:\s*(\d+)/g)].map((match) => Number(match[1]));
const imported = [...manifest.matchAll(/imported:\s*(true|false)/g)].map((match) => match[1] === 'true');
if (reused.length === 0) throw new Error('No provenance records');
if (reused.some((value, index) => value > 0 && !imported[index])) throw new Error('Reused LOC requires imported=true');
if (imported.some(Boolean) && manifest.includes('pinned_commit: null')) throw new Error('Imported sources require exact commit pins');
console.log(`provenance verification: OK (${reused.reduce((a,b)=>a+b,0)} donor LOC)`);
