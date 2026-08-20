#!/usr/bin/env node
// Fails when code under packages/ cannot be reached from any application entry
// point. A library with no caller is not neutral: the next person to read the
// repository, or to assess a requirement against it, will read it as
// implementation.
//
// Checked at two granularities, because the coarse one missed things. Whole
// packages first; then individual modules, since packages/provider-adapters was
// reached through tic-bankid.ts while freja.ts sat beside it with no caller —
// the same defect one directory down, invisible to a per-package count.

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
  // The infrastructure adapters are chosen the same way, by
  // KOMMUNSIGN_{OBJECT_STORAGE,QUEUE,SENSITIVE_DATA}_ADAPTER_MODULE.
  'apps/api/src/adapters/supabase-storage.ts',
  'apps/api/src/adapters/postgres-queue.ts',
  'apps/api/src/adapters/aes-gcm-sensitive-data.ts',
];

// Code that is deliberately not wired up yet, each entry naming the requirement
// that explains why.
//
// There is exactly one acceptable reason, and it is checked rather than
// trusted: the requirement the code serves is BLOCKED_EXTERNAL, so the
// requirement matrix already says the capability does not work yet and no
// assessment rests on the code running. "The tests use it" is not a reason —
// every package removed on 2026-08-20 had tests.
//
// This tightens itself. The day credentials arrive and the requirement moves to
// PASS, this gate fails until the code is actually wired in, which is precisely
// the moment the claim would otherwise become false.
const DELIBERATELY_UNREACHABLE = new Map([
  ['packages/provider-adapters/src/freja.ts', 'F002'],
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

/** The assessments as the requirement matrix sees them: base plus dated overrides, oldest first. */
async function currentAssessments() {
  const base = path.join(repositoryRoot, 'docs/compliance/kungalv');
  const merged = { ...JSON.parse(await readFile(path.join(base, 'assessments.json'), 'utf8')).assessments };
  const overrides = readdirSync(base)
    .filter((name) => /^assessment-overrides-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  for (const name of overrides) {
    Object.assign(merged, JSON.parse(await readFile(path.join(base, name), 'utf8')).assessments);
  }
  return merged;
}

const reached = await reachableFiles();
const reachedPackages = new Set();
for (const file of reached) {
  const relative = path.relative(repositoryRoot, file);
  const match = /^packages[/\\]([^/\\]+)[/\\]/.exec(relative);
  if (match) reachedPackages.add(match[1]);
}

const packages = allPackages();
const allowedPackages = new Set([...DELIBERATELY_UNREACHABLE.keys()].map((file) => file.split('/')[1]));
const unreachablePackages = packages.filter((name) => !reachedPackages.has(name) && !allowedPackages.has(name));

function allModules(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) found.push(...allModules(candidate));
    else if (candidate.endsWith('.ts') && !candidate.endsWith('.d.ts')) found.push(candidate);
  }
  return found;
}

const modules = allModules(path.join(repositoryRoot, 'packages'))
  .map((file) => path.relative(repositoryRoot, file).split(path.sep).join('/'));
const reachedModules = new Set(
  [...reached].map((file) => path.relative(repositoryRoot, file).split(path.sep).join('/')),
);
const unreachableModules = modules.filter(
  (file) => !reachedModules.has(file) && !DELIBERATELY_UNREACHABLE.has(file),
);

// Each allowance has to still be earned: the file must exist, must still be
// unreachable, and the requirement it names must still be BLOCKED_EXTERNAL.
const assessments = await currentAssessments();
const staleAllowances = [];
for (const [file, requirementId] of DELIBERATELY_UNREACHABLE) {
  if (!modules.includes(file)) {
    staleAllowances.push(`${file}: no such module`);
  } else if (reachedModules.has(file)) {
    staleAllowances.push(`${file}: now reachable, so the allowance is obsolete`);
  } else {
    const status = assessments[requirementId]?.status;
    if (status === undefined) staleAllowances.push(`${file}: names requirement ${requirementId}, which has no assessment`);
    else if (status !== 'BLOCKED_EXTERNAL') {
      staleAllowances.push(`${file}: requirement ${requirementId} is ${status}, not BLOCKED_EXTERNAL — wire the code in or downgrade the requirement`);
    }
  }
}

console.log(`Reachable from ${ENTRY_POINTS.length} application entry points: ${reachedPackages.size}/${packages.length} packages, ${modules.length - unreachableModules.length}/${modules.length} modules.`);

let failed = false;

if (unreachablePackages.length > 0) {
  failed = true;
  console.error('\nNo application entry point reaches these packages:');
  for (const name of unreachablePackages) console.error(`  packages/${name}`);
}

if (unreachableModules.length > 0) {
  failed = true;
  console.error('\nNo application entry point reaches these modules:');
  for (const file of unreachableModules) console.error(`  ${file}`);
}

if (unreachablePackages.length > 0 || unreachableModules.length > 0) {
  console.error('\nEach one is wired in behind the domain that owns it, deleted, or listed');
  console.error('in DELIBERATELY_UNREACHABLE against a requirement that is BLOCKED_EXTERNAL.');
}

if (staleAllowances.length > 0) {
  failed = true;
  console.error('\nDELIBERATELY_UNREACHABLE entries that no longer hold:');
  for (const entry of staleAllowances) console.error(`  ${entry}`);
}

if (!failed) console.log('Everything under packages/ is reachable or accounted for.');
process.exit(failed ? 1 : 0);
