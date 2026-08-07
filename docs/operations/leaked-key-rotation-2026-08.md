# Nyckelrotation efter läckage i versionshanteringen (2026-08)

Status: **ÖPPEN — rotation krävs innan produktionsdrift.**

## Vad som hände

Filen `.kommunsign-production-secrets.env` var incheckad i git och innehöll
upplösta nyckelvärden för tre produktionsvariabler:

| Variabel | Skyddar |
| --- | --- |
| `SENSITIVE_DATA_ENCRYPTION_KEY_BASE64` | Applikationsnivåkryptering av känsliga fält (personuppgifter) i vila |
| `SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64` | Blind index/HMAC över normaliserade personnummer |
| `INTERNAL_GATEWAY_HMAC_KEY` | Autentisering av intern tjänst-till-tjänst-trafik via gatewayen |

Filen är borttagen från arbetsträdet och från git-indexet, och `.gitignore`
samt `scripts/scan-secrets.mjs` är utökade så att samma klass av läckage
stoppas i CI.

## Varför borttagningen inte räcker

Värdena finns kvar i repositoryts **historik** (införda i commit `ede3741`).
Alla som har eller har haft läsrättighet till repot, eller någon klon, fork
eller backup av det, kan läsa dem. Nycklarna ska därför betraktas som
komprometterade oavsett att filen nu är borttagen.

Historiken skrivs medvetet **inte** om i den här ändringen: en `filter-repo`
med efterföljande force push skulle skriva över delad historik och löser
ändå inte att värdena redan kan vara kopierade. Rotation är den åtgärd som
faktiskt återställer skyddet.

## Konsekvensbedömning per nyckel

**`SENSITIVE_DATA_ENCRYPTION_KEY_BASE64`** — den som har både nyckeln och en
kopia av databasen eller en backup kan dekryptera krypterade personuppgifts-
fält. Enbart nyckelinnehav ger ingen åtkomst; det krävs också åtkomst till
chiffertexten.

**`SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64`** — allvarligast. Blind index över
personnummer har litet sökrum: med nyckeln kan en angripare beräkna HMAC för
alla rimliga svenska personnummer och slå upp dem i indexet. Det gör indexet
återidentifierbart, alltså i praktiken pseudonymiseringen bruten.

**`INTERNAL_GATEWAY_HMAC_KEY`** — den som når ett internt nätverksinterface
kan signera förfalskade tjänst-till-tjänst-anrop. Exponeringen begränsas av
att interna tjänster inte ska vara publikt nåbara, men nyckeln är den enda
kryptografiska kontrollen och ska bytas.

## Rotationsordning

Kör i den här ordningen. Steg 2 kräver omkryptering och kan inte göras med
ett rent variabelbyte.

1. **`INTERNAL_GATEWAY_HMAC_KEY`** — generera ny nyckel (minst 32 byte),
   lägg in i secret manager som ny version, rulla ut till API, workers,
   validation-service och signservice i ett koordinerat fönster. Verifiera
   att interna anrop går igenom och att gammal nyckel avvisas efteråt.

2. **`SENSITIVE_DATA_ENCRYPTION_KEY_BASE64`** — inför ny nyckelversion vid
   sidan av den gamla. Läsvägen ska kunna dekryptera med både ny och gammal
   nyckel under migreringen; skrivvägen använder enbart den nya. Kör därefter
   ett backfill-jobb som läser om och skriver om varje krypterat fält med den
   nya nyckeln. Ta bort den gamla nyckelversionen först när backfillen är
   verifierad slutförd.

3. **`SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64`** — samma expand/contract-mönster.
   Beräkna om blind index för samtliga berörda rader med den nya nyckeln.
   Eftersom det gamla indexet är återidentifierbart ska de gamla
   indexvärdena **skrivas över**, inte bara lämnas kvar oanvända.

4. **Backuper** — backuper tagna före rotationen är krypterade med den gamla
   nyckeln och innehåller de gamla blind index-värdena. Fastställ hur länge
   de ska sparas och notera i registret att de omfattas av läckaget.

## Efter rotation

- Bekräfta att `npm run scan:secrets` är grön.
- Verifiera att inga gamla nyckelversioner ligger kvar aktiva i secret manager.
- Registrera i kontrollplanets audit: vem som roterade, när, vilka
  nyckelreferenser och versioner som berördes, samt backfill-jobbens ID.
  **Aldrig nyckelvärdena.**
- Bedöm anmälningsplikt enligt GDPR artikel 33 tillsammans med
  personuppgiftsansvarig. Bedömningen beror på om chiffertext eller
  databaskopior faktiskt varit åtkomliga för obehörig, vilket ska utredas
  mot åtkomstloggar för repository och databas — inte antas.

## Kvarstående externa åtgärder

- Fastställ vilka konton som haft läsåtkomst till repot sedan commit `ede3741`.
- Avgöra tillsammans med personuppgiftsansvarig om incidenten är anmälningspliktig.
