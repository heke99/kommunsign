/**
 * Builds docs/compliance/kungalv/REQUIREMENT_MATRIX.md from the extracted
 * requirement text (requirements.json) and authored per-requirement evidence.
 *
 * The immutable original assessment is kept for audit history. A dated override
 * file may correct an older assessment when a fresh verification disproves it.
 * Requirement text is never overridden.
 */
import { readFile, writeFile } from 'node:fs/promises';

const base = 'docs/compliance/kungalv';
const requirements = JSON.parse(await readFile(`${base}/requirements.json`, 'utf8'));
const assessmentFile = JSON.parse(await readFile(`${base}/assessments.json`, 'utf8'));
const currentOverride = JSON.parse(await readFile(`${base}/assessment-overrides-2026-08-11.json`, 'utf8'));
const assessments = { ...assessmentFile.assessments, ...currentOverride.assessments };
const assessedAt = currentOverride.assessedAt ?? assessmentFile.assessedAt;

const missing = requirements.requirements.filter((requirement) => !assessments[requirement.id]);
if (missing.length > 0) {
  throw new Error(`Requirements without an assessment: ${missing.map((r) => r.id).join(', ')}`);
}
const orphaned = Object.keys(assessments).filter(
  (id) => !requirements.requirements.some((requirement) => requirement.id === id),
);
if (orphaned.length > 0) throw new Error(`Assessments without a requirement: ${orphaned.join(', ')}`);
const overrideOrphans = Object.keys(currentOverride.assessments).filter(
  (id) => !assessmentFile.assessments[id],
);
if (overrideOrphans.length > 0) throw new Error(`Overrides without a historical assessment: ${overrideOrphans.join(', ')}`);

const allowedStatuses = new Set(['PASS', 'PARTIAL', 'GAP', 'BLOCKED_EXTERNAL']);
for (const requirement of requirements.requirements) {
  const status = assessments[requirement.id]?.status;
  if (!allowedStatuses.has(status)) throw new Error(`Requirement ${requirement.id} has invalid status: ${status}`);
}

const cell = (value) => (value ?? '—').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

const counts = new Map();
for (const requirement of requirements.requirements) {
  const key = `${requirement.type}/${assessments[requirement.id].status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const lines = [];
lines.push('# Kravmatris — Kungälvs kommun, Dnr KS2026/1005');
lines.push('');
lines.push('<!-- GENERERAD FIL. Redigera inte för hand.');
lines.push('     Kör `node scripts/build-requirement-matrix.mjs` efter ändring i');
lines.push('     requirements.json, assessments.json eller daterad assessment override. -->');
lines.push('');
lines.push(`Bedömningsdatum: ${assessedAt}`);
lines.push('');
lines.push('Den historiska bedömningen kompletteras med daterade overrides endast när en ny verifiering visar att en äldre status inte längre är korrekt. Kravtexten hämtas alltid oförändrad från källutdraget.');
lines.push('');
lines.push('## Källa');
lines.push('');
lines.push(`Kravtexten är extraherad ur \`${requirements.source.file}\``);
lines.push(`(SHA-256 \`${requirements.source.sha256}\`).`);
lines.push(requirements.source.note);
lines.push('');
lines.push('Kraven i fliken *Funktionella krav* saknar ID i källan och har därför');
lines.push('tilldelats lokala ID på formen `F001`. Övriga ID kommer från källan.');
lines.push('');
lines.push('## Statusdefinitioner');
lines.push('');
for (const [status, definition] of Object.entries(assessmentFile.statusDefinitions)) {
  lines.push(`- **${status}** — ${definition}`);
}
lines.push('');
lines.push('## Sammanställning');
lines.push('');
lines.push('| Typ | PASS | PARTIAL | GAP | BLOCKED_EXTERNAL | Summa |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const type of ['SKA', 'BÖR']) {
  const row = ['PASS', 'PARTIAL', 'GAP', 'BLOCKED_EXTERNAL'].map((status) => counts.get(`${type}/${status}`) ?? 0);
  lines.push(`| ${type} | ${row.join(' | ')} | ${row.reduce((a, b) => a + b, 0)} |`);
}
lines.push('');
lines.push('Ingen rad är obehandlad: generatorn misslyckas om ett krav saknar bedömning.');
lines.push('');

