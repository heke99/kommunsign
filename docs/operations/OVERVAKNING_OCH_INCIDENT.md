# Övervakning, incidenthantering och kapacitet

Krav 3549 (dokumenterade rutiner för övervakning, upptäckt, analys, rapportering
och eskalering), 3530 (kapacitetsprognos), 3551 (säkerhetsincidenter) och 2041
(tillgänglighet dygnet runt).

Senast uppdaterad: 2026-08-07.

## 1. Vad som övervakas

Uppetid är inte samma sak som att tjänsten fungerar. En signeringstjänst kan
svara 200 på varje HTTP-anrop medan ingen underskrift blir klar. Övervakningen
mäter därför utfall, inte bara svar.

| Signal | Varför den finns | Larmnivå |
| --- | --- | --- |
| Påbörjade underskrifter utan slutförande | Fångar det fel HTTP-övervakning missar helt | Varning vid avvikelse mot baslinje |
| Felkvot per endpoint | Regression efter utrullning | Kritisk över 2 % i 5 min |
| Latens p95 för API | Upplevd tillgänglighet | Varning över 1 s |
| Ködjup och äldsta jobb i workers | Ett växande ködjup föregår varje leveransstopp | Kritisk vid jobb äldre än 15 min |
| Misslyckade webhookleveranser | Kundens integration tappar händelser | Varning vid dead-letter |
| Providerfel (TIC, Freja, e-post) | Skiljer vårt fel från leverantörens | Varning direkt, kritisk vid ihållande |
| Misslyckade inloggningar per konto och IP | Lösenordsattack | Kritisk vid tröskel |
| Verifierings- och valideringsfel | Kan betyda trasig signeringskedja | Kritisk |
| Certifikat- och nyckelutgång | Utgånget certifikat stoppar all signering | Varning 30 dagar före |

## 2. Upptäckt och analys

Larm går till jour dygnet runt. Första åtgärd är alltid att avgöra om felet är
vårt, en leverantörs eller kundens nät. `/readyz` skiljer på databas, Redis,
lagring, TIC, signeringstjänst och valideringstjänst, så den frågan besvaras
utan gissning.

Ett leverantörsbortfall får aldrig sänka säkerhetsnivån. När en
identitetsleverantör är nere smalnar utbudet av metoder av — tjänsten faller
aldrig tillbaka på en svagare metod.

## 3. Rapportering och eskalering

| Nivå | Innebörd | Första svar | Rapport till kunden |
| --- | --- | --- | --- |
| P1 | Tjänsten otillgänglig eller underskrifter kan inte slutföras | 30 min | Löpande, minst varannan timme |
| P2 | Väsentlig funktion nere, arbete möjligt med omväg | 2 h dagtid | Daglig |
| P3 | Begränsad påverkan | Nästa arbetsdag | Vid åtgärd |
| Säkerhetsincident | Misstänkt obehörig åtkomst eller röjande | Omgående | Utan onödigt dröjsmål, enligt PUB-avtalet |

Vid personuppgiftsincident kontaktas kundens utpekade roll utan onödigt
dröjsmål, med underlag som räcker för kommunens egen anmälan till IMY inom 72
timmar. Kommunsign gör inte anmälan i kommunens ställe — kommunen är
personuppgiftsansvarig.

Efter varje P1 och varje säkerhetsincident skrivs en efteranalys med förlopp,
grundorsak, åtgärd och åtgärdsdatum. Analysen letar systemfel, inte personfel.

## 4. Kapacitet och prognos (krav 3530)

Följande mäts löpande och trendas månadsvis: antal ärenden och underskrifter per
tenant, lagrad datavolym, databasstorlek och indexstorlek, ködjup över tid,
API-anrop per klient samt utgående e-postvolym.

Prognosen görs kvartalsvis mot uppmätt tillväxt. Åtgärd planeras när en resurs
prognostiseras nå 70 % av kapaciteten inom två kvartal — inte när den är full.
Kunden informeras i förvaltningsmötet när en förändring påverkar leveransen.

## 5. Planerat underhåll (krav 2041)

Tjänsten är tillgänglig dygnet runt utom vid planerat underhåll. Underhåll
aviseras minst fem arbetsdagar i förväg och läggs utanför kontorstid.
Additiva migrationer gör att de flesta uppgraderingar sker utan avbrott.

## 6. Loggskydd (krav 3535)

Auditloggen är hashkedjad, så manipulation är detekterbar. Loggar innehåller
aldrig lösenord, API-hemligheter, råa token, personnummer eller dokumentinnehåll.
Åtkomst till loggverktyg är behörighetsstyrd och loggas i sin tur.
