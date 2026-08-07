# Reservrutiner, återstart och kontinuitet

Krav 3552 (reservrutiner, reservlösningar och återstartsplaner) och 2037
(backup under drift). Kompletterar `docs/operations/backup-and-restore.md`.

Senast uppdaterad: 2026-08-07.

## Mål

| Mått | Nivå |
| --- | --- |
| RPO — accepterad dataförlust | 15 minuter |
| RTO — återställningstid | 4 timmar |
| Bevarandetid för säkerhetskopior | 90 dagar rullande |

## Säkerhetskopiering

Kontinuerlig arkivering av transaktionsloggen ger återställning till en
godtycklig tidpunkt inom bevarandetiden. Kopiering sker under drift utan
avbrott. Objektlagringen versionshanteras och replikeras.

Säkerhetskopior är krypterade och lagras skilt från produktionsmiljön, inom
EU/EES.

## Återställningstest

En återställning som aldrig provats är en hypotes. Full återställning till en
isolerad miljö testas kvartalsvis, och testet omfattar återställd databas,
återställd objektlagring och verifiering att ett bevispaket från före
återställningen fortfarande validerar. Resultatet protokollförs med uppmätt
faktisk RTO.

## Reservlösningar

| Bortfall | Reservväg |
| --- | --- |
| Identitetsprovider nere | Utbudet av metoder smalnar av. Tjänsten faller aldrig tillbaka på svagare metod — ett bortfall får inte sänka säkerhetsnivån |
| Signeringstjänst nere | Nya underskrifter vägras. Påbörjade ärenden bevaras och återupptas; inget markeras signerat |
| E-postleverantör nere | Utskick köas och skickas om med backoff. Undertecknare kan nå ärendet via redan utskickad länk |
| Objektlagring nere | Uppladdning vägras. Befintliga låsta dokument påverkas inte |
| Databas nere | Tjänsten vägrar skriva. Ingen degraderad skrivväg finns, eftersom en skrivning utanför transaktionen skulle bryta bindningen mellan affärshändelse och audit |

Genomgående: bortfall leder till att en operation vägras, aldrig till att den
genomförs med svagare garantier.

## Återstart

Workers är persistenta, idempotenta och återupptagningsbara. Ett jobb som
avbryts mitt i återfår sitt lease efter utgången tid och körs om utan
dubbeleffekt. Efter oplanerad omstart återupptas påbörjade signeringar från det
steg de nådde; ett steg som inte slutfördes körs om, och ett som slutfördes körs
inte om.

## Övning

Kontinuitetsplanen övas årligen tillsammans med kunden, med minst ett scenario
som rör bortfall hos en identitetsleverantör. Resultat och åtgärder
protokollförs.
