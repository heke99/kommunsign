# Teknisk integrationsdokumentation

Krav 2073 (dokumenterade API:er för läsning och skrivning), 2074 (teknisk
dokumentation för integration), 2076 (samtliga API:er utan kostnad eller
volymbegränsning) och F006 (integration med verksamhetssystem).

Maskinläsbar specifikation: `docs/api/openapi.yaml` (OpenAPI 3.1).
Felkoder: `docs/api/error-codes.md`.

## 1. Åtagande om kostnad och volym (krav 2076)

Samtliga API:er, nuvarande och framtida, ingår i tjänsten utan särskild kostnad
och utan volymbegränsning i avtalet.

Rate limits finns men är ett driftskydd, inte en affärsbegränsning: de skyddar
tjänsten mot en skenande integration och är satta per tenant så att en kunds
trafik aldrig kan förbruka en annan kunds utrymme. Behöver kommunen högre
gränser för en legitim volym justeras de utan kostnad. Ingen funktion är låst
bakom en tilläggsmodul.

## 2. Autentisering

API-klienter autentiseras med OAuth 2.0 client credentials. Klienten skapas i
tenantportalen och är bunden till en organisation — organisationen härleds
alltid ur klientens identitet och accepteras aldrig ur en payload.

Scopes tilldelas per klient enligt minsta möjliga behörighet:

| Scope | Ger |
| --- | --- |
| `signature-cases:read` | Läsa ärenden, status och undertecknare |
| `signature-cases:write` | Skapa ärenden, lägga till dokument och undertecknare, starta, påminna, avbryta |
| `documents:read` | Hämta undertecknat dokument och valideringsrapport |
| `evidence:read` | Hämta bevispaket |
| `webhooks:manage` | Hantera prenumerationer |
| `retention:read` / `retention:execute` | Läsa respektive begära och godkänna gallring |
| `archive:export` | Skapa och hämta arkivpaket |
| `privacy:handle` | Handlägga rättighetsbegäranden |

Ett anrop utanför klientens scopes avvisas. Ett anrop mot en annan organisations
resurs svarar 404 och inte 403, eftersom "finns men förbjudet" bekräftar att
resursen existerar och gör ID-uppräkning till en utlistning.

## 3. Versionering

Adressen bär versionen: `https://api.kommunsign.se/v1`. Additiva ändringar —
nya endpoints, nya valfria fält, nya enumvärden i svar — sker inom `v1`.
Klienten måste därför ignorera okända fält.

En brytande ändring får en ny version. Den gamla lever kvar i minst tolv månader
efter att den nya släppts, och avvecklingen aviseras skriftligt i förväg.

`x-kommunsign-implementation-status` i specifikationen anger `runtime` för
endpoints som är driftsatta och `contract` för sådana vars beslutslager är
implementerat och testat men vars väg ännu inte exponeras. Distinktionen finns
för att en integratör ska kunna skilja "finns" från "är specificerad", i stället
för att upptäcka skillnaden i produktion.

## 4. Idempotens

Varje skrivande anrop tar `Idempotency-Key`. Samma nyckel med samma payload ger
samma svar och skapar ingenting nytt; samma nyckel med annan payload avvisas.
Nyckeln jämförs mot en kanonisk hash av payloaden, så fältordning spelar ingen
roll.

Det är inte en bekvämlighet. Ett nätverksavbrott efter att servern tagit emot
men innan klienten fått svaret är det normala felet i en integration, och utan
idempotens blir varje sådan omsändning ett dubblettärende.

## 5. Paginering, filtrering och sortering

Cursorbaserad paginering med `limit` och `cursor`. Cursorn är ogenomskinlig och
ska skickas tillbaka oförändrad. Offsetpaginering erbjuds inte: den hoppar över
eller upprepar poster när något skapas under tiden man bläddrar.

Listor sorteras stabilt på skapandetid och ID, så två sidor aldrig överlappar.

## 6. Fel

Fel returneras som `{ "error": { "code", "message", "requestId", "details" } }`.
`code` är stabil och avsedd att programmeras mot; `message` är för människor och
kan ändras. `requestId` ska loggas av klienten — det är den identifierare
supporten behöver för att hitta anropet.

Felmeddelanden avslöjar aldrig intern struktur, stackspår eller om en resurs
finns i en annan organisation.

## 7. Korrelation

Skicka gärna `X-Request-Id`. Kommunsign bär den genom API, workers och
loggar, tillsammans med ett `correlationId` som spänner över hela
affärsoperationen inklusive de bakgrundsjobb anropet startar. Vid felsökning av
ett ärende som inte blev klart är det den identifieraren som gör spårningen
möjlig utan att gissa på tidsstämplar.

## 8. Typiska flöden

**Skapa och skicka ett ärende**

1. `POST /v1/uploads` och `POST /v1/uploads/{id}/complete` — ladda upp PDF.
2. `POST /v1/signature-cases` — skapa ärendet med policy och referens.
3. `POST /v1/signature-cases/{id}/documents` — koppla dokument och bilagor.
4. `POST /v1/signature-cases/{id}/signers` — lägg till undertecknare och ordning.
5. `POST /v1/signature-cases/{id}/send` — starta.

**Följa och hämta**

6. Prenumerera på webhooks, eller `GET /v1/signature-cases/{id}`.
7. `GET /v1/signature-cases/{id}/signed-document`
8. `GET /v1/signature-cases/{id}/evidence-package`

**Avsluta**

9. `POST /v1/signature-cases/{id}/cancel`, `POST /v1/archive/exports`.

Föredra webhooks framför pollning. Pollar man ändå: ingen hårdare takt än var
tionde sekund per ärende, med exponentiell backoff.

## 9. Webhooks

Varje leverans signeras med HMAC-SHA-256 över råkroppen tillsammans med en
tidsstämpel. Mottagaren ska:

1. verifiera signaturen mot **råkroppen**, före JSON-parsning,
2. avvisa en tidsstämpel utanför fem minuters fönster,
3. jämföra signaturer i konstant tid,
4. behandla `eventId` som engångshändelse — leverans sker minst en gång.

Misslyckad leverans görs om med exponentiell backoff och hamnar därefter i
dead-letter, som är läsbar och kan spelas upp igen. En endpoint som fortsätter
misslyckas stängs av och kunden notifieras.

## 10. SDK:er

TypeScript, C# och Java under `sdks/`. Genererade ur samma specifikation och
kontrollerade av `npm run verify:sdk`, så ett SDK inte kan hamna efter API:t.
SDK:erna är valfria — API:t är fullt användbart med en vanlig HTTP-klient.
