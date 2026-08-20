#!/usr/bin/env bash
set -euo pipefail
: "${CONTROL_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5433/kommunsign_control}"
: "${DATA_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5434/kommunsign_data}"
# kommunsign_meta holds the migration ledger, and dropping it is the point.
# Without it the reset left the ledger claiming every migration was applied
# while the schemas it had just dropped were gone, so the following db-migrate
# skipped all of them and produced an empty database that reported itself fully
# migrated. Every "verified from scratch" run since was verifying nothing.
for url in "$CONTROL_DATABASE_URL" "$DATA_DATABASE_URL"; do
  psql "$url" -v ON_ERROR_STOP=1 -c 'drop schema if exists control cascade; drop schema if exists app cascade; drop schema if exists audit cascade; drop schema if exists kommunsign_meta cascade;'
done
bash scripts/db-migrate.sh
bash scripts/db-verify.sh
