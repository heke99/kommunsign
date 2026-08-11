#!/usr/bin/env bash
set -euo pipefail

: "${CONTROL_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5433/kommunsign_control}"
: "${DATA_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5434/kommunsign_data}"

command -v psql >/dev/null || { echo 'psql is required' >&2; exit 1; }
command -v shasum >/dev/null || { echo 'shasum is required' >&2; exit 1; }

ensure_registry() {
  local database_url="$1"
  psql "$database_url" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS kommunsign_meta;
CREATE TABLE IF NOT EXISTS kommunsign_meta.schema_migrations (
  migration_scope text NOT NULL,
  migration_file text NOT NULL,
  migration_checksum text NOT NULL CHECK (migration_checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_scope, migration_file)
);
REVOKE ALL ON SCHEMA kommunsign_meta FROM PUBLIC;
REVOKE ALL ON TABLE kommunsign_meta.schema_migrations FROM PUBLIC;
SQL
}

read_recorded_checksum() {
  local database_url="$1"
  local migration_scope="$2"
  local migration_file="$3"
  psql "$database_url" -v ON_ERROR_STOP=1 -At \
    -v migration_scope="$migration_scope" -v migration_file="$migration_file" <<'SQL'
SELECT migration_checksum
FROM kommunsign_meta.schema_migrations
WHERE migration_scope = :'migration_scope'
  AND migration_file = :'migration_file';
SQL
}

write_registry() {
  local database_url="$1"
  local migration_scope="$2"
  local migration_file="$3"
  local checksum="$4"
  psql "$database_url" -v ON_ERROR_STOP=1 \
    -v migration_scope="$migration_scope" -v migration_file="$migration_file" -v migration_checksum="$checksum" <<'SQL'
INSERT INTO kommunsign_meta.schema_migrations (migration_scope,migration_file,migration_checksum)
VALUES (:'migration_scope',:'migration_file',:'migration_checksum');
SQL
}

apply_migration() {
  local database_url="$1"
  local migration_scope="$2"
  local migration="$3"
  local migration_file checksum recorded_checksum registry_statement

  migration_file="$(basename "$migration")"
  checksum="$(shasum -a 256 "$migration" | awk '{print $1}')"
  recorded_checksum="$(read_recorded_checksum "$database_url" "$migration_scope" "$migration_file")"

  if [[ -n "$recorded_checksum" ]]; then
    if [[ "$recorded_checksum" != "$checksum" ]]; then
      echo "Migration checksum mismatch: ${migration_scope}/${migration_file}" >&2
      echo "Recorded: $recorded_checksum" >&2
      echo "Current:  $checksum" >&2
      exit 1
    fi
    echo "SKIP ${migration_scope}/${migration_file} (already applied)"
    return
  fi

  echo "APPLY ${migration_scope}/${migration_file}"

  if grep -Eq '^-- Transaction: none[[:space:]]*$' "$migration"; then
    # PostgreSQL operations such as CREATE INDEX CONCURRENTLY cannot execute in
    # a transaction block. These migrations must therefore be explicitly
    # marked and written to be safe to retry if registry persistence fails.
    psql "$database_url" -v ON_ERROR_STOP=1 -f "$migration"
    write_registry "$database_url" "$migration_scope" "$migration_file" "$checksum"
    return
  fi

  registry_statement="$(mktemp)"
  trap 'rm -f "$registry_statement"' RETURN
  cat > "$registry_statement" <<'SQL'
INSERT INTO kommunsign_meta.schema_migrations (
  migration_scope,
  migration_file,
  migration_checksum
)
VALUES (
  :'migration_scope',
  :'migration_file',
  :'migration_checksum'
);
SQL

  # Transactional migrations and registry persistence remain atomic.
  psql "$database_url" \
    -v ON_ERROR_STOP=1 \
    --single-transaction \
    -v migration_scope="$migration_scope" \
    -v migration_file="$migration_file" \
    -v migration_checksum="$checksum" \
    -f "$migration" \
    -f "$registry_statement"

  rm -f "$registry_statement"
  trap - RETURN
}

ensure_registry "$CONTROL_DATABASE_URL"
ensure_registry "$DATA_DATABASE_URL"

for migration in migrations/control/[0-9][0-9][0-9][0-9]_*.sql; do
  apply_migration "$CONTROL_DATABASE_URL" control "$migration"
done

for migration in migrations/data/[0-9][0-9][0-9][0-9]_*.sql; do
  apply_migration "$DATA_DATABASE_URL" data "$migration"
done
