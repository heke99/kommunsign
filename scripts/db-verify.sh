#!/usr/bin/env bash
set -euo pipefail
: "${CONTROL_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5433/kommunsign_control}"
: "${DATA_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5434/kommunsign_data}"
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 1; }
psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select count(*) >= 0 from control.platform_tenants" | grep -qx t
psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/onboarding-control.sql
psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/control/verify_accounts.sql
psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/control/verify_organization_creation.sql
psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/data/verify.sql
psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/data/verify_organization_creation.sql
psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/tenant-isolation.sql
psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/pades-signature-chain.sql
psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/webhook-delivery.sql
psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/archive-export.sql
