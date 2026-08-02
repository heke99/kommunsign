#!/usr/bin/env bash
set -euo pipefail
: "${CONTROL_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5433/kommunsign_control}"
: "${DATA_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5434/kommunsign_data}"
for url in "$CONTROL_DATABASE_URL" "$DATA_DATABASE_URL"; do
  psql "$url" -v ON_ERROR_STOP=1 -c 'drop schema if exists control cascade; drop schema if exists app cascade; drop schema if exists audit cascade;'
done
bash scripts/db-migrate.sh
bash scripts/db-verify.sh
