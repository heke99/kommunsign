import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'release']);
const binaryExtensions = new Set(['.zip', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.ico', '.woff', '.woff2']);
const permittedExamples = new Set(['.env.example']);
const signatures = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['generic assigned secret', /\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*['"][^'"\n]{12,}['"]/i],
];

const findings = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    const repositoryPath = relative('.', path);
    if (permittedExamples.has(repositoryPath) || binaryExtensions.has(extname(entry.name).toLowerCase())) continue;
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    for (const [name, pattern] of signatures) {
      if (pattern.test(text)) findings.push(`${repositoryPath}: ${name}`);
    }
  }
}
await walk('.');
if (findings.length > 0) throw new Error(`Potential secrets detected:\n${findings.join('\n')}`);
console.log('secret scan: OK');
