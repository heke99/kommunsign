# Licens- och provenienspolicy

Ingen kod från ett donorprojekt får kopieras, adapteras, översättas eller semantiskt portas innan samtliga villkor är uppfyllda:

1. repository och exakt 40-teckens commit-SHA är låsta,
2. licens och eventuella tilläggsvillkor är klassificerade,
3. separat tillstånd är arkiverat när det behövs för den planerade användningen,
4. rättighetshavare och behörig undertecknare är verifierade,
5. tillståndet omfattar modifiering, kommersiell SaaS, distribution, sluten källkod och eventuell sublicensiering i den omfattning som behövs,
6. tillståndsfilens SHA-256 är registrerad,
7. tillåten kodmängd och LOC-beräkning är dokumenterade,
8. originalfil, destinationsfil, reuse type, original LOC och reused LOC finns i reuse-map,
9. attribution, copyright och varumärkesrensning är verifierade,
10. automatisk kontroll visar högst 85 procent per donor.

## Beräkningsgrund

Gränsen beräknas per donor mot copyrightbara källkodsrader och exkluderar genererade filer, lockfiler, binärer, vendorerade tredjepartsberoenden och icke återanvändbar testdata.

`reused_loc / original_loc * 100` får aldrig överstiga 85. En donorpost med importerad kod men utan verifierat evidence, faktisk file mapping eller mätbar originalmängd ska stoppa build.

## Tredjepartsberoenden (ADR 0003 admission gate)

Policyn ovan gäller *donorkod* — kod som kopieras in i repot. Ett kompilerat
beroende som konsumeras som artefakt är något annat och prövas mot ADR 0003:s
admission gate i stället: exakt pinnad version, registrerad checksumma och
proveniens, granskad licens, sårbarhetsskanning, aktivt underhåll, och åtkomst
enbart genom en boundary-tjänst.

De Sweden Connect-, BouncyCastle- och PDFBox-artefakter som ADR 0004 inför är
samtliga Apache-2.0 eller MIT-liknande och kompatibla med kommersiell SaaS-
distribution med sluten källkod. Ingen av dem länkas in i TypeScript-kärnan; de
nås enbart via `services/signservice` och `services/validation-service`.
Versionerna är pinnade en och en i `services/pom.xml`, och enforcer-pluginet
stoppar bygget vid SNAPSHOT-beroenden eller opinnade plugins.

## Nuvarande status

Denna leverans innehåller ingen importerad donor-kod. Alla poster har `reused_loc: 0`. Användarens uppgift om skriftligt tillstånd är registrerad som `claimed_not_verified`, eftersom själva bevisfilerna inte ingick i uppladdningen.
