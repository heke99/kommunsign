# Kommunsign: konsekvent flöde från ansökan till organisation och inbjudan

## Orsak till `INVALID_APPLICATION_STATE_TRANSITION`

Felet uppstod när API:t försökte godkänna en ansökan vars faktiska status inte längre var exakt en av de statusar som den tidigare övergångsmatrisen tillät. Tre inkonsekvenser förstärkte problemet:

1. `additional_information_requested` kunde visas som beslutsbar i gränssnittet men kunde inte gå direkt till `approved` i databasen.
2. Plattformens gränssnitt visade godkännandeknappar även efter att ansökan redan hade gått vidare till godkännande eller provisionering.
3. Provisionerings-API:t kontrollerade ansökans status före befintlig provisioneringsbegäran. Dubbelklick, omladdning eller ett delvis genomfört anrop kunde därför ge konflikt i stället för att återanvända samma jobb.

## Korrigerat flöde

Det kanoniska flödet är nu:

`draft -> submitted -> under_review / additional_information_requested -> approved -> provisioning -> onboarding -> active`

Fel under organisationsskapandet använder:

`provisioning -> provisioning_failed -> provisioning`

Avslag använder:

`submitted / under_review / additional_information_requested -> rejected`

## Beteende efter ändringen

- Godkännande är idempotent. Ett upprepat godkännande av en ansökan som redan är godkänd eller har gått vidare ger inte ett ogiltigt statusfel.
- `additional_information_requested` kan godkännas eller avslås direkt.
- Befintlig provisioneringsbegäran återanvänds i stället för att skapa dubbla organisationer.
- Misslyckad eller partiell provisionering kan återupptas med samma begäran och redan slutförda steg.
- När provisioneringsarbetaren misslyckas sätts ansökan till `provisioning_failed`.
- Gränssnittet visar bara åtgärder som är giltiga för den aktuella statusen och hämtar aktuell status före beslut.
- Organisationen kan hittas via organisationsnummer även innan ett tenant-id har skapats.
- Egen domän är inte ett krav för att bjuda in huvudadministratören. Standardinloggning sker via `app.kommunsign.se`.

## Databasmigration

`migrations/control/0014_consistent_application_provisioning_flow.sql`:

- ersätter statusövergångsfunktionen med den konsekventa modellen,
- verifierar att alla beslutsbara statusar kan godkännas eller avslås,
- reparerar befintliga statusavvikelser utifrån provisioneringsbegäran,
- för redan slutförd provisionering med tenant till `onboarding`,
- markerar felade eller partiella jobb som `provisioning_failed`.

## Produktionskörning

Kör efter att patchen har synkats till projektroten:

```bash
npm run db:migrate
npm run db:verify
npm run build
```

Kontrollera att följande rad visas första gången:

```text
APPLY control/0014_consistent_application_provisioning_flow.sql
```

Deploya därefter API, provisioneringsarbetare och platform-admin tillsammans. En frontend-deploy utan det uppdaterade API:t löser inte statuskonflikten.

## Verifiering utförd

- TypeScript-kompilering: godkänd
- Portalbygge: 6 portaler
- Enhetstester: 42 godkända
- Integrationstester: godkända, inklusive upprepat godkännande och upprepad provisionering
- SQL-migrationskontroll: godkänd
- Repository-verifiering: godkänd
- Säkerhetstester: godkända

`npm ci` kunde inte köras mot den interna npm-spegeln eftersom den där saknade `postgres@3.4.7`. Kontrollerna ovan kördes med den låsta projektkoden och tillgänglig TypeScript 5.8.3.
