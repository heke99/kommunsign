# Runbook: verifying each go-live artefact the day it arrives

## When to use this

Every precondition in `npm run check:production-go` that is still BLOCKED or
UNKNOWN is waiting on an artefact from someone outside this repository — a
certificate authority, a timestamp authority, the municipality, the receiving
e-archive, the hosting platform. This runbook is the other half: for each one,
the command that proves it works once it lands, and what a good answer looks
like.

The point is that no artefact should be accepted on the strength of somebody
saying it is configured. Every item below ends in a command whose output is the
evidence.

## First: run the gate where the deployment is

```bash
npm run check:production-go
```

It reports three states, and the difference matters:

- **MET** — evaluated, and the answer is yes.
- **BLOCKED** — evaluated, and the answer is no. A supplier is named.
- **UNKNOWN** — could not be evaluated from here. Not the same as no.

Run from a laptop, five of nine come back UNKNOWN, because a laptop has no
SignService and no control database. That is why the verdict prints its own
vantage point on the second line. **Run it on the target deployment, with that
deployment's environment**, or the answer is about your shell rather than about
production.

Exit codes: `0` go, `1` something was refused, `2` nothing was refused but
something could not be judged.

## Signing certificate, key protection, timestamp authority

*Suppliers: a CA; the hosting provider or an HSM vendor; a TSA under contract.*
*Opens: F001, F013, `SIGNING_CERTIFICATE`, `SIGNING_KEY_PROTECTION`,
`TIMESTAMP_AUTHORITY`.*

These three arrive separately but are verified together, because SignService
reports them together and refuses to call itself production-ready until all
three hold.

1. Configure SignService with the credential. Point
   `KOMMUNSIGN_SIGNING_KEYSTORE_PATH` (or the HSM/QSCD configuration) at the
   real key, and set the TSA URL.
2. Ask the service what it thinks it has:

```bash
curl -s "$SIGNSERVICE_URL/health" | jq
```

Good answer:

```json
{
  "keyProtection": "HSM",            // not SOFTWARE
  "timestampConfigured": true,
  "supportedPadesLevels": ["PAdES-B", "PAdES-T"],
  "productionReady": true
}
```

3. Sign something real and have it independently validated:

```bash
npm run verify:e2e:signing
```

This is the same command that runs in CI against a generated test CA. With the
real credential in place it is the same chain, and it still checks the negative
case: a signature that chains to an untrusted CA must come back
`422 FAIL / TOTAL_FAILED`. If it does not, the trust anchors are wrong and
everything else it says is worthless.

**Do not accept `keyProtection: SOFTWARE` in production.** It is what an
unconfigured deployment reports, and the gate refuses it for that reason.

## BankID production credentials

*Supplier: the BankID provider, through the customer.*
*Opens: F003, `BANKID_PRODUCTION_CREDENTIALS`.*

1. Set `TIC_BASE_URL`, `TIC_API_KEY`, `TIC_CALLBACK_URL`, `TIC_WEBHOOK_URL` and
   `TIC_WEBHOOK_SECRET` in the production environment, and
   `TIC_BANKID_ENABLED=true`.
2. Provision a tenant. BankID rollout is seeded from the deployment's own
   configuration, so a tenant provisioned while BankID is unconfigured cannot
   start a session:

```sql
SELECT tic_bankid_rollout_enabled FROM app.tenant_signing_settings WHERE tenant_id = '…';
```

3. Sign one document end to end with a real BankID, and then read what the
   system recorded rather than what the screen said:

```sql
SELECT it.status, it.failure_code, a.verification_result, s.status
  FROM app.identity_transactions it
  JOIN app.tic_identity_artifacts a ON a.identity_transaction_id = it.id
  JOIN app.signers s ON s.id = it.signer_id
 WHERE it.tenant_id = '…' ORDER BY it.started_at DESC LIMIT 1;
```

Good answer: `verified`, no failure code, `PASS`, `signed`.

A signer that reached `signed` while `verification_result` is anything other
than `PASS` is the failure this whole design exists to prevent. Stop and
escalate; do not go live.

## The municipality's IdP metadata

*Supplier: Kungälvs kommun.*
*Opens: F004, `MUNICIPAL_IDP_METADATA`.*

Needed: EntityID, SSO endpoint, and the signing certificate. Nothing in the code
names a vendor; connecting a different IdP is configuration.

