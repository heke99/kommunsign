import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'release']);
const binaryExtensions = new Set(['.zip', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.ico', '.woff', '.woff2']);

/**
 * Files that are allowed to contain secret *names* because they never carry
 * resolved values. Everything else is checked for assigned secret material.
 */
const nameOnlyEnvironmentFiles = [/(^|\/)\.env\.example$/, /(^|\/)\.env\.production\.template$/, /\.env\.example$/, /\.env\.template$/];

const signatures = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['generic assigned secret', /\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*['"][^'"\n]{12,}['"]/i],
];

/**
 * A shell/env style assignment whose variable name ends in a secret-bearing
 * suffix. The leaked `.kommunsign-production-secrets.env` used exactly this
 * shape with unquoted values, which the quoted-only signature above missed.
 */
const secretAssignment = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|CREDENTIALS)(?:_BASE64|_HEX|_B64)?)[ \t]*=[ \t]*(.+?)[ \t]*$/;

/** Any file whose name advertises that it holds resolved secret material. */
const resolvedSecretFileName = /(?:^|[/.\-_])secrets?[^/]*\.(?:env|json|yaml|yml|txt)$/i;

const placeholder =
  /^(?:$|["']{0,2}(?:REPLACE[_-]?WITH|CHANGE[_-]?ME|CHANGEME|TODO|TBD|SET[_-]?ME|YOUR[_-]?|EXAMPLE|PLACEHOLDER|DUMMY|SAMPLE|LOCAL[_-]?ONLY|LOCAL[_-]?CHANGE|X{3,}|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)["']{0,2}$)/i;

/** Shannon entropy in bits per character. Random keys sit well above 3. */
function entropyPerCharacter(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeResolvedSecret(rawValue) {
  const value = rawValue.replace(/^["']|["']$/g, '').trim();
  if (!value || placeholder.test(value) || value.startsWith('#')) return false;
  // Structured, non-secret values that legitimately appear in config templates.
  if (/^(?:https?|postgres(?:ql)?|redis|s3):\/\//i.test(value)) return false;
  if (value.length < 20) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  return entropyPerCharacter(value) >= 3;
}

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
    if (binaryExtensions.has(extname(entry.name).toLowerCase())) continue;

    if (resolvedSecretFileName.test(repositoryPath) && !nameOnlyEnvironmentFiles.some((allowed) => allowed.test(repositoryPath))) {
      findings.push(`${repositoryPath}: file name indicates resolved secret material and must not be committed`);
    }

    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }

    const nameOnly = nameOnlyEnvironmentFiles.some((allowed) => allowed.test(repositoryPath));
    for (const [name, pattern] of signatures) {
      if (pattern.test(text)) findings.push(`${repositoryPath}: ${name}`);
    }
    if (nameOnly) continue;

    let lineNumber = 0;
    for (const line of text.split('\n')) {
      lineNumber += 1;
      const match = secretAssignment.exec(line);
      if (match && looksLikeResolvedSecret(match[2])) {
        findings.push(`${repositoryPath}:${lineNumber}: assigned value for secret variable ${match[1]}`);
      }
    }
  }
}
await walk('.');
if (findings.length > 0) throw new Error(`Potential secrets detected:\n${findings.join('\n')}`);
console.log('secret scan: OK');
