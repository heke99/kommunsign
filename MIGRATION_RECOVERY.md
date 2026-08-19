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

These files must be applied over a **direct (session mode) connection**, not the Supabase transaction
pooler. The pooler wraps statements in a transaction, so `CREATE INDEX CONCURRENTLY` fails there with:

```
ERROR: 25001: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

Point `CONTROL_DATABASE_URL` / `DATA_DATABASE_URL` at the direct database host for the migration run.

If such a migration fails partway, PostgreSQL can leave an `INVALID` index behind. Every one of these
files drops each index before recreating it, so re-running is safe. Confirm afterwards:

```sql
select indexrelid::regclass from pg_index where not indisvalid;
```

This must return no rows.
