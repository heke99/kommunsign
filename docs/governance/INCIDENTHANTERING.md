# Incidenthantering

> **Utkast.** Inte antaget. Se `README.md` i den här katalogen.
> Täcker krav 2027, 3503, 3550.

Den tekniska driftrutinen finns i `../operations/OVERVAKNING_OCH_INCIDENT.md`.
Det här dokumentet handlar om vem som beslutar, vem som kontaktas och inom
vilken tid — den delen som inte går att koda.

## 1. Vad som räknas som en incident

En incident är varje händelse som påverkar riktighet, tillgänglighet eller
sekretess för information i tjänsten. Tre exempel som ska anmälas även när de
inte orsakat skada:

- En signering som markerats klar utan verifierad identitetsevidens.
- Åtkomst till data över en tenantgräns, oavsett om den utnyttjades.
- En nyckel eller ett credential som hamnat någonstans det inte hör hemma.

Att en händelse inte fick konsekvenser är ett resultat av kontrollerna, inte
ett skäl att låta bli att anmäla. Kontrollen kan ha varit den sista.

## 2. Roller

| Roll | Ansvar | Utses av |
| --- | --- | --- |
| Incidentansvarig hos leverantören | Leder hanteringen, beslutar om eskalering | Leverantören |
| Kontaktperson hos Kungälvs kommun | Tar emot anmälan, beslutar om kommunens åtgärder | **Kungälvs kommun — ej utsedd** |
| Personuppgiftsansvarigs dataskyddsombud | Bedömer anmälan till IMY | Kungälvs kommun |

Krav 2027 och 3550 kan inte uppfyllas förrän kommunen pekat ut sin
kontaktperson. Det är inte en formalitet: en rutin utan namngiven mottagare
misslyckas första gången den används, klockan tre på natten.

## 3. Tider

Räknat från upptäckt:

| Steg | Tid |
| --- | --- |
| Första bedömning av allvarlighetsgrad | 1 timme |
| Underrättelse till kommunens kontaktperson vid misstänkt personuppgiftsincident | 4 timmar |
| Skriftlig lägesrapport | 24 timmar |
| Slutrapport med orsaksanalys och åtgärder | 10 arbetsdagar |

Fyra timmar är valt för att kommunen som personuppgiftsansvarig har 72 timmar
på sig att anmäla till IMY, och behöver marginal för sin egen bedömning.

## 4. Myndighetskontakter (krav 3503)

| Myndighet | När | Vem tar kontakten |
| --- | --- | --- |
| Integritetsskyddsmyndigheten | Personuppgiftsincident | Kungälvs kommun som personuppgiftsansvarig |
| Polisen | Misstänkt brott | Den drabbade parten |
| CERT-SE | Allvarlig it-incident | Leverantören, i samråd med kommunen |
| MSB | Om kommunen omfattas av rapporteringsplikt | Kungälvs kommun |

Leverantören anmäler inte i kommunens ställe. Kommunen är
personuppgiftsansvarig; leverantören lämnar underlaget.

## 5. Gången

1. **Upptäck och registrera.** Tidpunkt, upptäckare, första iakttagelse.
2. **Bedöm.** Allvarlighetsgrad, berörda tenanter, berörda personuppgifter.
   Korrelations-ID går genom API, workers och loggar och är utgångspunkten.
3. **Begränsa.** Stoppa pågående skada före utredning av orsak. Vid misstänkt
   nyckelexponering: rotera enligt `../runbooks/KEY_ROTATION.md` innan
   utredningen är klar.
4. **Underrätta** enligt tiderna ovan.
5. **Åtgärda och verifiera.** En åtgärd räknas inte som genomförd förrän den
   är verifierad — helst av ett test som skulle ha fångat händelsen.
6. **Lär.** Orsaksanalys utan skuldfördelning. Varje incident ska antingen
   resultera i en teknisk kontroll eller i ett uttryckligt beslut att inte
   införa en, med skäl.

## 6. Bevisning

Auditloggen är hashkedjad och får inte redigeras under en incident. Behöver
en händelse dokumenteras skrivs den som en ny händelse. Att "städa" loggen
under utredning förstör det enda som kan visa vad som hände.

## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
| Kommunens kontaktperson | *(ej utsedd — blockerar 2027 och 3550)* |