const sheets = [...new Set(requirements.requirements.map((requirement) => requirement.sheet))];
for (const sheet of sheets) {
  lines.push(`## ${sheet}`);
  lines.push('');
  for (const requirement of requirements.requirements.filter((r) => r.sheet === sheet)) {
    const assessment = assessments[requirement.id];
    lines.push(`### ${requirement.id} — ${assessment.status}`);
    lines.push('');
    lines.push('| Fält | Innehåll |');
    lines.push('| --- | --- |');
    lines.push(`| Krav | ${cell(requirement.requirement)} |`);
    lines.push(`| Typ | ${cell(requirement.type)} |`);
    if (requirement.category) lines.push(`| Kategori | ${cell(requirement.category)} |`);
    if (requirement.subject) lines.push(`| Område | ${cell(requirement.subject)} |`);
    if (requirement.isoArea) lines.push(`| ISO | ${cell(requirement.isoChapter)} — ${cell(requirement.isoArea)} |`);
    if (requirement.reference) lines.push(`| Referens | ${cell(requirement.reference)} |`);
    lines.push(`| Nuläge | ${cell(assessment.state)} |`);
    lines.push(`| Gap | ${cell(assessment.gap)} |`);
    lines.push(`| Lösning | ${cell(assessment.implementation)} |`);
    lines.push(`| Kodevidens | ${cell(assessment.evidence)} |`);
    lines.push(`| Verifiering | ${cell(assessment.verification)} |`);
    lines.push(`| Status | ${cell(assessment.status)} |`);
    if (assessment.blocker) lines.push(`| Blockerare | ${cell(assessment.blocker)} |`);
    if (currentOverride.assessments[requirement.id]) lines.push(`| Bedömningskälla | Override ${assessedAt}: ${cell(currentOverride.reason)} |`);
    lines.push('');
  }
}

await writeFile(`${base}/REQUIREMENT_MATRIX.md`, `${lines.join('\n')}\n`, 'utf8');

const blocked = requirements.requirements.filter(
  (requirement) => assessments[requirement.id].status === 'BLOCKED_EXTERNAL',
);
const missingBlocker = blocked.filter((requirement) => !assessments[requirement.id].blocker);
if (missingBlocker.length > 0) {
  throw new Error(
    `BLOCKED_EXTERNAL requires an explicit blocker: ${missingBlocker.map((r) => r.id).join(', ')}`,
  );
}

const blockerLines = [];
blockerLines.push('# Externa blockerare — Kungälvs kommun, Dnr KS2026/1005');
blockerLines.push('');
blockerLines.push('<!-- GENERERAD FIL. Redigera inte för hand.');
blockerLines.push('     Kör `node scripts/build-requirement-matrix.mjs`. -->');
blockerLines.push('');
blockerLines.push(`Bedömningsdatum: ${assessedAt}`);
blockerLines.push('');
blockerLines.push(`${blocked.length} av ${requirements.requirements.length} krav kan inte avgöras i kodbasen.`);
blockerLines.push('De kräver avtal, credentials, certifiering, leverantörsevidens eller');
blockerLines.push('organisatoriska åtgärder. Kraven markeras medvetet inte som uppfyllda.');
blockerLines.push('');
blockerLines.push('| Krav | Typ | Vad som saknas | Vad som redan är implementerat |');
blockerLines.push('| --- | --- | --- | --- |');
for (const requirement of blocked) {
  const assessment = assessments[requirement.id];
  blockerLines.push(
    `| ${requirement.id} | ${requirement.type} | ${cell(assessment.blocker)} | ${cell(assessment.state)} |`,
  );
}
blockerLines.push('');
await writeFile(`${base}/EXTERNAL_EVIDENCE_BLOCKERS.md`, `${blockerLines.join('\n')}\n`, 'utf8');
const summary = [...counts.entries()].sort().map(([key, value]) => `${key}=${value}`).join(' ');
console.log(`requirement matrix: ${requirements.requirements.length} requirements (${summary})`);
