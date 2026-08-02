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

## Nuvarande status

Denna leverans innehåller ingen importerad donor-kod. Alla poster har `reused_loc: 0`. Användarens uppgift om skriftligt tillstånd är registrerad som `claimed_not_verified`, eftersom själva bevisfilerna inte ingick i uppladdningen.
