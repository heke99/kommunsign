import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const environmentText = await readFile('.env.example', 'utf8');
const declared = new Set([...environmentText.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
const roots = ['apps', 'packages', 'scripts', 'services'];
const discovered = new Set();

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (['.ts', '.js', '.mjs', '.cjs'].includes(extname(path))) {
      const source = await readFile(path, 'utf8');
      for (const pattern of [
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
        /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
      ]) {
        for (const match of source.matchAll(pattern)) discovered.add(match[1]);
      }
    }
  }
}
for (const root of roots) await walk(root);
const missing = [...discovered].filter((name) => !declared.has(name)).sort();
if (missing.length) throw new Error(`.env.example saknar körvariabler: ${missing.join(', ')}`);
const productionTemplate = await readFile('.env.production.template', 'utf8');
if (productionTemplate !== environmentText) throw new Error('.env.production.template är inte synkroniserad med .env.example');
console.log(`ENV-kontrakt: OK (${declared.size} deklarerade variabler, ${discovered.size} direkta runtime-referenser).`);
