import { readFile, readdir } from 'node:fs/promises';

for (const scope of ['control', 'data']) {
  const files = (await readdir(`migrations/${scope}`)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const numbers = files.map((name) => Number(name.slice(0, 4)));
  if (new Set(numbers).size !== numbers.length) throw new Error(`${scope}: duplicate migration number`);
  for (const [index, number] of numbers.entries()) {
    if (number !== index + 1) throw new Error(`${scope}: expected migration ${(index + 1).toString().padStart(4, '0')}, found ${files[index]}`);
  }
  for (const file of files) {
    const sql = await readFile(`migrations/${scope}/${file}`, 'utf8');
    for (const marker of ['-- Purpose:', '-- Impact:', '-- Backfill:', '-- Rollback:', '-- Verification:']) {
      if (!sql.includes(marker)) throw new Error(`${scope}/${file}: missing ${marker}`);
    }
    if (/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(sql) && !/maintenance window|expand-and-contract/i.test(sql)) {
      throw new Error(`${scope}/${file}: destructive operation lacks an explicit safety strategy`);
    }
  }
}
const hardening = await readFile('migrations/data/0009_integrity_and_worker_recovery.sql', 'utf8');
for (const requirement of [
  'FORCE ROW LEVEL SECURITY', 'assert_valid_status_transition', 'assert_case_completion_evidence',
  'digital_approval_evidence', "candidate.status = 'leased'", 'assert_signature_attempt_consistency',
]) {
  if (!hardening.includes(requirement)) throw new Error(`data/0009 lacks ${requirement}`);
}
console.log('SQL migration verification: OK');
