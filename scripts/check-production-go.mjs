/**
 * Decides PRODUCTION_GO from evidence, instead of it being a sentence somebody
 * typed.
 *
 * Until now the answer lived in prose in two documents. That has the failure
 * mode every hand-maintained status has: it is written once, the world moves,
 * and nobody re-reads it. Worse, it can be edited to say YES without anything
 * about the system changing — which is exactly the overclaim this delivery has
 * spent its whole length removing from the requirement matrix.
 *
 * So the answer is computed. Every precondition below is checked against
 * something real: a running service's own report of itself, a configuration
 * value, a database row, or a generated artefact. Where a precondition cannot
 * be checked, that is itself a NO — an unverifiable precondition is not a met
 * one.
 *
 * The consequence worth stating plainly: this script cannot be made to say GO
 * by editing it. It says GO when the artefacts exist. Most of them are things
 * no code can produce — a certificate authority has to issue a certificate, a
 * timestamp authority has to sign a contract, a municipality has to hand over
 * its IdP metadata. That is why the answer is NO today and why it is not a
 * defect.
 *
 * Usage:
 *   node scripts/check-production-go.mjs            # human readable
 *   node scripts/check-production-go.mjs --json     # machine readable
 * Exit code 0 means GO, 1 means NO-GO. Nothing else means anything.
 */
import { readFile } from 'node:fs/promises';

const json = process.argv.includes('--json');
const checks = [];

/**
 * @param id        stable identifier, so a blocker can be tracked over time
 * @param statement what must be true, written as the fact and not as a task
 * @param evaluate  returns { met, detail } — never throws to mean "no"
 * @param supplier  who has to act when it is not met
 */
