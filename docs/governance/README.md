# Styrdokument

## Vad det här är, och vad det inte är

Dokumenten i den här katalogen är **utkast**. De är skrivna av leverantören och
inte antagna av någon.

Det spelar roll för hur de får användas. Ungefär tjugofyra av kraven i
Kungälvs upphandling handlar inte om kod utan om att en organisation har
bestämt något och tillämpar det: en informationssäkerhetspolicy, en rutin för
bakgrundskontroll, en förteckning över underbiträden. För sådana krav *är*
dokumentet en del av evidensen — men bara tillsammans med beslutet. Ett
policyutkast som leverantören själv har författat och ingen har antagit är
inte en styrning, det är en text.

Därför står de kraven som `PENDING_ADOPTION` i kravmatrisen, och
`PENDING_ADOPTION` räknas som ouppfyllt av `npm run check:production-go`.
Att flytta ett krav till PASS kräver att antagandet registreras.

## Hur ett dokument antas

Varje dokument avslutas med ett antagandeblock:

```
## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
```

När blocket är ifyllt av någon som har mandat att fatta beslutet:

1. Fyll i blocket i dokumentet och committa.
2. Uppdatera kravets bedömning i en daterad override under
   `docs/compliance/kungalv/`, med status `PASS` och antagandedatumet som
   evidens.
3. `node scripts/build-requirement-matrix.mjs`.

Steg 2 är avsiktligt manuellt. Ingen automatik ska kunna flytta ett krav till
PASS för att en fil ändrades — det är precis den sortens automatik som gör en
kravmatris opålitlig.

## Dokumenten

| Dokument | Täcker |
| --- | --- |
| `INFORMATIONSSAKERHETSPOLICY.md` | 3501, 3510, 3520, 3557 |
| `INCIDENTHANTERING.md` | 2027, 3503, 3550 |
| `PERSONALSAKERHET.md` | 3504, 3505, 3506, 3507, 3508, 3509 |
| `UNDERBITRADEN.md` | 2029, 2030, 2031, 3548 |
| `RISKHANTERING.md` | 3512 |
| `REVISION.md` | 3556 |

Kvarvarande organisatoriska krav som inte täcks här kräver något annat än ett
dokument: referenskunder i drift (2032), escrow-avtal (3525), tecknade avtal
och prisbilagor (2039–2043), leverantörsevidens för datahallar (3527, 3528) och
tidssynkronisering (3536). De står kvar som `BLOCKED_EXTERNAL` med sin
respektive blockerare i `docs/compliance/kungalv/EXTERNAL_EVIDENCE_BLOCKERS.md`.
