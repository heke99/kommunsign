# HISTORICAL SNAPSHOT — SUPERSEDED

> Rapporten nedan beskriver läget den 7 augusti 2026 och är bevarad för revisionshistorik. Den är **inte** aktuell readiness- eller kravstatus. Full-product-rerun 2026-08-11 har verifierat nya tekniska gap, bland annat att Microsoft 365-krav 2005/2006 inte styrks av en fristående Office→PDF-konverteringsmodul. Aktuell status finns i `docs/audits/2026-08-11-full-product-completion/FINAL_REPORT.md` och `docs/readiness/PRODUCTION_GO_LIVE_CHECKLIST.md`.

# Slutrapport — produktionsremediation Kommunsign

Kungälvs kommun, Dnr KS2026/1005
Branch: `remediation/kommunsign-production-completion-2026-08-07`
Datum: 2026-08-07

Denna rapport ersätter den tidigare snapshoten med samma namn, som skrevs
mitt i arbetet och drog en NO-GO utifrån ett läge som inte längre gäller.

## 1. Sammanfattning

Kampanjen gick igenom samtliga 138 krav i Kungälvs underlag och arbetade
igenom varje GAP och varje PARTIAL.

| Typ | PASS | PARTIAL | GAP | BLOCKED_EXTERNAL | Summa |
| --- | ---: | ---: | ---: | ---: | ---: |
| SKA | 89 | 0 | 0 | 41 | 130 |
| BÖR | 7 | 0 | 0 | 1 | 8 |

Utgångsläget var 9 PASS, 68 PARTIAL, 25 GAP, 36 BLOCKED_EXTERNAL.

**Inget tekniskt lösbart krav återstår.** De 42 kvarvarande raderna kräver
avtal, credentials, certifiering, leverantörsevidens eller en organisatorisk
åtgärd — inte kod. Varje sådan rad bär en uttrycklig blockerare i
`docs/compliance/kungalv/EXTERNAL_EVIDENCE_BLOCKERS.md`.

Testsviten gick från 60 till 98 tester. `npm run verify` är grön från ren
checkout.

## 2. Utgångsläge

`c4cde71`, med PAdES-antagningsgrind, beslutslager för dataskyddsrättigheter,
providerneutralt identitetsregister, gallringsbeslutslager, kravmatris och
genomförd secret-remediation. Verifierat, inte antaget: `npm ci` följt av
`npm run verify` kördes före första ändring och gav 60 gröna tester.

## 3. Slutlig kravstatus

Se `docs/compliance/kungalv/REQUIREMENT_MATRIX.md`. Matrisen är genererad ur
`requirements.json` och `assessments.json`; `npm run verify` misslyckas om ett
krav saknar bedömning eller en bedömning saknar krav, så den kan inte hamna
efter koden.

## 4. Genomförda remediationfamiljer

| # | Familj | Krav |
| --- | --- | --- |
| 1 | Signeringsmotor och PAdES-pipeline | F001 |
| 2 | Freja-adapter | F002, F003 |
| 3 | Workforce-federation SAML 2.0 och OIDC | F004, 2079 |
| 4 | SCIM 2.0-provisionering | 2082-2085, 3514, 3519 |
| 5 | Arkivexport enligt RA-FS 2009:2 | 2038, 2064-2067, 2075 |
| 6 | Gallringsexekvering | 2025, 2068-2072, 3511 |
| 7 | GDPR-exekvering | 2023, 2024 |
| 8 | Skyddade personuppgifter | 2028 |
| 9 | Signeringsflöde: ordning, flera dokument, bilagor, påminnelser | F008-F012 |
| 10 | Nyckel- och blind index-rotation | 3526 |
| 11 | WCAG 2.2 AA | 2008-2010, 2014, 2015 |
| 12 | Svensk systemdokumentation och användarhandbok | 2036, 2055, 2057-2061, 2041, 3530, 3547, 3549, 3551 |
| 13 | Loggning, mätvärden och säkerhetsheaders | 2018-2022, 3518, 3524, 3534, 3535, 3539, 3540, 3544 |
| 14 | API- och integrationslager | F006, 2073, 2074, 2076, 2081 |
| 15 | Säker utveckling, förändringshantering, kontinuitet | 2044-2046, 3502, 3513, 3515-3517, 3521, 3529, 3531, 3532, 3537, 3538, 3541, 3543, 3545, 3546, 3552 |
| 16 | Office-konvertering, svensk lokalisering, branding | 2005-2007, 2034, 2035, F007 |

