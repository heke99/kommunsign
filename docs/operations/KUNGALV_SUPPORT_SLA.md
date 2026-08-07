# Supportnivåer — Kungälvs kommun

Underlag: Bilaga 3, *Supportavtal för molnbaserade tjänster*, till avtal
avseende Stödtjänst för e-underskrift, Dnr KS2026/1005.

Detta dokument beskriver vad avtalet kräver och vad som behöver finnas på
plats för att nivåerna ska kunna hållas. Det är inte ett intyg om att
nivåerna hålls i dag.

## Supportfönster

- Vardagar 08:00–16:30.
- Remote support ska erbjudas.
- Ärenden registreras via leverantörens ärendehanteringssystem och/eller e-post.
- Kungälv agerar 1st line internt och begränsar anmälande personer till två
  (systemförvaltare och systemadministratör). Leverantören besvarar både
  teknisk support och systemrelaterade frågor från dessa kontakter.

Kontaktpunkt hos kommunen enligt avtalet: Erik Lennerstedt,
erik.lennerstedt@kungalv.se / digital.utveckling@kungalv.se.

## Servicenivåer

Kungälv klassificerar felet. Leverantören åtgärdar enligt nivån. Ett fel är
inte åtgärdat förrän tjänsten fungerar enligt avtalet.

| Prioritet | Åtgärd påbörjas | Tillfällig lösning | Permanent lösning |
| --- | --- | --- | --- |
| Allvarlig (1) | Påföljande arbetsdag | Utan oskäligt dröjsmål, senast 2 arbetsdagar från anmälan | Senast 7 arbetsdagar |
| Medel (2) | Inom 5 arbetsdagar | Senast 2 veckor från anmälan | Senast 1 månad |
| Låg (3) | Ej definierat | — | Nästa samlade rättelse inom normal lanseringsfrekvens |

Definitioner enligt avtalet:

- **Allvarlig (1)** — allvarligt fel som påverkar stor del av tjänstens
  användare, alternativt har stor påverkan på förvaltningen.
- **Medel (2)** — fel som påverkar enstaka eller ett fåtal användare och som
  inte i väsentlig grad stör utnyttjandet av systemet men upplevs irriterande.
- **Låg (3)** — mindre fel utan betydelse för den dagliga användningen.

Fel som orsakats av beställaren eller beställarens driftspartner får debiteras
enligt offererad timkostnad.

## Vad som krävs för att nivåerna ska kunna hållas

Prioritet 1 kräver att ett allvarligt fel upptäcks samma arbetsdag som det
uppstår. Det förutsätter övervakning som i dag inte finns på plats:

- Larm på signeringsflödets slutförandegrad, inte bara på att API:t svarar. Ett
  fel där signeringar startas men aldrig slutförs är ett prioritet 1-fel som
  inte syns i en vanlig uppetidsmätning.
- Separata mätningar av egen bearbetningstid, providerlatens och databaslatens,
  så att långsam BankID eller Freja inte felklassas som fel i tjänsten.
- Larm på ködjup och dead-letter i workerkön, eftersom dokumentbearbetning och
  slutförande är asynkrona.
- Felkvot per provider, så att ett providerbortfall kan klassas och kommuniceras
  som sådant i stället för att utredas som ett fel i Kommunsign.

Sju arbetsdagar till permanent lösning förutsätter dessutom att en rättelse
kan gå hela vägen till produktion inom det fönstret: kvalitetsgrindar i CI,
staging och en dokumenterad releaseprocess.

## Kvarstående

Följande finns inte i dag och krävs innan servicenivåerna kan utlovas:

- Ärendehanteringssystem och registrerad supportkanal.
- Övervakning och larm enligt ovan.
- Jour- eller beredskapsrutin som täcker supportfönstret.
- Incidentklassificering som avbildar prioritet 1–3 mot faktiska larm.
- Runbooks för de vanligaste prioritet 1-scenarierna: providerbortfall,
  databasbortfall, storagebortfall och stopp i signeringsslutförandet.

Relaterade krav i kravmatrisen: 2040 (support enligt Bilaga 3), 2041
(tillgänglighet), 2027 och 3550 (samråd vid incidenter), 3549 (rutiner för
incidenthantering), 3552 (reservrutiner och återstartsplaner).
