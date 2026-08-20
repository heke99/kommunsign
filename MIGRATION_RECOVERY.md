# Kommunsign migration recovery

The first migration run was partially applied before failing on an existing enum.
For a fresh environment with no production data:

1. In the Control Supabase project, drop `control` and `kommunsign_meta`.
2. In the Data Supabase project, drop `app`, `audit`, and `kommunsign_meta`.
3. Replace `scripts/db-migrate.sh` with the included tracked runner.
4. Run `npm run db:migrate` once.
5. Run it a second time; all migrations must print `SKIP`.
6. Run `npm run db:verify`.

The tracked runner stores filename and SHA-256 in `kommunsign_meta.schema_migrations` and refuses checksum drift.

## Migrations marked `-- Transaction: none`

Some migrations use `CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses to run inside a
transaction block. `scripts/db-migrate.sh` detects the `-- Transaction: none` header and runs those
files without `--single-transaction`.

These files need a connection that does **not** wrap statements in a transaction. The Supabase
transaction pooler (port **6543**) does, so `CREATE INDEX CONCURRENTLY` fails there with:

```
ERROR: 25001: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

Two connections work: the direct database host, and the **session pooler** on port **5432**, which
hands the client a backend for the length of the session rather than per statement.

Which of the two you can reach depends on where you are running from:

| Connection | Host | IP |
|---|---|---|
| Direct | `db.<project-ref>.supabase.co:5432` | **IPv6 only** |
| Session pooler | `aws-0-<region>.pooler.supabase.com:5432` | IPv4 |
| Transaction pooler | `aws-0-<region>.pooler.supabase.com:6543` | IPv4 — **cannot run these migrations** |

GitHub's hosted runners have no IPv6, so the direct host is unreachable from Actions and the
**session pooler is the one to use there**. Locally, either works if your network has IPv6.

The workflow does not decide this from the hostname. It refuses port 6543 outright, and then proves
on the real connection that `CREATE INDEX CONCURRENTLY` succeeds -- on a throwaway table, before
anything touches the schema. A hostname is a guess; that is a test.

If such a migration fails partway, PostgreSQL can leave an `INVALID` index behind. Every one of these
files drops each index before recreating it, so re-running is safe. Confirm afterwards:

```sql
select indexrelid::regclass from pg_index where not indisvalid;
```

This must return no rows.

## Applying migrations to production

Use the **Database migration (production)** workflow
(`.github/workflows/db-migrate-production.yml`). Dispatch it with `action: status` to list what is
pending, then with `action: migrate` and the word `production` in the confirm box to apply.

It needs two repository secrets:

- `CONTROL_DATABASE_URL`
- `DATA_DATABASE_URL`

Anything except the transaction pooler on port 6543 -- see the table above. From GitHub Actions that
means the session pooler on port 5432, since the direct host is IPv6 only.

Run it with `action: status` first. That tests both connections and lists what is pending without
changing any schema.

After applying it re-runs the migrator to prove the pass was idempotent, and fails if any index was
left `INVALID`.

### Schema drift corrected 2026-08-19

Two control-plane tables had row level security **enabled with no policy**, which no migration does:

- `control.federation_assertion_ledger`
- `control.tenant_federation_role_mappings`

RLS with no policy is not a control. It denies every row to any role that does not hold `BYPASSRLS`
and does nothing at all to one that does, so it was inert only because the runtime role currently
bypasses RLS — and would have broken workforce federation login at the moment that changes. Neither
table is reachable by `anon` or `authenticated` (no grants, no schema `USAGE`), so nothing was
protected by it. Both were set back to the state the migrations define.

If row level security on the control plane is wanted, it needs policies and a migration, not a
dashboard toggle.