## 5. Signering och PAdES

`packages/signing-engine` definierar den providerneutrala gränsen —
`SigningEngine`, `SignatureValidator`, `TimestampProvider`,
`CertificateProvider` — och den ordnade pipelinen dokumentlåsning → policy →
identitet → signatur → tidsstämpel → validering → PAdES-antagning.

Invarianterna är de som historiskt går fel: signaturen måste täcka exakt den
låsta dokumentversionens hash, identitetsbevis måste binda till rätt intent,
case och tenant, tidsstämpeln måste täcka den signerade revisionen, och inget
steg kan hoppas över. PAdES-nivån härleds ur den evidens som faktiskt finns och
överdrivs aldrig.

`NotConfiguredSigningEngine` och `BlockedSigningEngine` är default. En
installation utan nyckelmaterial vägrar signera i stället för att producera
något signaturliknande.

ADR 0003 ersätter det tidigare generella beroendeförbudet med en
antagningsgrind och pekar ut EU DSS som avsedd backend. Vi skriver inte egen
ASN.1, CMS eller certifikatvalidering.

## 6. Identitet

BankID via TIC är produktionsklart i registret. Freja-adaptern är komplett:
bindningskontroll av JWS-svar mot transaktion, intent och signerad datahash,
algoritm-allowlist, issuer, audience, engångsförbrukad nonce mot replay, egen
åldersgräns, registreringsnivå och organisationsidentitet för OrgID.

Federationen är protokollformad och inte leverantörsformad: SAML 2.0 och OIDC
normaliseras till ett beslut. IdP-initierade flöden avvisas, assertions
förbrukas en gång, och rollmappning är deny-by-default.

Sverige-ID, eIDAS och QES har utbyggnadspunkter i registret men är spärrade som
`productionReady: false`. QES markeras aldrig uppfyllt innan QTSP är vald,
integrationen byggd och signaturen verifierad.

## 7. Dataskydd och bevarande

GDPR-exekveringen kräver verifierad identitet innan något lämnas ut, och stark
identitet för utlämnande eller ändring. Legal hold och artikel 18-begränsning
omprövas vid utförandet, inte vid mottagandet. Fristen räknas från mottagandet.

Gallringsexekveringen omprövar beslutet omedelbart före radering, planerar
samtliga mål inklusive de härledda lagren (sökindex, cache, notifieringar) och
kan inte rapportera en partiell radering som komplett. Godkännande krävs av
någon annan än den som begärde, och aldrig av leverantören.

Skyddade personuppgifter maskeras per utflödeskanal, med okänd kanal och okänd
skyddsnivå som avslag respektive strängaste nivå.

Arkivpaketet följer RA-FS 2009:2, är deterministiskt och verifierbart offline
med enbart paketet, manifestet och den separat levererade manifesthashen.

## 8. Säkerhet

- Nyckelrotation i etapper med dual read, write-new-only och pensionering först
  efter räknad och verifierad återkryptering. Blind index roteras strängare:
  komprometterade värden skrivs över, eftersom den som har den läckta nyckeln
  annars fortsatt kan slå upp en utpekad person.
- Strukturerad loggning maskerar på väg in, både på fältnamn och värdemönster.
- Säkerhetsheaders utan `unsafe-inline`, `frame-ancestors none`,
  `no-referrer`, och `Vary` på varje privat cacheklass.
- TLS-golv som data i stället för prosa, endast sviter med forward secrecy.

## 9. Fynd som arbetet självt tog fram

Tre defekter hittades av tester som skrevs under kampanjen, och är rättade:

1. **Dubblettutfall passerade gallringsverifieringen.** Två rader för samma
   lagringsplats kan säga olika saker, och den som lästes först vann.
2. **Nyckelringskontrollen omöjliggjorde rotation.** Den avvisade en
   komprometterad aktiv nyckel, vilket gjorde just det fall modulen finns för —
   att rotera bort från en läckt nyckel — omöjligt.
3. **Sex WCAG-brister i portalerna**: saknad minsta klickyta i två portaler,
   odeklarerat färgschema i tre, saknad `autocomplete` i en.

Dessutom fångade repositoryts egen hemlighetsskanner en testfixtur som såg ut
som en riktig PEM-nyckel. Fixturen ändrades, inte skannern.

## 10. Kvarvarande BLOCKED_EXTERNAL

