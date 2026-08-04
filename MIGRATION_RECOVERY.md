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
