#!/usr/bin/env node
// Fails when application SQL names a table or column the migrations do not
// create.
//
// The schema and the queries live in different files and different languages,
// so nothing but running the query has ever connected them. A rename lands in a
// migration, the query keeps the old name, and the first person to find out is
// whoever hits that endpoint — or, as happened here, an end-to-end test written
// months later that selected `ep.package_object_key` from a table whose column
// is called `object_key`.
//
// The check is deliberately conservative. It only judges references it can
// resolve to a table it knows, so a query built by string concatenation or one
// against a table this parser did not understand is skipped rather than guessed
// at. A gate that cries wolf gets switched off.

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Words that can follow a table name without being an alias.
const NOT_AN_ALIAS = new Set([
  'set', 'where', 'on', 'values', 'select', 'order', 'group', 'limit', 'using',
  'left', 'right', 'inner', 'outer', 'join', 'returning', 'as', 'having',
  'union', 'except', 'intersect', 'for', 'offset', 'and', 'or', 'from',
]);

// Column-position keywords inside a CREATE TABLE body.
const NOT_A_COLUMN = new Set([
  'primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like', 'references',
]);

function repositoryFiles(patterns) {
  return execFileSync('git', ['ls-files', ...patterns], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n').filter((line) => line.length > 0);
}

/**
 * The schema as the migrations build it.
 *
 * Columns are frequently declared several to a line — `tenant_id uuid NOT NULL,
 * id uuid NOT NULL DEFAULT gen_random_uuid(), validation_run_id uuid NOT NULL,`
 * is one line in data/0007 — so the body is split on top-level commas rather
 * than on newlines. Reading one column per line is what made an earlier version
 * of this check report two columns as missing that were there all along.
 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  let quote = '';
  for (const character of body) {
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') { quote = character; current += character; continue; }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts;
}

async function declaredSchema() {
  const schema = new Map();
  for (const file of repositoryFiles(['migrations/*/*.sql']).sort()) {
    if (!/\/\d{4}_/.test(file)) continue;
    const sql = await readFile(path.join(repositoryRoot, file), 'utf8');

    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      const key = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
      const columns = schema.get(key) ?? new Set();
      for (const part of splitTopLevel(match[3])) {
        const name = /^\s*(\w+)\s+\S/.exec(part.replace(/--[^\n]*/g, ''));
        if (name && !NOT_A_COLUMN.has(name[1].toLowerCase())) columns.add(name[1].toLowerCase());
      }
      schema.set(key, columns);
    }
    for (const match of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(\w+)\.(\w+)([^;]*);/gi)) {
      const key = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
      for (const added of match[3].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi)) {
        (schema.get(key) ?? schema.set(key, new Set()).get(key)).add(added[1].toLowerCase());
      }
      for (const dropped of match[3].matchAll(/DROP COLUMN (?:IF EXISTS )?(\w+)/gi)) {
        schema.get(key)?.delete(dropped[1].toLowerCase());
      }
    }
    for (const match of sql.matchAll(/DROP TABLE (?:IF EXISTS )?(\w+)\.(\w+)/gi)) {
      schema.delete(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
    }
    // A table built by dynamic SQL inside a DO block adds columns this parser
    // cannot see, so those columns are collected separately and allowed
    // everywhere. data/0029 adds key_version to nine tables that way.
    for (const match of sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/gi)) dynamicColumns.add(match[1].toLowerCase());
  }
  return schema;
}

const dynamicColumns = new Set();
const schema = await declaredSchema();

function tablesInStatement(statement) {
  const aliases = new Map();
  for (const match of statement.matchAll(/\b(?:from|join|update|into)\s+(\w+)\.(\w+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
    const key = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
    if (!schema.has(key)) continue;
    aliases.set(match[2].toLowerCase(), key);
    const alias = (match[3] ?? '').toLowerCase();
    if (alias && !NOT_AN_ALIAS.has(alias)) aliases.set(alias, key);
  }
  return aliases;
}

const findings = [];
for (const file of repositoryFiles(['apps/*', 'packages/*', 'scripts/*'])) {
  if (!/\.(ts|mjs)$/.test(file)) continue;
  const source = await readFile(path.join(repositoryRoot, file), 'utf8');
  for (const [statement] of source.matchAll(/`([^`]*?\b(?:select|insert|update|delete)\b[^`]*)`/gis)) {
    const aliases = tablesInStatement(statement);
    if (aliases.size === 0) continue;
    for (const reference of statement.matchAll(/\b(\w+)\.(\w+)\b/g)) {
      const alias = reference[1].toLowerCase();
      const column = reference[2].toLowerCase();
      const table = aliases.get(alias);
      if (!table || column === '*') continue;
      if (schema.get(table).has(column) || dynamicColumns.has(column)) continue;
      findings.push({ file, table, column });
    }
  }
}

const unique = [...new Map(findings.map((finding) => [`${finding.table}.${finding.column}`, finding])).values()];
const tables = [...schema.values()].reduce((total, columns) => total + columns.size, 0);
console.log(`SQL schema references: ${schema.size} tables, ${tables} columns declared by migrations.`);

if (unique.length > 0) {
  console.error('\nApplication SQL names columns the migrations do not create:');
  for (const finding of unique) console.error(`  ${finding.table}.${finding.column}   <- ${finding.file}`);
  console.error('\nEither the migration is missing the column, or the query has the wrong name.');
  process.exit(1);
}
console.log('Every resolvable column reference exists.');
