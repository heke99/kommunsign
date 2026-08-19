# Riskhantering

> **Utkast.** Inte antaget. Se `README.md` i den här katalogen.
> Täcker krav 3512.

## 1. Vad som saknades

`../THREAT_MODEL.md` finns och är teknisk och konkret. Det som saknas är att
den görs om: en hotmodell från ett tillfälle beskriver systemet som det såg ut
då. Kravet gäller en återkommande process, inte ett dokument.

## 2. Takt

| Tillfälle | Omfattning |
| --- | --- |
| Årligen | Fullständig genomgång av hotmodell och riskregister |
| Vid väsentlig förändring | Den berörda delen — ny extern integration, ny datakategori, ny driftmiljö, ny underbiträde |
| Efter varje incident med allvarlighetsgrad hög | Den del som incidenten berörde |

"Väsentlig förändring" avgörs av dokumentägaren. Vid tveksamhet görs
bedömningen — en onödig genomgång kostar en förmiddag.

## 3. Metod

1. **Identifiera.** Utgå från hotmodellens förtroendegränser: tenantgränsen,
   gränsen mot identitetsleverantören, gränsen mot signeringstjänsten, gränsen
   mot objektlagringen, gränsen mot mottagande arkiv.
2. **Värdera.** Sannolikhet och konsekvens i tre steg vardera. Konsekvens
   bedöms för kommunen och den registrerade, inte för leverantören.
3. **Behandla.** Reducera, överför, undvik eller acceptera. En accepterad risk
   ska ha en namngiven person som accepterat den och ett datum då den omprövas.
4. **Verifiera.** En riskreducerande åtgärd räknas som genomförd när den är
   verifierad. Där det går ska verifikationen vara ett automatiskt test, så att
   åtgärden inte tyst kan tas bort igen.

## 4. Riskregister

Registret hålls utanför repot eftersom det innehåller uppgifter om ännu inte
åtgärdade svagheter. Varje post ska ha: identifierare, beskrivning, värdering,
beslutad behandling, ansvarig, datum för omprövning, och referens till
verifikationen när sådan finns.

## 5. Koppling till det som redan finns

Riskhanteringen ersätter inte de tekniska kontrollerna utan pekar på dem.
Flera risker som annars hade stått öppna i registret bärs redan av grindar:
tenantisolering av radnivåsäkerhet och SQL-sviter, identitetsevidens av
application-chain-testet, arkivkonformitet av FGS-valideringen, uteblivna
backuper av `BackupFailed`. En risk vars behandling är "vi är försiktiga" är
inte behandlad.

## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
