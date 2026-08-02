#!/usr/bin/env bash
set -euo pipefail
: "${CONTROL_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5433/kommunsign_control}"
: "${DATA_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5434/kommunsign_data}"
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 1; }
for migration in migrations/control/*.sql; do psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; done
for migration in migrations/data/[0-9][0-9][0-9][0-9]_*.sql; do psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; done
