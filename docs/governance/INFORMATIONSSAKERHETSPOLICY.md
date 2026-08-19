# Informationssäkerhetspolicy

> **Utkast.** Inte antaget. Se `README.md` i den här katalogen.
> Täcker krav 3501, 3510, 3520, 3557.

## 1. Syfte och omfattning

Kommunsign behandlar handlingar som en kommun fattar beslut med, och de bevis
som gör besluten rättsligt hållbara. En förlorad handling är en förlorad
myndighetsutövning; en manipulerad handling är värre än en förlorad, eftersom
den ser giltig ut.

Policyn gäller all information som hanteras i tjänsten och alla som arbetar
med den — anställda, konsulter och underbiträden.

## 2. Ledningssystem

Leverantören driver ett ledningssystem för informationssäkerhet (LIS) med
följande beståndsdelar. Ambitionen är ISO/IEC 27001-struktur; certifiering är
ett separat beslut och påstås inte här.

| Beståndsdel | Var den finns |
| --- | --- |
| Policy och regler | Det här dokumentet |
| Riskhantering | `RISKHANTERING.md` |
| Personalsäkerhet | `PERSONALSAKERHET.md` |
| Leverantörsstyrning | `UNDERBITRADEN.md` |
| Incidenthantering | `INCIDENTHANTERING.md` |
| Intern granskning | `REVISION.md` |
| Teknisk hotmodell | `../THREAT_MODEL.md` |
| Utvecklingsregler | `../../AGENTS.md` |

## 3. Grundprinciper

Fyra principer, valda för att de går att kontrollera i efterhand:

1. **Neka som förval.** En funktion som inte är konfigurerad ska vägra, inte
   gissa. En okonfigurerad signeringstjänst signerar inte; en tenant utan
   BankID-konfiguration kan inte starta en signering; ett metrics-endpoint
   utan credential är stängt.
2. **Tenantgränsen är inte förhandlingsbar.** Tenantidentitet hämtas alltid ur
   den bundna konfigurationen, aldrig ur ett inkommande meddelande. Databasen
   upprätthåller isoleringen med radnivåsäkerhet, inte bara applikationen.
3. **Påstå inte mer än vad som är kontrollerat.** En PAdES-nivå registreras
   bara när insamlad evidens faktiskt bär den. Ett arkivpaket påstås inte vara
   konformt med ett schema det inte validerats mot.
4. **Bevis före bekvämlighet.** Där de två står i konflikt vinner det som går
   att visa i efterhand: hashkedjad auditlogg, oföränderliga evidensobjekt,
   deterministiska arkivpaket.

## 4. Regler för tillgångar (krav 3520, 3557)

**Informationsklassning.** All information i tjänsten behandlas som minst
känslig personuppgift om den rör en fysisk person. Handlingar under signering
klassas som skyddsvärda: obehörig ändring är den allvarligaste händelsen.

**Åtkomst.** Behörighet tilldelas per roll, aldrig per person direkt, och
default är ingen behörighet. En användare vars grupp inte är mappad till en
roll får ingen roll — inte en standardroll. Behörighetstilldelning som pekar
på en roll utanför tenantens tillåtna uppsättning är ett fel, inte en tyst
tilldelning.

**Utrustning.** Arbete med produktionsdata sker på utrustning med
diskkryptering, skärmlås och automatiska säkerhetsuppdateringar. Produktionsdata
kopieras inte till lokal utrustning.

**Kryptografiska nycklar.** Nycklar hanteras enligt
`../runbooks/KEY_ROTATION.md`. Signeringsnycklar i produktion ska ligga i HSM
eller fjärr-QSCD; en installation som rapporterar mjukvaruskyddad nyckel är
inte produktionsgodkänd.

**Avveckling.** Utrustning som lämnar organisationen raderas kryptografiskt.
Gallring i tjänsten följer `packages/retention` och kräver fyra ögon.

## 5. Regler för utveckling (krav 3510)

De icke förhandlingsbara utvecklingsreglerna finns i `AGENTS.md` och gäller
alla ändringar oavsett vem eller vad som skriver dem. Utöver dem:

- Ingen ändring når `main` utan att de automatiska grindarna passerar.
- Hemligheter får inte finnas i repot. `npm run scan:secrets` är en grind.
- Beroenden hålls avsiktligt minimala. Ett nytt körtidsberoende kräver ett
  uttryckligt beslut, dokumenterat som ADR.
- Migrationer är framåtriktade och beskriver syfte, påverkan, backfill,
  rollback och verifiering.

## 6. Efterlevnad

Avsteg från policyn ska dokumenteras med skäl, omfattning, sluttid och
godkännande. Ett odokumenterat avsteg behandlas som en incident enligt
`INCIDENTHANTERING.md`.

## 7. Översyn

Policyn ses över minst årligen och vid varje väsentlig förändring av tjänsten,
hotbilden eller regelverket.

## Antagande

| Fält | Värde |
| --- | --- |
| Antaget av | *(ej antaget)* |
| Datum | *(ej antaget)* |
| Nästa översyn | *(ej antaget)* |
| Dokumentägare | *(ej antaget)* |