1. Register the provider for the tenant in
   `control.tenant_identity_providers`, with `enabled = true`,
   `environment = 'production'`, and `public_configuration` carrying `issuer`
   and `signingCertificateBase64`.
2. Confirm the gate can see it:

```bash
npm run check:production-go     # MUNICIPAL_IDP_METADATA should read MET
```

3. Log in once through the municipality's IdP, then check that the assertion was
   consumed exactly once and cannot be replayed:

```sql
SELECT assertion_id, consumed_at FROM control.federation_assertion_ledger
 ORDER BY consumed_at DESC LIMIT 5;
```

Replaying the same assertion must be refused. `tests/sql/federation-replay.sql`
proves the guard; this confirms it is the path production actually takes.

## The receiving archive's FGS version and local extensions

*Supplier: the municipality's e-archive.*
*Opens: 2064, 2065, `ARCHIVE_SCHEMA_CONFORMANCE`.*

The package already validates against Riksarkivet's published schema set, in CI:

```bash
npm run verify:fgs      # needs validation-service running
```

What remains is the archive's own set. When they supply it:

1. Put their XSDs alongside the published ones in
   `services/validation-service/src/main/resources/fgs/`, and record where they
   came from and their digests in `PROVENANCE.txt`. Bundled, not fetched — a
   conformance check that depends on a remote host is a different check every
   time the host changes the file.
2. Add them to `BUNDLED_SCHEMAS` in `FgsPackageValidator.java`.
3. Re-run `npm run verify:fgs`. Expect it to fail at first: the published set
   caught two profile violations the first time it ran, and a local extension
   set is stricter again.
4. Only then set `receivingArchiveSchemaValidated: true` in
   `packages/archive/src/fgs.ts`. That flag is what the gate reads, and setting
   it before step 3 passes is the overclaim this whole arrangement exists to
   prevent.

## The backup timestamp

*Supplier: the hosting platform.*
*Opens: 2037, 3533, `BACKUP_SIGNAL`.*

The receiving side is built. What is missing is one call from whoever takes the
backups.

1. Generate an ingest credential and set `BACKUP_SIGNAL_TOKEN` (32 characters or
   more; a shorter one leaves the route closed). It must **not** be the same
   value as `METRICS_SCRAPE_TOKEN` — reading operational state and silencing the
   missing-backup alert are different powers.
2. Have the backup job call this on every successful run:

```bash
curl -fsS -X POST "$API_BASE_URL/metrics/backup-completions" \
  -H "authorization: Bearer $BACKUP_SIGNAL_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"scope\":\"control-database\",\"completedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"reportedBy\":\"platform-backup-job\"}"
```

Expect `202`. A timestamp in the future is refused with `422`, deliberately: it
would silence `BackupFailed` for as long as it stayed ahead of the clock.

3. Confirm the series is now real:

```bash
curl -s -H "authorization: Bearer $METRICS_SCRAPE_TOKEN" "$API_BASE_URL/metrics" \
  | grep kommunsign_last_successful_backup_timestamp_seconds
```

4. `BACKUP_SIGNAL` reads MET once a report is less than 36 hours old. It goes
   back to BLOCKED on its own if reports stop, which is the entire point.

Restore evidence (3533) is separate and cannot be produced by reporting: someone
has to restore a backup and record what happened.

## Repository controls

*Opens: part of 3525.*

Not settable from this repository — a person with admin rights has to do it in
the GitHub settings:

- Require these checks on `main`: `verify`, `java-services`,
  `signing-chain-e2e`, `object-storage`, `application-chain-e2e`, `database`.
  They all pass today; until they are required, nothing stops a red run being
  merged.
- Require a pull request before merging.

Source deposition already has its evidence: `FILE_MANIFEST.sha256` and
`PROVENANCE_REPORT.txt`, regenerated by `npm run verify:provenance`. The escrow
agreement itself is a contract, not a control.

## When everything above is done

```bash
npm run check:production-go
```

The remaining BLOCKED entries will be the ones no technical step can close:
contracts, pricing, reference customers, the supplier's management system, and
the organisational requirements listed in
`docs/compliance/kungalv/EXTERNAL_EVIDENCE_BLOCKERS.md`. Those move when they
are adopted and recorded, not when code changes.
