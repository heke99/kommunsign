#!/usr/bin/env node
// Fails when a package under packages/ cannot be reached from any application
// entry point. A library with no caller is not neutral: the next person to read
// the repository, or to assess a requirement against it, will read it as
// implementation. Every package here is either reachable, or listed below with
// a reason.

import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything a deployed process starts from. server.mjs picks its bootstrap
// module from the environment, so both bootstraps are named here rather than
// followed through the string.
const ENTRY_POINTS = [
  'apps/api/src/production-runtime.ts',
  'apps/api/src/dev-runtime.ts',
  'apps/workers/src/production-runner.ts',
  'apps/workers/src/dev-runner.ts',
  // Both runtimes load their adapter through `await import(moduleName)`, where
  // moduleName comes from the environment. These are the values the deployment
  // templates and the end-to-end scripts set, so they are entry points in
  // practice even though no static import reaches them.
  'apps/api/src/production-adapters/postgres/index.ts',
  'apps/workers/src/postgres-production-adapter.ts',
];

// Packages that are deliberately not reachable from an application, with the
// reason they exist anyway. A package earns a line here only when something
// that runs in CI depends on it; "we might need it later" is not a reason.
const DELIBERATELY_UNREACHABLE = new Map([
  // Empty on purpose. Every package is currently reachable from something a
  // deployment starts. Add a line here only when something that runs in CI
  // depends on the package; "we might need it later" is not a reason.
]);

const SPECIFIER = /(?:^|[\s;{(])(?:import|export)\s(?:[\s\S]*?\sfrom\s)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source) {
  const found = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier) found.push(specifier);
  }
  return found;
}

function resolve(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    target.replace(/\.js$/, '.ts'),
    target.replace(/\.mjs$/, '.mts'),
    target,
    `${target}.ts`,
    path.join(target, 'index.ts'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate.
    }
  }
  return null;
}

async function reachableFiles() {
  const seen = new Set();
  const queue = ENTRY_POINTS.map((entry) => path.join(repositoryRoot, entry));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      throw new Error(`entry point or import target does not exist: ${path.relative(repositoryRoot, file)}`);
    }
    for (const specifier of specifiersOf(source)) {
      const resolved = resolve(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function allPackages() {
  return readdirSync(path.join(repositoryRoot, 'packages'))
    .filter((name) => statSync(path.join(repositoryRoot, 'packages', name)).isDirectory())
    .sort();
}

const reached = await reachableFiles();
const reachedPackages = new Set();
for (const file of reached) {
  const relative = path.relative(repositoryRoot, file);
  const match = /^packages[/\\]([^/\\]+)[/\\]/.exec(relative);
  if (match) reachedPackages.add(match[1]);
}

const packages = allPackages();
const unreachable = packages.filter((name) => !reachedPackages.has(name) && !DELIBERATELY_UNREACHABLE.has(name));
const staleAllowances = [...DELIBERATELY_UNREACHABLE.keys()].filter((name) => reachedPackages.has(name) || !packages.includes(name));

console.log(`Reachable from ${ENTRY_POINTS.length} application entry points: ${reachedPackages.size}/${packages.length} packages, ${reached.size} modules.`);

let failed = false;

if (unreachable.length > 0) {
  failed = true;
  console.error('\nNo application entry point reaches these packages:');
  for (const name of unreachable) console.error(`  packages/${name}`);
  console.error('\nEach one is either wired in behind the domain that owns it, deleted,');
  console.error('or listed in DELIBERATELY_UNREACHABLE with the reason it stays.');
}

if (staleAllowances.length > 0) {
  failed = true;
  console.error('\nDELIBERATELY_UNREACHABLE lists packages that no longer need the allowance:');
  for (const name of staleAllowances) console.error(`  packages/${name}`);
}

if (!failed) console.log('Every package under packages/ is reachable or accounted for.');
process.exit(failed ? 1 : 0);
