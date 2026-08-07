# Riktlinjer för kundens egna förändringar

Krav 3547: leverantören ska ha riktlinjer och instruktioner om Beställaren avser
att göra egna förändringar i produkten.

## Vad kunden själv råder över

Följande ändras av kunden utan leverantörens medverkan, och är avsett att göras
av kunden:

| Område | Var |
| --- | --- |
| Signaturpolicyer, nivå och tillåtna metoder | Tenantportalen |
| Roller och behörigheter | Tenantportalen |
| Gruppmappning från kommunens katalog | Federations- och SCIM-konfiguration |
| Gallringsregler och legal hold | Tenantportalen, behörigheten `retention:execute` |
| Grafisk profil och e-postmallar | Tenantportalen |
| Egen domän | Onboarding- och domänflödet |
| API-klienter och scopes | Tenantportalen |
| Webhookprenumerationer | Tenantportalen |

Ändringarna är versionerade och loggade. En policyändring påverkar aldrig ett
ärende som redan startat: ärendet bär den policyversion det skapades under.

## Vad kunden inte ska ändra själv

Databasschema, RLS-policyer, migrationer och gränstjänsternas konfiguration.
En direkt schemaändring bryter de composite foreign keys och statusövergångar som
bär tenantisoleringen och bevisvärdet, och en signatur vars kedja inte längre
går att följa är inte återställbar i efterhand.

Behöver kunden något som saknas är vägen en ändringsbegäran, inte en direkt
ändring.

## Ändringsbegäran

1. Kunden beskriver behovet och önskad verkan.
2. Leverantören svarar med bedömning av påverkan på säkerhet, bevisvärde,
   prestanda och tidplan.
3. Kunden godkänner.
4. Ändringen byggs, testas i separat testmiljö och verifieras med `npm run verify`.
5. Ändringen aviseras, rullas ut och dokumenteras i `CHANGELOG.md`.

## Integrationer som kunden bygger själv

Kunden får bygga mot det publika API:t under `/v1` utan kostnad eller
volymbegränsning. API:t är versionerat: en brytande ändring får en ny version,
och den gamla lever kvar under aviserad avvecklingstid. Ett integrationsbygge
mot interna tabeller eller odokumenterade endpoints omfattas däremot inte av
det åtagandet.
