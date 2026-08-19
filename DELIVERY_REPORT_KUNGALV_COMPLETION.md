# Leveransrapport — Kommunsign mot Kungälv, Dnr KS2026/1005

Gren: `claude/happy-planck-ewrny2`
Datum: 2026-08-19
Commits: `140d943`, `1b39d49`, `f9000b1`, `b340594`, `d75d7b6`, `07452c7`, `2c7e739`, `0d4a009`, `a6a4f56`

## Vad uppdraget handlade om

Repot hade två osammanhängande kedjor. Den ena levde: TIC/BankID samlade in och
verifierade identitetsbevis. Den andra var död kod: `packages/signing-engine`,
`packages/pades`, `services/signservice` och tio signaturtabeller som ingen
runtime-kod någonsin anropade.

Konsekvensen var felet uppdraget pekade ut. `handleSignatureValidate` satte
`signers.status='signed'` direkt efter verifierad TIC-evidens. **Ingen PDF blev
kryptografiskt signerad.** Ett ärende kunde slutföras och arkiveras utan att det
någonsin funnits en avancerad elektronisk underskrift i systemet.

## Fem verkliga fel som hittades och rättades

Utöver det uppdraget namngav.

**1. TIC-flödet kunde inte slutföras mot någon databas.** Migration 0010 gav
`app.identity_transactions` ett versalt statusvokabulär (`PENDING`, `COMPLETED`)
medan all applikationskod skriver gemener, och vokabuläret saknade
`complete_collected` och `verified` helt. Den allra första INSERT:en av en
BankID-session avvisades av CHECK-villkoret.

**2. Samma migrations transitionstabell var likaså versal**, så med gemena
statusar matchade ingen CASE-gren, `allowed` blev tom, och *varje* statusändring
avvisades. Tillsammans betydde 1 och 2 att ELECTRONIC_SIGNATURE-vägen aldrig
körts skarpt.

**3. Webhook-prenumeranter kunde aldrig verifiera en signatur.** Endpoints
lagrade en `vault://`-referens som ingenting upplöser, och hemligheten
returnerades aldrig till kunden. Varje leverans hade varit en osignerad,
förfalskningsbar POST.

**4. Coverage-kontrollen för registerutdrag var tom.** Ett obundet `store` inne i
en subquery band till coverage-tabellens egen kolumn, så jämförelsen blev
trivialt sann och fullständighetskontrollen gjorde ingenting. `tests/sql`
hittade det.

**5. Ärenden kunde skapas färdigsignerade.** Varje slutförandegrind var
`BEFORE UPDATE OF status`. Verifierat mot en riktig databas: ett ärende utan
signerare, utan evidenspaket och utan signaturkedja gick in rent som
`completed`. Migration 0021 finns för att göra exakt det omöjligt, och löftet
hade ett INSERT-format hål i sig. Migration 0028 stänger det.

## Vad som byggdes

**Underskriftskedjan (P0).** `handleSignatureValidate` sätter nu
`identity_verified`, aldrig `signed` — TIC PASS betyder styrkt identitet, inte
färdig underskrift. `PADES_CREATE` skapar signaturen via Sweden Connect
SignService, `PADES_VALIDATE` validerar oberoende via sigval-pdf, och
`packages/pades` är sista admissionsgrinden. En signerare blir `signed` först
när alla dokument i intentet är admitterade. Migration 0021 speglar det i
databasen: en signerare kan inte bli `signed` utan validerad signatur på
policyns nivå för varje dokument, och PAdES-nivån kan inte överdrivas.

**De blockerade jobbtyperna.** Alla fem dead-letterade direkt. Webhook-leverans
sker nu via databastrigger på outbox, så leveransposten skapas i samma
transaktion som affärshändelsen. Arkivexport producerar en riktig METS `sip.xml`
enligt Riksarkivets publicerade profil. Gallring, ansökningsfrist,
tenant-readiness, tenant-aktivering och certifikatövervakning är inkopplade.

**GDPR, SCIM, federation.** Tre kompletta bibliotek med noll importörer fick
runtime. Rättighetsbegäranden har tabeller, en jobbtyp och API-routes; varje av
de fem registren söks på riktigt, och ett register som inte kan sökas redovisas
som undantag med grund i stället för som en tom träff. SCIM 2.0 har en HTTP-yta
som autentiseras före sessionsupplösningen. Federationens replayskydd är nu
varaktigt i stället för en `Set` som glöms vid omstart.

**Leverans, observability, nycklar.** Färdig handling levereras via autentiserad
tidsbegränsad länk. `/metrics` finns, och varje larmregel bevakar en serie som
antingen produceras eller uttryckligen står som omatad. Nyckelrotation har ett
huvudbok som gör den återupptagbar och verifierbar.

## Ombedömningen

Alla 138 krav är ombedömda mot faktisk kod. **PASS-antalet sjönk**, från 96 till
93, och det är poängen med ombedömningen snarare än en regression:

- **2064, 2065** → BLOCKED_EXTERNAL. Att följa Riksarkivets publicerade profil
  och att vara validerad mot mottagande arkivs schemauppsättning är olika
  påståenden, och bara det första är sant.
- **2079** → PARTIAL. Beslutslogiken för federerad inloggning är komplett och
  testad, men ACS/callback-routen är inte byggd, så ingen kan faktiskt logga in
  via en IdP.
- **2037** → kvar som BLOCKED_EXTERNAL, med backup-mätvärdet namngivet som den
  specifika luckan.

Krav vars PASS byggde på ett bibliotek utan anropare — gallring 2068–2072, SCIM
2082–2085, GDPR 2023, 3511, 3518, 3519 — behåller PASS, men med evidens som
säger vad som faktiskt finns i stället för vad som fanns i ett paket.

`PRODUCTION_GO_LIVE_CHECKLIST.md` påstod att generatorn rapporterar 2005/2006
som GAP. Det stämde inte: overriden från 2026-08-11 sätter båda till PASS. Den
raden var felet och är rättad.

## PRODUCTION_GO: NEJ

Det är rätt utfall. Kedjan är komplett och bevisad end-to-end mot en
test-CA — och testerna visar att den vägrar en otillförlitlig. Produktion kräver
artefakter ingen kod kan leverera: CA-utfärdat certifikat, HSM eller QSCD,
TSA-avtal, TIC-produktionscredentials, Kungälvs IdP-metadata, mottagande arkivs
FGS-version, och att driftplattformen matar backup-serien.

Var och en står som BLOCKED_EXTERNAL mot sitt krav i
`docs/compliance/kungalv/EXTERNAL_EVIDENCE_BLOCKERS.md`, med exakt blockerare.

## Filer

- `CHANGED_FILES_KUNGALV_COMPLETION.txt` — 98 ändrade filer.
- `VERIFICATION_RESULTS_KUNGALV_COMPLETION.txt` — körda kommandon och utfall.
- `FILE_MANIFEST.sha256` — regenererad. Den tidigare täckte 370 av 1002
  spårade filer efter en regel som inte gick att rekonstruera; den täcker nu
  alla spårade filer, vilket är strikt bättre än en partiell fil som ser
  fullständig ut.
