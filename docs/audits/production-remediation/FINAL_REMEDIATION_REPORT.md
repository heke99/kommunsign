# Slutrapport — Kommunsign production remediation

Datum: 2026-08-07
Branch: `remediation/kommunsign-production-completion-2026-08-07`
Utgångspunkt: `61f9d95ab67fa941c1e8ecbc225cf12420e1a4de`
Repository: `heke99/kommunsign`

## Beslut: NO-GO

Kommunsign kan inte driftsättas hos Kungälvs kommun i nuvarande skick.

Grunden är inte en samlad kvalitetsbedömning utan tre enskilda, var för sig
blockerande förhållanden:

1. **Ingen signatur produceras.** `BlockedSigningEngine` returnerar
   `NOT_CONFIGURED`. Ingen PAdES-signatur har skapats, och ingen har
   validerats. Det centrala funktionella kravet — DIGG:s krav på avancerad
   elektronisk underskrift (F001) — kan därför inte styrkas. En
   e-underskriftstjänst som inte producerar en underskrift har ingen
   leveransbar kärna.

2. **De läckta nycklarna är inte roterade.** Krypteringsnyckeln för
   personuppgifter i vila, blind index-nyckeln för personnummer och den
   interna gatewaynyckeln låg i git-historiken. Blind index-nyckeln är
   allvarligast: personnummer har litet sökrum, så med nyckeln kan indexet
   räknas igenom och pseudonymiseringen är bruten. Filen är borttagen och
   scannern hårdare, men värdena finns kvar i historiken. Se
   `docs/operations/leaked-key-rotation-2026-08.md`.

3. **35 SKA-krav beror på något utanför kodbasen.** Flera har lång ledtid och
   kan inte forceras sent: fysisk skyddsnivå i datahall enligt MSB nivå 3
   (3527, 3528), tidssynkronisering mot GPS eller UTC(SP) (3536), två
   referenskunder i drift (2032), LIS (3501), källkodsdeposition (3525) och
   tecknat personuppgiftsbiträdesavtal (3555).

## Kravläge

| Typ | PASS | PARTIAL | GAP | BLOCKED_EXTERNAL | Summa |
| --- | ---: | ---: | ---: | ---: | ---: |
| SKA | 9 | 64 | 22 | 35 | 130 |
| BÖR | 0 | 4 | 3 | 1 | 8 |

Förändring i denna omgång: krav 2023 (GDPR) flyttades GAP → PARTIAL. F001 och
F013 fick starkare evidens utan att byta status.

Rörelsen i siffror är avsiktligt liten. Det som gjordes var inte att kryssa
fler rutor, utan att bygga de grindar som gör att kommande rutor kan kryssas
med evidens i stället för påstående.

## Genomfört i denna omgång

Två commits, 6 filer, +632/−27. `npm run verify` grön: **60 unit tests**
(från 55), integration, security, secret scan, migrations, repository- och
deployment-verifiering. Java-tjänsterna byggs och Freja JWS-självtestet passerar.

### PAdES-antagningsgrind (`packages/pades`)

Databasen vägrade redan kryptografisk evidens från annat än en betrodd tjänst.
Det som saknades var beslutet om en signatur får *registreras*, och på vilken
nivå.

Grinden härleder uppnådd PAdES-nivå ur den evidens som faktiskt finns.
Nivåerna är strikt kumulativa, så en saknad arkivtidsstämpel taket på LT och
saknat spärrmaterial taket på T. Den kastar hellre än nedgraderar: en tyst
nedgradering skulle låta ett ärende slutföras medan dess evidens påstår mindre
än policyn krävde. Och den registrerar den uppnådda nivån, inte den begärda,
så en signatur aldrig beskrivs som starkare än sin evidens.

Detta uppfyller AGENTS.md regel 5 och masterpromptens krav att inte skriva
"PAdES-LTA" om implementationen inte bevisar det.