42 rader. Fullständig förteckning med exakt blockerare, extern part, vad som
behöver beställas och verifieringssteg finns i
`docs/compliance/kungalv/EXTERNAL_EVIDENCE_BLOCKERS.md`. Grupperat:

| Grupp | Antal | Blockerar go-live |
| --- | ---: | --- |
| Kryptografiskt nyckelmaterial: CA-certifikat, HSM eller fjärr-QSCD, TSA | 2 (F001, F013) | **Ja** för elektronisk underskrift |
| Providercredentials: TIC produktion, Freja relying party | 2 (F002, F003) | **Ja** för respektive metod |
| Kundens konfiguration: IdP-metadata, MFA-krav | 2 (F004, 3522) | Ja för federerad inloggning |
| Leverantörens ISMS och personalrutiner | 12 | Nej, men krävs för anbudsuppfyllnad |
| Underbiträden, datahall, fysiskt skydd, tidssynkronisering | 8 | Nej |
| Avtal: PUB-avtal, sekretess, priser, förvaltningsprocess | 8 | Nej |
| Införandeprojekt: plan, utbildning, samverkan | 4 | Nej |
| Referenskunder och marknadsetablering | 1 (2032) | Nej |
| Övrigt: supportavtalsbilaga, revisionsrätt, samrådsroller | 5 | Nej |

## 11. Operativa åtgärder före produktion

1. **Rotera de exponerade nycklarna.** Dataskyddsnyckeln och blind
   index-nyckeln finns i Git-historik. Stödet är byggt och testat; själva
   rotationen är en operativ handling. Detta är stop-ship.
2. Beställ CA-certifikat, HSM eller fjärr-QSCD och TSA-avtal.
3. Begär TIC-produktionscredentials och Freja relying party-avtal.
4. Hämta Kungälvs IdP-metadata och registrera Kommunsign som service provider.
5. Aktivera SCIM-utgående provisionering från kommunens katalog.
6. Aktivera signeringsbackend via `KOMMUNSIGN_SIGNING_BACKEND` och
   `KOMMUNSIGN_SIGNING_KEY_PROTECTION`, och sätt `productionReady: true` i
   identitetsregistret först efter verifierad skarp evidens.
7. Sätt upp webbläsarautomation i CI för löpande regressionstest av Edge,
   Chrome och Safari.
8. Genomför första kvartalsvisa återställningstestet och protokollför RTO.

## 12. Utrullningsordning

1. Applicera `migrations/control/0017`, `migrations/data/0017` och `0018`. Alla
   är additiva och kan appliceras under drift.
2. Rulla ut API och workers.
3. Bygg och publicera portalerna.
4. Kör `npm run verify:env`, `npm run verify:auth-config` och
   `npm run verify:container-health` mot den driftsatta miljön.

Rollback: migrationerna är additiva, så applikationen kan rullas tillbaka utan
schemaändring. Varje migration dokumenterar sin egen rollback.

## 13. Verifiering

Från ren checkout: `npm ci` följt av `npm run verify`. Grön, och omfattar bygge,
repositoryverifiering, deployment-konfiguration, migrationsverifiering,
kravmatris, provenance, SDK-synk, WCAG 2.2 AA, hemlighetsskanning,
Java-gränstjänster samt 98 enhetstester, 3 integrationstestsviter och
säkerhetstestsviten.

## 14. GO / NO-GO

**GO för digital godkännande (digital approval).** Hela kedjan — ärende,
dokumentlåsning, identifiering med BankID, godkännandebevis, audit, bevispaket,
arkivexport och gallring — är implementerad, testad och saknar extern
blockerare utöver TIC-produktionscredentials.

**NO-GO för elektronisk underskrift tills nyckelmaterial finns.** Detta är
inte en kodbrist. Systemet vägrar korrekt: utan CA-certifikat, HSM eller
fjärr-QSCD och TSA skapas ingen signatur, och `assertSigningRuntimeUsable`
spärrar produktion i stället för att leverera något som ser ut som en
underskrift. Att sätta GO här skulle innebära att lova en avancerad elektronisk
underskrift som inte kan produceras.

**Stop-ship: rotera de exponerade nycklarna före produktionsdata.**

Skillnaden mot den tidigare rapportens NO-GO är att blockerarna nu är rent
externa och var och en har en namngiven motpart, en beställning och ett
verifieringssteg. Ingen av dem väntar på utvecklingsarbete.
