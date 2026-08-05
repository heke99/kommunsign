# Kommunsign – Postgres audit/invitation fix

## Symptom

`POST /v1/platform/organizations/{tenantId}/users` sends the Supabase email but returns HTTP 500. Railway logs a `PostgresError` with SQLSTATE `42883` and routine `ParseFuncOrColumn`.

## Root cause

The tenant provisioning transaction ends by calling `audit.append_event`. That function called `digest(...)` without a schema qualifier while its security-definer search path was restricted to `audit, app, pg_temp`. In Supabase, `pgcrypto` is normally installed in the `extensions` schema, so PostgreSQL could not resolve `digest(bytea,text)` and raised SQLSTATE `42883`.

Because the external Supabase invite was already delivered, the user received an email even though the local tenant user, membership, role assignment and invitation status were rolled back or marked failed.

## Fix

- Adds `migrations/data/0016_pgcrypto_audit_runtime_repair.sql`.
- Detects the actual schema that owns `pgcrypto` from `pg_extension`.
- Recreates `audit.append_event` with a schema-qualified call to `<pgcrypto_schema>.digest`.
- Adds a database verification rule that fails if the audit function loses the qualification.
- Maps PostgreSQL schema errors such as `42883` to `DATABASE_SCHEMA_OUTDATED` instead of generic `INTERNAL_ERROR`.

## Apply

```bash
npm run db:migrate
npm run db:verify
npm run build
```

The migration output must include:

```text
APPLY data/0016_pgcrypto_audit_runtime_repair.sql
```

Deploy/redeploy the API after the migration. A worker redeploy is not required for this specific endpoint, but deploying the same commit to all backend services keeps versions consistent.

Retry **Bjud in huvudadmin**. Supabase will find the existing unconfirmed identity, Kommunsign will create the local tenant access, and then send a fresh password-recovery/activation link.
