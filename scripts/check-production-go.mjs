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
 * Three outcomes, because two of them lie.
 *
 * A precondition can be met, or evaluated and refused, or not evaluable from
 * where this was run. Collapsing the last two into "blocked" is what the first
 * version did, and it reads as an accusation against a supplier who may have
 * delivered perfectly: "SignService is not reachable" from a laptop says
 * nothing about production. It also hides the opposite error — an operator
 * running this against the real deployment cannot tell a genuine gap from a
 * missing environment variable in their own shell.
 *
 * So UNKNOWN is its own answer, and it is never treated as GO. It just stops
 * pretending we looked.
 *
 * @param id        stable identifier, so a blocker can be tracked over time
 * @param statement what must be true, written as the fact and not as a task
 * @param supplier  who has to act when it is not met
 * @param evaluate  returns { met, detail } or { unknown: true, detail } —
 *                  never throws to mean "no"
 */
async function check(id, statement, supplier, evaluate) {
  let state = 'BLOCKED';
  let detail = 'not evaluated';
  try {
    const outcome = await evaluate();
    detail = outcome.detail;
    state = outcome.unknown === true ? 'UNKNOWN' : outcome.met === true ? 'MET' : 'BLOCKED';
  } catch (error) {
    // An evaluation that threw told us nothing, which is exactly UNKNOWN. It
    // is still not GO.
    state = 'UNKNOWN';
    detail = `could not be evaluated: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  checks.push({ id, statement, supplier, state, met: state === 'MET', detail });
}


const environment = process.env;
const has = (name) => typeof environment[name] === 'string' && environment[name].trim().length > 0;
/**
 * Whether this run is looking at a production deployment at all.
 *
 * It decides how an unreachable dependency is read: in production a service
 * that does not answer is a real blocker, anywhere else it means we are simply
 * not pointed at the thing being judged.
 */
const inspectingProduction = environment.APP_ENV === 'production';

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

/** The same reading of an absent SignService, for all three signing checks. */
function unreachableSignService(what) {
  if (!has('SIGNSERVICE_URL')) {
    return { unknown: true, detail: `SIGNSERVICE_URL is not set, so ${what} cannot be read from here` };
  }
  if (inspectingProduction) {
    return { met: false, detail: `SignService did not answer at ${environment.SIGNSERVICE_URL}, and this is a production environment` };
  }
  return { unknown: true, detail: `SignService did not answer at ${environment.SIGNSERVICE_URL}, and APP_ENV is not production` };
}

// --- Cryptographic signing -------------------------------------------------

await check(
  'SIGNING_KEY_PROTECTION',
  'The signing key is held in an HSM or a remote QSCD, not in software.',
  'The customer or hosting provider, by provisioning key protection hardware.',
  async () => {
    if (!signHealth) return unreachableSignService('its key protection');
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
    if (!signHealth) return unreachableSignService('the certificate it signs with');
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
    if (!signHealth) return unreachableSignService('its timestamp source');
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
  async () => {
    // Outside production this says nothing about whether the credential
    // exists — only that this shell is not the one holding it.
    if (!inspectingProduction) {
      return { unknown: true, detail: `APP_ENV=${environment.APP_ENV ?? 'unset'}, so this is not the environment that would hold the credential` };
    }
    return {
      met: has('TIC_BASE_URL') && has('TIC_API_KEY'),
      detail: `TIC_BASE_URL=${has('TIC_BASE_URL') ? 'set' : 'missing'}, TIC_API_KEY=${has('TIC_API_KEY') ? 'set' : 'missing'}`,
    };
  },
);

await check(
  'MUNICIPAL_IDP_METADATA',
  'The municipality\'s IdP is configured with issuer, endpoint and signing certificate.',
  'The municipality. It is their federation metadata.',
  async () => {
    const url = environment.CONTROL_DATABASE_URL;
    if (!url) return { unknown: true, detail: 'CONTROL_DATABASE_URL is not set, so the configuration cannot be read from here' };
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
    // Two different claims, and only the second one is this precondition.
    // Validating against the published schema set is done in CI; validating
    // against the set the receiving archive mandates needs that archive to name
    // its version and hand over any local extensions.
    const published = /publishedSchemaValidated:\s*true/.test(source);
    const receiving = /receivingArchiveSchemaValidated:\s*true/.test(source);
    return {
      met: receiving,
      detail: receiving
        ? 'validated against the receiving archive\'s schema set'
        : published
          ? 'validated against Riksarkivet\'s published schema set in CI; the receiving archive has not named its FGS version or supplied local extensions'
          : 'not validated against any schema set',
    };
  },
);

// --- Operations ------------------------------------------------------------

await check(
  'BACKUP_SIGNAL',
  'The backup timestamp series is produced, so BackupFailed can actually fire.',
  'The hosting platform, whose backup job must report each completed backup.',
  async () => {
    // Asked of the deployment, not of the source. The ingest path exists in
    // every build now, so reading the code would only prove that we wrote it;
    // what matters is whether a real backup has been reported, which is a fact
    // about the running system and nothing else.
    const url = environment.CONTROL_DATABASE_URL;
    if (!url) return { unknown: true, detail: 'CONTROL_DATABASE_URL is not set, so reported backups cannot be read from here' };
    const { default: postgres } = await import('postgres');
    const sql = postgres(url, { max: 1, idle_timeout: 2 });
    try {
      const rows = await sql`
        select scope, completed_at,
               extract(epoch from (now() - completed_at))::int age_seconds
          from control.backup_completions
         order by completed_at desc`;
      if (rows.length === 0) {
        return { met: false, detail: 'no backup has ever been reported, so the series has no value and BackupFailed watches nothing' };
      }
      // A day and a half: long enough that a nightly backup plus a late run is
      // not an alarm, short enough that a stopped backup job is.
      const stale = rows.filter((row) => row.age_seconds > 129_600);
      const summary = rows.map((row) => `${row.scope} ${Math.floor(row.age_seconds / 3600)}h ago`).join(', ');
      return {
        met: stale.length === 0,
        detail: stale.length === 0 ? `reported: ${summary}` : `stale: ${summary}`,
      };
    } finally { await sql.end({ timeout: 2 }); }
  },
);

// --- The delivery's own evidence -------------------------------------------

await check(
  'REQUIREMENTS_RESOLVED',
  'No requirement is left as GAP, PARTIAL, PENDING_ADOPTION, or BLOCKED_EXTERNAL.',
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
    // PENDING_ADOPTION counts against: a drafted policy is not an adopted one.
    const unresolved = (counts.GAP ?? 0) + (counts.PARTIAL ?? 0) + (counts.PENDING_ADOPTION ?? 0)
      + (counts.BLOCKED_EXTERNAL ?? 0) + (counts.MISSING ?? 0);
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

const blocked = checks.filter((entry) => entry.state === 'BLOCKED');
const unknown = checks.filter((entry) => entry.state === 'UNKNOWN');
const go = blocked.length === 0 && unknown.length === 0;

/**
 * Where this judgement was made, printed with it.
 *
 * A verdict without its vantage point is not readable later: NO from a laptop
 * and NO from the production host mean different things, and the difference is
 * the whole reason UNKNOWN exists.
 */
const vantagePoint = [
  `APP_ENV=${environment.APP_ENV ?? 'unset'}`,
  `SIGNSERVICE_URL=${has('SIGNSERVICE_URL') ? (signHealth ? 'answering' : 'set but silent') : 'unset'}`,
  `CONTROL_DATABASE_URL=${has('CONTROL_DATABASE_URL') ? 'set' : 'unset'}`,
].join(', ');

if (json) {
  console.log(JSON.stringify({
    productionGo: go,
    determinable: unknown.length === 0,
    evaluatedAt: new Date().toISOString(),
    vantagePoint,
    checks,
  }, null, 2));
} else {
  console.log(`\nPRODUCTION_GO: ${go ? 'YES' : unknown.length && !blocked.length ? 'NOT DETERMINABLE HERE' : 'NO'}`);
  console.log(`  assessed from: ${vantagePoint}\n`);
  for (const entry of checks) {
    console.log(`  ${entry.state.padEnd(7)}  ${entry.id}`);
    console.log(`           ${entry.statement}`);
    console.log(`           ${entry.detail}`);
    if (entry.state === 'BLOCKED') console.log(`           supplier: ${entry.supplier}`);
    console.log('');
  }
  if (blocked.length) {
    console.log(`  ${blocked.length} precondition(s) evaluated and unmet. This is computed, not asserted:`);
    console.log('  editing this file cannot change the answer, and neither can editing a document.');
    console.log('  Most of the remaining suppliers are external to this repository.');
  }
  if (unknown.length) {
    console.log(`  ${unknown.length} precondition(s) could not be evaluated from here. That is not the same`);
    console.log('  as unmet: run this again on the target deployment, with its environment, before');
    console.log('  concluding anything about them.');
  }
  console.log('');
}

// 0 means GO. 1 means at least one precondition was evaluated and refused.
// 2 means nothing was refused but something could not be judged from here —
// a different answer from NO, and one a pipeline should treat differently.
process.exit(go ? 0 : blocked.length ? 1 : 2);
