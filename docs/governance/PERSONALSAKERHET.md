# Personalsäkerhet

> **Utkast.** Inte antaget. Se `README.md` i den här katalogen.
> Täcker krav 3504, 3505, 3506, 3507, 3508, 3509.

Gäller alla som kan nå produktionsdata eller ändra kod som når produktion:
anställda, konsulter och underbiträdens personal.

## 1. Före anställning (krav 3505)

Bakgrundskontroll genomförs innan åtkomst ges, i den omfattning uppgiften
kräver:

| Uppgift | Kontroll |
| --- | --- |
| Åtkomst till produktionsdata | Identitetskontroll, utdrag ur belastningsregistret, referenstagning |
| Åtkomst till signeringsnycklar eller HSM | Ovanstående, samt utökad kontroll enligt kundens krav |
| Utveckling utan produktionsåtkomst | Identitetskontroll, referenstagning |

Kontrollen dokumenteras med datum och vem som utförde den. Själva utdraget
sparas inte — att lagra belastningsregisterutdrag är en egen
personuppgiftsbehandling utan stöd här.

Kontroll upprepas vid väsentligt utökad behörighet.

## 2. Avtal och ansvarsförbindelser (krav 3506, 3509)

Innan åtkomst ges undertecknas:

1. **Sekretessförbindelse** som gäller under och efter uppdraget, utan
   tidsbegränsning för uppgifter som omfattas av offentlighets- och
   sekretesslagen hos kommunen.
2. **Ansvarsförbindelse** där personen bekräftar att ha tagit del av
   informationssäkerhetspolicyn och reglerna för tillgångar.

För underbiträdens personal ska motsvarande förbindelser finnas hos
underbiträdet, och leverantören ska kunna visa att de finns. Se
`UNDERBITRADEN.md`.

Undertecknade förbindelser förvaras hos leverantören och inte i det här repot.

## 3. Under anställning

### Utbildning (krav 3507)

| Tillfälle | Innehåll |
| --- | --- |
| Vid introduktion, före åtkomst | Policy, tenantgränsen, hantering av personuppgifter, incidentrutin |
| Årligen | Uppdatering, aktuella hot, genomgång av årets incidenter |
| Vid förändrad roll | Det som är nytt för rollen |

Genomförd utbildning registreras med datum och deltagare. En utbildning ingen
kan visa att någon gått är inte genomförd.

### Regler för behörighet (krav 3508)

- Behörighet ges efter behov för uppgiften, inte efter befattning.
- Produktionsåtkomst är personlig. Delade konton förekommer inte.
- Behörighet granskas kvartalsvis. Granskningen dokumenteras även när inget
  ändras — annars går det inte att skilja "granskat, allt rätt" från
  "aldrig granskat".
- Vid avslutat uppdrag återkallas åtkomst samma dag, och senast nästa
  arbetsdag för underbiträdens personal.

### Distansarbete (krav 3504)

Distansarbete är tillåtet under följande villkor:

- Utrustning med diskkryptering, skärmlås efter högst 10 minuter och
  automatiska säkerhetsuppdateringar.
- Produktionsåtkomst kräver flerfaktorsautentisering.
- Produktionsdata kopieras inte till lokal utrustning och visas inte i
  offentlig miljö.
- Publika nätverk används endast med organisationens VPN.
- Privat utrustning används inte för produktionsåtkomst.
- Utskrifter av handlingar under signering förekommer inte.

## 4. Vid avslut

Samma dag: återkallad åtkomst, återlämnad utrustning, bekräftad kvarstående
sekretess. Om personen haft åtkomst till nyckelmaterial roteras det enligt
`../runbooks/KEY_ROTATION.md` — inte för att misstro personen, utan för att
"vem hade åtkomst" är en fråga som ska ha ett kort svar.

## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
