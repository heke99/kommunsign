# Supabase control plane och data plane

KommunSign separerar:

- Control plane: ansökningar, tenantregister, domäner, provisioning, readiness och plattformsaudit.
- Data plane: användare, roller, dokument, signeringsärenden, signaturer, evidence, webhooks och tenant-audit.

Produktionsruntime använder `CONTROL_DATABASE_URL` och `DATA_DATABASE_URL` via PostgreSQL-drivern `postgres`. Tenantoperationer körs genom `withTenantTransaction`, som sätter `app.tenant_id`, actor, request, authmetod och actor kind lokalt i transaktionen.

`control.data_planes` lagrar bara secret references. Frontend får aldrig ta emot service role key eller databas-URL. Shared SaaS är implementerad som första produktionsväg. Dedicated/customer-hosted kräver en hemlighetsresolver och dynamisk anslutningspool per `data_plane_id`; detta är fortfarande en blockerare innan dessa driftmodeller kan aktiveras.


## Konkreta backendadaptrar

- `apps/api/src/adapters/supabase-storage.ts` använder Supabase Storage server-side med service role, privata bucketar, tenantbundna objektnycklar och signerade uppladdnings-URL:er.
- `apps/api/src/adapters/aes-gcm-sensitive-data.ts` krypterar känsliga värden med AES-256-GCM och använder separat HMAC-nyckel för blindindex.
- `apps/api/src/adapters/postgres-queue.ts` skriver beständiga jobb till data planets `app.durable_jobs`.
- `apps/workers/src/postgres-production-adapter.ts` kan claima, slutföra, retrya och dead-lettera jobb mot PostgreSQL. Endast `TENANT_PROVISION` har en komplett produktionshandler i denna leverans; övriga jobbtyper avvisas explicit och får inte betraktas som implementerade.

Supabase Storage-adaptern och databasrutningen är statiskt verifierade men inte liveverifierade mot kundens Supabase-projekt eftersom hemligheter saknades.
