# Kommunsign – komplett granskning av ansökan, organisation och huvudadmin

Källa: `kommunsign-main(9).zip`.

## Granskat flöde

1. Ansökan skapas och e-post verifieras.
2. Ansökan skickas in.
3. Superadmin godkänner.
4. Provisioneringsbegäran och durable job skapas.
5. Worker skapar tenant, tilldelar data plane, skapar produktionsmiljö, standarddomän, storage, roller och policyer.
6. Tenant, miljö, provisioneringsbegäran och ansökan får konsekventa statusar.
7. Superadmin bjuder in huvudadmin.
8. API verifierar att tenant, datamiljö, organisation och `tenant_admin`-rollen finns innan Supabase Auth kontaktas.
9. Lokal användare, medlemskap och roll skapas idempotent.
10. Den inbjudne öppnar länken, väljer eget lösenord och loggas in mot rätt organisation.

## Fel som fanns i senaste zippen

- Ingen produktionsklar `shared_saas`-data plane fanns. Alla organisationer kunde fastna på `DATA_PLANE_NOT_READY`.
- Steglistan placerade `create_environment` före `assign_data_plane` trots att miljön kräver en tilldelad data plane.
- Ett väntande provisioneringsjobb kunde bli avslutat i durable queue och därefter inte fortsätta.
- En slutförd provisionering kunde lämna `platform_tenants.status='provisioning'`, vilket gav motstridiga statusar i UI.
- Supabase kunde skicka ett riktigt inbjudningsmejl innan lokal användare, medlemskap och roll var verifierade. Ett efterföljande databasfel gav då `INTERNAL_ERROR` trots att mejlet kom fram.
- Ett återförsök kunde skapa otydliga eller dubbla utskick och saknade säker återhämtning för en redan skapad, ej bekräftad Supabase-identitet.
- Kända Auth- och kontoprovisioneringsfel doldes som generiskt `INTERNAL_ERROR`.
- Ansökningsprofilen krävde manuell e-postdomän och driftprofil trots att dessa kan härledas säkert.

## Korrigeringar

- Migration `0015_shared_saas_data_plane_runtime.sql` registrerar den gemensamma data-miljön som `ready` i `se-central` och återköar blockerade förfrågningar.
- Workern återställer recoverable provisioning jobs vid start och gör väntande externa beroenden retrybara.
- Provisioneringsordningen är nu `create_tenant → assign_data_plane → create_environment`.
- Migration `0016_consistent_tenant_and_account_activation.sql` och runtime-koden synkar tenant, miljö och ansökan till `onboarding` efter slutförd provisionering.
- Inbjudnings-API:t gör fail-closed preflight mot control- och data-databasen innan Supabase kontaktas.
- Lokala användare, medlemskap och roller skapas idempotent.
- En redan skickad men lokalt misslyckad inbjudan återanvänder samma Supabase-identitet. Lokal åtkomst repareras först; därefter skickas en ny giltig lösenordslänk.
- Samma idempotency key får inte återanvändas med ändrad e-post, namn eller roll.
- Kända fel returneras med tydliga 4xx/5xx-koder i stället för generiskt `INTERNAL_ERROR`.
- Nya ansökningar får automatiskt e-postdomän från kontaktadressen och standarddrift `shared_saas / se-central`.
- Aktiverings- och återställningsportalerna låter användaren välja ett eget lösenord med minst 12 tecken, liten/stor bokstav, siffra och specialtecken.

## Korrekt återhämtning för den nuvarande huvudadmininbjudan

Efter migration och deployment:

1. Vänta tills organisationen visar `Organisation skapad`.
2. Klicka `Bjud in huvudadmin` igen.
3. Om Supabase-identiteten redan skapades av det tidigare utskicket återanvänds den.
4. Kommunsign reparerar användare, medlemskap och `tenant_admin`-rollen först.
5. Därefter skickas en ny lösenordslänk. Använd den senaste länken.

## Installation

```bash
cd /Users/hekmath/Projects/kommunsign
npm run db:migrate
npm run db:verify
npm run build
```

Första migrationen ska visa:

```text
APPLY control/0015_shared_saas_data_plane_runtime.sql
APPLY control/0016_consistent_tenant_and_account_activation.sql
```

Deploya sedan både `api` och `workers` från samma commit. Workern måste redeployas efter migrationen så att startup-recovery körs. Portalerna måste också deployas för nya UI-texter och lösenordsflödet.

## Verifiering i granskningsmiljön

- TypeScript-kompilering: godkänd
- Portalbuild: 6 portaler
- Enhetstester: 47 godkända
- Integrationstest: godkänt
- Säkerhetstest: godkänt
- SQL-migrationskontroll: godkänd
- Repositorykontroll: godkänd
- Unified Vercel-build: 7 portaler
- Deploymentkonfiguration: godkänd
- Secret scan: godkänd
- Provenancekontroll: godkänd

Ingen statisk granskning kan matematiskt garantera att hela produkten saknar alla framtida buggar. Inom det granskade end-to-end-flödet hittades inga ytterligare kända fel efter korrigeringarna och testerna ovan.