### Registrerades rättigheter (`packages/privacy`)

Personuppgifter finns i CONTROL, DATA, objektlagring, auditlogg och backup.
Den typiska defekten är att en rättighetsbegäran besvaras ur ett av dem — ett
registerutdrag som tyst utelämnar CONTROL ser fullständigt ut, vilket gör det
sämre än inget utdrag.

Modulen gör det omöjligt att uttrycka: ett svar kan inte byggas utan att varje
register är antingen genomsökt eller undantaget med angiven rättslig grund.
Radering är inte absolut — legal hold blockerar, auditloggen bevaras enligt
PUB-avtalet 7.5 och backuper punktraderas inte — men undantagen redovisas i
svaret i stället för att hoppas över.

### SKILL_ROUTING.md

Samtliga 37 installerade skills klassade ACTIVE / CONDITIONAL /
NOT_APPLICABLE. Dokumentet noterar öppet att föregående session arbetade utan
att läsa in skills.

## Arkitektoniskt beslut som blockerar tre arbetsströmmar

Repot har **noll externa Java-beroenden** (`scripts/build-java.sh` är rent
`javac`) och ett enda Node-runtimeberoende (`postgres`). Provenance-grinden
upprätthåller detta.

Följande kan inte slutföras utan att det valet omprövas:

| Behov | Bibliotek | Berörda krav |
| --- | --- | --- |
| PAdES-produktion och -validering | EU DSS (Maven) | F001, F013, 2007 |
| PDF/A-validering | veraPDF | F013, 2064–2067 |
| Webbläsar- och tillgänglighetstest | Playwright | 2008–2010, 2014, 2015 |

Detta är ett ägarbeslut om supply chain, inte något som ska ändras ensidigt
mitt i en remediation. Utan beslutet förblir F001 blockerat oavsett hur mycket
kringliggande kod som skrivs.

## Vad som inte gjordes

Av de 18 prioriteringarna hanns 1 (delvis) och 5 (delvis) med. Orörda:
TIC BankID end-to-end, Freja-adaptern, gallringens exekveringslager,
FGS/arkivexport, SCIM/federation, skyddade personuppgifter, API/webhooks,
rate limits/cache/köer, databas- och klientprestanda, WCAG 2.2 AA,
observability samt merparten av ISMS- och runbookdokumentationen.

Uppgiften i masterprompten motsvarar flera månaders arbete. Att redovisa den
som i huvudsak genomförd vore samma sorts felaktiga påstående som rapporten
i övrigt är byggd för att förhindra.

## Rekommenderad ordning

1. **Rotera de läckta nycklarna.** Blockerar allt annat och är oberoende av
   övrig utveckling.
2. **Fatta beroendebeslutet** om EU DSS, veraPDF och Playwright. Utan det står
   F001 stilla.
3. **Begär leverantörsevidens för 3527, 3528 och 3536 nu.** Svaret kan tvinga
   fram en driftmigrering och påverkar hela tidplanen.
4. Slutför signeringsmotorn mot den nya PAdES-grinden.
5. Bygg exekveringslagren för gallring och GDPR ovanpå befintliga beslutslager.
6. Freja-adaptern, FGS-export, SCIM.
7. Verifiera WCAG och webbläsarstöd med mätning, inte antagande.

## Evidensprincip

Inget krav har markerats PASS utan implementation, verifiering och evidens
samtidigt. Där implementation finns men verifiering saknas står PARTIAL. Där
kravet beror på något utanför kodbasen står BLOCKED_EXTERNAL med namngiven
blockerare. QES och Sverige-id är markerade som ej implementerade och avvisas
aktivt av identitetsregistret i produktion.

Kravmatrisen genereras av `node scripts/build-requirement-matrix.mjs`, som
misslyckas om ett krav saknar bedömning eller om en BLOCKED_EXTERNAL-rad
saknar namngiven blockerare.
