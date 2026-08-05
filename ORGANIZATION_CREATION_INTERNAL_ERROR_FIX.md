# Rättning – organisationsskapande gav `INTERNAL_ERROR`

Datum: 2026-08-04

## Rotorsak

Superadminportalen kunde läsa organisationer men `POST /v1/platform/organizations` använde två databaskontrakt som inte kontrollerades före skrivning:

1. `control.onboarding_idempotency_keys.response_body_ciphertext` i control-databasen.
2. `app.durable_jobs` med unik nyckel för `(tenant_id, job_type, idempotency_key)` i data-databasen.

Om en migration var registrerad men den verkliga databasen hade schemadrift, eller om control- och data-migrationerna inte hade körts till samma release, kastade PostgreSQL ett `PostgresError`. API:t maskerade korrekt det interna databasmeddelandet men loggade bara `INTERNAL_REQUEST_FAILURE`, vilket gjorde felet omöjligt att avgränsa i Railway.

## Ändringar

- Control-migration `0012_organization_creation_runtime_repair.sql` återställer den krypterade idempotenskolumnen och lägger till en fail-closed kontroll av organisationsskapandets schema.
- Data-migration `0015_organization_provisioning_queue_runtime_repair.sql` återställer den beständiga provisioneringskön, idempotensindex och RLS-policy om migrationshistorik och schema har glidit isär.
- API:t kör kontrollplanskontraktet före den första organisationsskrivningen.
- PostgreSQL-fel klassificeras som:
  - `DATABASE_SCHEMA_OUTDATED`
  - `DATABASE_PERMISSION_DENIED`
  - `DATABASE_UNAVAILABLE`
- Railway-loggen innehåller nu säker metadata: SQLSTATE, schema, tabell, kolumn, constraint och rutin. Varken SQL-fråga, parametrar, e-post eller personuppgifter loggas.
- Superadminportalen visar en konkret svensk åtgärd i stället för enbart `INTERNAL_ERROR`.
- `npm run db:verify` kontrollerar nu både control-kontraktet och provisioneringskön.

## Driftsättning

Kör från projektroten med produktionsdatabasernas anslutningssträngar satta:

```bash
npm run db:migrate
npm run db:verify
```

Deploya därefter API och worker från samma commit/release. Skapa sedan organisationen igen. Den tidigare misslyckade transaktionen rullades tillbaka och har därför normalt inte lämnat en halvskapad organisation.

## Förväntad verifiering

Control-verifieringen ska skriva:

```text
organization_creation_control_runtime_ok
```

Data-verifieringen ska skriva:

```text
organization_creation_queue_runtime_ok
```

Vid fortsatt fel ska Railway-loggen för samma `requestId` nu visa till exempel `sqlState`, `databaseSchema`, `databaseTable` eller `databaseConstraint`, vilket gör nästa fel exakt identifierbart utan att exponera känslig data.
