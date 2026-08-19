# Underbiträden

> **Utkast.** Inte antaget, och förteckningen är inte verifierad.
> Se `README.md` i den här katalogen. Täcker krav 2029, 2030, 2031, 3548.

## 1. Varför det här är en egen fråga

Kungälvs kommun är personuppgiftsansvarig. Leverantören är personuppgifts-
biträde. Varje part som leverantören anlitar och som kan komma åt
personuppgifter är ett underbiträde, och kommunen ska ha godkänt var och en.

Att en leverantör är välkänd gör den inte godkänd.

## 2. Förteckning

**Uppgifterna nedan är leverantörens uppfattning och är inte verifierade mot
respektive leverantörs egen dokumentation.** Det som saknas för krav 2029 är
just leverantörsevidens per underbiträde — ett intyg eller en avtalsbilaga som
säger var behandlingen sker, inte en rad i den här tabellen.

| Underbiträde | Roll i tjänsten | Behandlar personuppgifter | Uppgiven region | Evidens |
| --- | --- | --- | --- | --- |
| *(hostingleverantör för API och workers)* | Drift av applikationen | Ja | *(ej bekräftad)* | *(saknas)* |
| *(hostingleverantör för databaser)* | Kontroll- och dataplan | Ja | *(ej bekräftad)* | *(saknas)* |
| *(objektlagring)* | Handlingar och evidenspaket | Ja | *(ej bekräftad)* | *(saknas)* |
| *(e-postleverantör)* | Utskick av signeringsinbjudan | Ja — mottagarens e-postadress | *(ej bekräftad)* | *(saknas)* |
| *(BankID-förmedlare)* | Identifiering vid signering | Ja — personnummer | *(ej bekräftad)* | *(saknas)* |

Tabellen fylls i av leverantören inför avtal. Den lämnas medvetet ofullständig
här hellre än att gissa: en förteckning som ser komplett ut men innehåller
antaganden är sämre än en tom, eftersom den inte längre inbjuder till kontroll.

Handlingarnas innehåll når aldrig e-postleverantören. Inbjudan innehåller en
länk, inte dokumentet — det är en teknisk kontroll och den verifieras av
application-chain-testet, som avvisar en inbjudan där dokumentet följt med.

## 3. Godkännande (krav 2030)

Ett underbiträde får anlitas först när kommunen godkänt det skriftligt.
Godkännandet ska ange underbiträdets namn, behandlingens ändamål, kategorier
av personuppgifter och behandlingsregion.

Redan anlitade underbiträden vid avtalets ingående godkänns i samma ordning,
genom att förteckningen bifogas personuppgiftsbiträdesavtalet.

## 4. Byte av underbiträde (krav 2031)

| Steg | Tid |
| --- | --- |
| Skriftlig underrättelse till kommunen med skäl och konsekvensbedömning | Minst 60 dagar före |
| Kommunens invändningstid | 30 dagar |
| Vid invändning | Bytet genomförs inte utan överenskommelse; kan utgöra grund för uppsägning |

Ett byte som måste ske omedelbart av säkerhetsskäl får genomföras först och
underrättas inom 24 timmar, med efterföljande godkännandeprocess. Skälet ska
vara säkerhet, inte planering som blev sen.

## 5. Krav på underbiträden (krav 3548)

Leverantören ska ålägga varje underbiträde minst samma skyldigheter som
leverantören själv har mot kommunen, och ska kunna visa att det gjorts.
Särskilt:

- Behandling endast enligt instruktion.
- Sekretess för personal med åtkomst, motsvarande `PERSONALSAKERHET.md`.
- Underrättelse vid personuppgiftsincident inom tid som gör att leverantören
  klarar sina egna fyra timmar.
- Radering eller återlämnande vid uppdragets slut.
- Rätt för kommunen att granska, direkt eller genom leverantören.

## 6. Översyn

Förteckningen ses över minst årligen och vid varje förändring. Granskningen
dokumenteras även när inget ändrats.

## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
| Förteckning verifierad mot leverantörsevidens | *(nej — blockerar 2029)* |
| Kommunens godkännande inhämtat | *(nej — blockerar 2030)* |
