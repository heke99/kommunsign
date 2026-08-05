# Korrigering: DATA_PLANE_NOT_READY och fastnat organisationsskapande

## Grundorsak

`control.data_planes` innehöll endast `legacy-shared-data-plane` med:

- status `degraded`
- region `unassigned`
- saknad `storage_secret_reference`

Provisioneringsworkern kräver samtidigt en post med driftform `shared_saas`, status `ready`, samma region som ansökan och en storage-referens. Därför kunde steget `assign_data_plane` aldrig slutföras.

Det fanns även ett köfel: när provisioneringen returnerade `waiting_for_external_dependency` markerades det beständiga jobbet som `completed`. En senare rättad extern kontroll kunde därför inte få jobbet att fortsätta utan manuell omköning.

## Ändringar

1. `migrations/control/0015_shared_saas_data_plane_runtime.sql`
   - registrerar shared-SaaS-datamiljön som `ready` i `se-central`
   - sätter databas- och storage-secret references
   - återställer berörda `assign_data_plane`-steg
   - flyttar blockerade provisioning requests tillbaka till `queued`

2. `apps/workers/src/postgres-production-adapter.ts`
   - behandlar `waiting_for_external_dependency` som retrybart i den beständiga kön
   - återupplivar avslutade eller dead-letter-köjobb när control plane fortfarande väntar
   - undviker att duplicera ett jobb som redan har en aktiv lease

3. `apps/api/src/production-adapters/postgres/onboarding-repository.ts`
   - använder korrekt stegordning: `assign_data_plane` före `create_environment`
   - normaliserar shared-SaaS-regionen till `se-central`

4. `migrations/control/verify_organization_creation.sql`
   - verifierar att en produktionsklar shared-SaaS-datamiljö verkligen finns

5. `tests/run.mjs`
   - skyddstest för data-plane-registret, worker recovery och stegordningen

## Körordning

```bash
cd /Users/hekmath/Projects/kommunsign
npm run db:migrate
npm run db:verify
npm run build
git add .
git commit -m "Fix shared SaaS data plane provisioning recovery"
git push
```

Deploya därefter både API- och workers-tjänsten. Worker-starten återupplivar den befintliga fastnade provisioneringsbegäran.

Första migreringen ska visa:

```text
APPLY control/0015_shared_saas_data_plane_runtime.sql
```

## Kontroller som passerade

- TypeScript 5.8.3
- 6 portalbyggen
- SQL-migrationskontroll
- repository-verifiering
- 43 enhetstester
- integrationstest för ansökan, provisionering och direkt organisationsskapande
- säkerhetstester