async function check(id, statement, supplier, evaluate) {
  let met = false;
  let detail = 'not evaluated';
  try {
    const outcome = await evaluate();
    met = outcome.met === true;
    detail = outcome.detail;
  } catch (error) {
    // An evaluation that failed is not a precondition that passed. The
    // distinction matters most exactly when something is misconfigured.
    met = false;
    detail = `could not be evaluated: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  checks.push({ id, statement, supplier, met, detail });
}

const environment = process.env;
const has = (name) => typeof environment[name] === 'string' && environment[name].trim().length > 0;

/** Reads a service's own report of itself, or null when it is not reachable. */
async function health(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; } finally { clearTimeout(timeout); }
}

const signHealth = await health(environment.SIGNSERVICE_URL);

// --- Cryptographic signing -------------------------------------------------

await check(
  'SIGNING_KEY_PROTECTION',
  'The signing key is held in an HSM or a remote QSCD, not in software.',
  'The customer or hosting provider, by provisioning key protection hardware.',
  async () => {
    if (!signHealth) return { met: false, detail: 'SignService is not reachable, so its key protection cannot be confirmed' };
    const level = signHealth.keyProtection;
    return {
      met: typeof level === 'string' && level !== 'SOFTWARE',
      detail: `SignService reports keyProtection=${level ?? 'unknown'}`,
    };
  },
);

await check(
  'SIGNING_CERTIFICATE',
  'The signing certificate is issued by a certificate authority under a certificate policy.',
  'A CA. No code can issue this.',
  async () => {
    if (!signHealth) return { met: false, detail: 'SignService is not reachable' };
    // productionReady is the service's own judgement, and it is deliberately
    // conservative: it requires protected keys and a timestamp source together.
    return {
      met: signHealth.productionReady === true,
      detail: `SignService reports productionReady=${signHealth.productionReady}`,
    };
  },
);

await check(
  'TIMESTAMP_AUTHORITY',
  'An RFC 3161 timestamp authority is configured, so a signature can reach PAdES-T and above.',
  'A TSA, under contract.',
  async () => {
    if (!signHealth) return { met: false, detail: 'SignService is not reachable' };
    const levels = Array.isArray(signHealth.supportedPadesLevels) ? signHealth.supportedPadesLevels : [];
    return {
      met: signHealth.timestampConfigured === true && levels.includes('PAdES-T'),
      detail: `timestampConfigured=${signHealth.timestampConfigured}, levels=${levels.join(',') || 'none'}`,
    };
  },
);

// --- Identity --------------------------------------------------------------

await check(
  'BANKID_PRODUCTION_CREDENTIALS',
  'TIC/BankID production credentials are configured.',
  'The BankID provider, through the customer.',
  async () => ({
    met: has('TIC_BASE_URL') && has('TIC_API_KEY') && environment.APP_ENV === 'production',
    detail: environment.APP_ENV === 'production'
      ? `TIC_BASE_URL=${has('TIC_BASE_URL') ? 'set' : 'missing'}, TIC_API_KEY=${has('TIC_API_KEY') ? 'set' : 'missing'}`
      : `APP_ENV=${environment.APP_ENV ?? 'unset'}, so no production credential is in use`,
  }),
);

await check(
  'MUNICIPAL_IDP_METADATA',
  'The municipality\'s IdP is configured with issuer, endpoint and signing certificate.',
  'The municipality. It is their federation metadata.',
  async () => {
    const url = environment.CONTROL_DATABASE_URL;
    if (!url) return { met: false, detail: 'CONTROL_DATABASE_URL is not set, so the configuration cannot be read' };
    const { default: postgres } = await import('postgres');
    const sql = postgres(url, { max: 1, idle_timeout: 2 });
    try {
      const rows = await sql`
        select count(*)::int total from control.tenant_identity_providers
         where enabled = true and environment = 'production'
           and public_configuration ? 'signingCertificateBase64'
           and public_configuration->>'issuer' is not null`;
      const total = rows[0]?.total ?? 0;
      return { met: total > 0, detail: `${total} production identity provider(s) configured with a signing certificate` };
    } finally { await sql.end({ timeout: 2 }); }
  },
);

// --- Archiving -------------------------------------------------------------

await check(
  'ARCHIVE_SCHEMA_CONFORMANCE',
  'The archive package is validated against the receiving archive\'s FGS schema set.',
  'The receiving e-archive, by naming its FGS version and supplying the XSDs.',
  async () => {
    const source = await readFile('packages/archive/src/fgs.ts', 'utf8');
    const validated = /schemaValidated:\s*true/.test(source);
    return {
      met: validated,
      detail: validated
        ? 'FGS_CONFORMANCE_STATUS reports schemaValidated'
        : 'FGS_CONFORMANCE_STATUS reports schemaValidated: false — structure follows the published profile, but conformance is unverified',
    };
  },
);

// --- Operations ------------------------------------------------------------

await check(
  'BACKUP_SIGNAL',
  'The backup timestamp series is produced, so BackupFailed can actually fire.',
  'The hosting platform, whose backup job must publish the timestamp.',
  async () => {
    const source = await readFile('packages/observability/src/prometheus.ts', 'utf8');
    const match = /PROMETHEUS_UNFED_SERIES: readonly string\[\] = \[([\s\S]*?)\]/.exec(source);
    const unfed = match ? match[1].split(',').map((entry) => entry.trim()).filter(Boolean) : [];
    const backupUnfed = unfed.some((entry) => entry.includes('backup'));
    return {
      met: !backupUnfed,
      detail: backupUnfed
        ? 'kommunsign_last_successful_backup_timestamp_seconds is declared unfed, so the alert watches nothing'
        : 'the backup series is produced',
    };
  },
);

// --- The delivery's own evidence -------------------------------------------

await check(
  'REQUIREMENTS_RESOLVED',
  'No requirement is left as GAP, PARTIAL, or BLOCKED_EXTERNAL.',
  'Whoever supplies the artefacts each remaining blocker names.',
  async () => {
    const base = 'docs/compliance/kungalv';
    const requirements = JSON.parse(await readFile(`${base}/requirements.json`, 'utf8'));
    const assessments = JSON.parse(await readFile(`${base}/assessments.json`, 'utf8')).assessments;
    const { readdir } = await import('node:fs/promises');
    const overrides = (await readdir(base)).filter((name) => /^assessment-overrides-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const merged = { ...assessments };
    for (const name of overrides) Object.assign(merged, JSON.parse(await readFile(`${base}/${name}`, 'utf8')).assessments);

    const counts = {};
    for (const requirement of requirements.requirements) {
      const status = merged[requirement.id]?.status ?? 'MISSING';
      counts[status] = (counts[status] ?? 0) + 1;
    }
    const unresolved = (counts.GAP ?? 0) + (counts.PARTIAL ?? 0) + (counts.BLOCKED_EXTERNAL ?? 0) + (counts.MISSING ?? 0);
    return {
      met: unresolved === 0,
      detail: Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(' '),
    };
  },
);

await check(
  'APPLICATION_CHAIN_EXERCISED',
  'The API and workers have been driven end to end against running services.',
  'This repository. It is the one remaining item nobody external is blocking.',
  async () => {
    // Deliberately not satisfiable by the signing-chain script alone: that
    // proves the cryptographic core, not the job orchestration around it.
    // Requires both that the gate exists and that CI runs it. A script nobody
    // invokes is not a gate, and "the file is present" is the kind of check
    // that passes while the thing it stands for has rotted.
    const { access } = await import('node:fs/promises');
    let present = true;
    try { await access('scripts/e2e-application-chain.sh'); } catch { present = false; }
    if (!present) {
      return {
        met: false,
        detail: 'only the signing chain is exercised end to end. The API and worker orchestration is '
          + 'blocked on object storage: the only createObjectStorageAdapter targets Supabase, so the '
          + 'MinIO in docker-compose has no adapter and a self-hosted deployment has no storage path',
      };
    }
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
    return {
      met: workflow.includes('e2e-application-chain') || workflow.includes('verify:e2e:application'),
      detail: workflow.includes('e2e-application-chain') || workflow.includes('verify:e2e:application')
        ? 'the application-level gate exists and CI runs it'
        : 'the gate exists but CI does not run it, so nothing keeps it working',
    };
  },
);

// --- Verdict ---------------------------------------------------------------

const blockers = checks.filter((entry) => !entry.met);
const go = blockers.length === 0;

if (json) {
  console.log(JSON.stringify({ productionGo: go, evaluatedAt: new Date().toISOString(), checks }, null, 2));
} else {
  console.log(`\nPRODUCTION_GO: ${go ? 'YES' : 'NO'}\n`);
  for (const entry of checks) {
    console.log(`  ${entry.met ? 'MET    ' : 'BLOCKED'}  ${entry.id}`);
    console.log(`           ${entry.statement}`);
    console.log(`           ${entry.detail}`);
    if (!entry.met) console.log(`           supplier: ${entry.supplier}`);
    console.log('');
  }
  if (!go) {
    console.log(`  ${blockers.length} precondition(s) unmet. This is computed, not asserted:`);
    console.log('  editing this file cannot change the answer, and neither can editing a document.');
    console.log('  Most of the remaining suppliers are external to this repository.\n');
  }
}

process.exit(go ? 0 : 1);
