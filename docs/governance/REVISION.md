# Revision och granskning

> **Utkast.** Inte antaget, och ingen revision är genomförd.
> Se `README.md` i den här katalogen. Täcker krav 3556.

## 1. Kommunens rätt att granska

Kungälvs kommun har rätt att granska leverantörens efterlevnad av avtalet och
av personuppgiftsbiträdesavtalet. Rätten utövas på något av tre sätt, och
kommunen väljer:

| Form | Innebörd | Varsel |
| --- | --- | --- |
| Dokumentgranskning | Kommunen begär underlag och får det skriftligt | 10 arbetsdagar |
| Granskning på plats | Kommunen eller dess ombud granskar hos leverantören | 20 arbetsdagar |
| Tredjepartsrevision | Oberoende revisor granskar, kommunen får rapporten | Enligt överenskommelse |

Vid misstänkt allvarlig avvikelse gäller inget varsel.

## 2. Vad som alltid kan lämnas ut

Utan särskild beredning:

- Kravmatrisen och dess evidens: `docs/compliance/kungalv/`.
- Utfallet av de automatiska grindarna, inklusive vilka som är röda.
- `npm run check:production-go` med sitt utfall och sin vantage point.
- Hotmodell, styrdokument och runbooks.
- Hashkedjad auditlogg för kommunens egen tenant.

Att den listan är kort och konkret är avsiktligt: en granskning som börjar med
att förhandla om vad som får visas har redan förlorat en vecka.

## 3. Intern granskning

Leverantören granskar sig själv årligen mot den här dokumentsamlingen.
Granskningen ska särskilt pröva två saker som annars ruttnar tyst:

1. **Att grindarna fortfarande mäter något.** En grön grind som blivit grön
   för att den slutat titta är farligare än en röd. Kontrollen är att medvetet
   bryta det grinden skyddar och se den bli röd.
2. **Att bedömningarna fortfarande stämmer.** Varje krav som står PASS ska ha
   evidens som pekar på kod, migration eller test som faktiskt finns.

Utfallet dokumenteras med datum, granskare och avvikelser.

## 4. Avvikelser

En avvikelse får en ansvarig och ett datum. Avvikelser som rör en teknisk
kontroll ska stängas med ett test, inte med en försäkran.

## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
| Genomförd revision | *(ingen — blockerar 3556)* |
