# Beställningsunderlag för de externa artefakterna

Det här dokumentet svarar på frågan *hur får jag tag på dem*. Runboken
`../../runbooks/GO_LIVE_VERIFICATION.md` svarar på *hur vet jag att de
fungerar* när de landat. Blockerarna själva står i
`EXTERNAL_EVIDENCE_BLOCKERS.md`.

För varje post: vem du vänder dig till, exakt vad du ska be om, vad du får
tillbaka, var det landar i systemet, och vad som brukar gå fel.

Ledtiderna är uppskattningar, inte utfästelser. De varierar med leverantör och
med hur färdig din egen dokumentation är när du frågar.

---

## Beslutet som styr allt annat: avancerad eller kvalificerad?

Ta det här beslutet först. Det avgör post 1, 2 och 3, och skillnaden är stor i
både tid och pengar.

| | Avancerad elektronisk underskrift (AdES) | Kvalificerad (QES) |
| --- | --- | --- |
| Nyckelskydd | HSM räcker, och är en god ordning snarare än ett lagkrav | QSCD krävs — i praktiken köper du signeringstjänsten av en betrodd tjänsteleverantör |
| Certifikat | Kommersiell CA duger | Kvalificerat certifikat från en QTSP på EU:s förtroendelista |
| Ledtid | Veckor | Månader |
| Kostnad | Betydligt lägre | Betydligt högre |

**Upphandlingen och den befintliga arkitekturen pekar på avancerad.**
`KOMMUNSIGN_SIGNING_KEY_PROTECTION` accepterar `HSM` och `REMOTE_QSCD`, men
vägrar `SOFTWARE` i produktion — det är den nivå systemet kräver, och HSM
räcker för den.

Om Kungälv skulle kräva kvalificerad underskrift ändras posterna nedan: du
köper då en fjärrsigneringstjänst i stället för att bygga ihop certifikat,
HSM och TSA var för sig. Fråga kommunen innan du beställer något.

---

## 1. Signeringscertifikat från en CA

**Vad det är.** Ett certifikat som identifierar den som skriver under. Eftersom
SignService skriver under å organisationens vägnar är det normalt en
**elektronisk stämpel** (e-seal) för en juridisk person, inte ett personligt
certifikat.

**Vem du frågar.** En betrodd tjänsteleverantör. Utgå från EU:s förtroendelista
(*EU Trusted List* / *eIDAS Trusted List Browser*) och filtrera på Sverige;
Post- och telestyrelsen är tillsynsmyndighet och listar de svenska
tjänsteleverantörerna. Både svenska och andra europeiska leverantörer går bra
för avancerad nivå.

**Vad du ber om, ordagrant:**

> Certifikat för elektronisk stämpel (e-seal) för juridisk person, för
> användning i PAdES-underskrifter av kommunala handlingar. Nyckeln genereras
> och förvaras i HSM. Vi behöver certifikatet, hela kedjan upp till rot-CA, och
> er certifikatpolicy (CP/CPS) samt OID.

**Vad du får tillbaka.** Certifikatet, mellanliggande CA-certifikat, rot-CA, och
CP/CPS-dokumentet. Certifikatpolicyn är en del av evidensen — det är den som
säger vad certifikatet betyder.

**Var det landar.** Nyckeln stannar i HSM:et (post 2). Certifikatkedjan
levereras in i token-konfigurationen. Trust anchors för valideringssidan sätts
med `SIGNING_TRUST_ANCHORS_BASE64` (kommaseparerade base64-DER, utan
PEM-huvuden).

**Vad som brukar gå fel.**
- Man beställer ett personligt certifikat i stället för en organisationsstämpel
  och upptäcker det när juridiken granskar underskriften.
- CP/CPS glöms bort. Utan den kan ingen säga vad certifikatet garanterar.
- Nyckeln genereras hos CA:n och skickas som PKCS#12. Då är påståendet om
  ensam kontroll över nyckeln borta innan man börjat. **Kräv att nyckeln
  genereras i ert HSM och att bara en CSR lämnar det.**

**Ledtid.** Typiskt 2–6 veckor, mest organisationsvalidering.

---

## 2. HSM eller fjärr-QSCD

**Vad det är.** Hårdvara eller en tjänst som håller den privata nyckeln så att
den inte kan kopieras ut. Systemet läser den över PKCS#11.

**Vem du frågar.** Tre realistiska vägar, i stigande ordning efter hur mycket
du själv driftar:

| Väg | Passar när | Kommentar |
| --- | --- | --- |
| Molnleverantörens HSM-tjänst | Ni redan driftar i molnet | Snabbast. Kräver att leverantören erbjuder PKCS#11-åtkomst. |
| Fjärrsigneringstjänst från en betrodd tjänsteleverantör | Ni vill inte hantera nycklar alls | Certifikat och nyckelskydd i ett köp. Sätt `REMOTE_QSCD`. |
| Eget HSM | Särskilda krav på fysisk kontroll | Längst ledtid, kräver egen drift och rutiner. |

**Vad du ber om, ordagrant:**

> HSM-baserat nyckelskydd med **PKCS#11-gränssnitt** för RSA-2048 eller
> P-256-nycklar. Nyckeln ska genereras i modulen och inte kunna exporteras. Vi
> behöver PKCS#11-biblioteket, en konfigurationsfil, och en beskrivning av hur
> åtkomst till nyckeln loggas.

**Var det landar.** `KOMMUNSIGN_SIGNING_PKCS11_CONFIG` pekar på
konfigurationsfilen, `KOMMUNSIGN_SIGNING_KEY_ALIAS` på nyckelns alias, och
`KOMMUNSIGN_SIGNING_KEY_PROTECTION` sätts till `HSM` eller `REMOTE_QSCD`.
`KOMMUNSIGN_SIGNING_KEYSTORE_PATH` används inte alls då.

**Vad som brukar gå fel.**
- Man köper en nyckelhanteringstjänst utan PKCS#11 och upptäcker att den bara
  går att nå genom leverantörens eget API. Fråga uttryckligen efter PKCS#11.
- Nyckeln görs exportbar "tills vidare". Då är den mjukvaruskyddad, oavsett var
  den ligger.

**Ledtid.** Molntjänst: dagar. Fjärrsignering: 4–8 veckor med avtal. Eget HSM:
månader.

---

## 3. Tidsstämplingstjänst (RFC 3161)

**Vad det är.** En betrodd part som intygar att underskriften fanns vid en viss
tidpunkt. Utan den stannar kedjan på PAdES-B; med den når den PAdES-T.

**Vem du frågar.** Samma förtroendelista som i post 1 — de flesta betrodda
tjänsteleverantörer säljer tidsstämpling separat. För offentlig sektor är en
**kvalificerad tidsstämpel** det försvarbara valet även när underskriften bara
är avancerad, eftersom den har en rättslig presumtion om tidpunkten.

**Vad du ber om, ordagrant:**

> RFC 3161-tidsstämplingstjänst över HTTP, kvalificerad enligt eIDAS, med
> angiven volym per år. Vi behöver endpoint-URL, autentiseringsmetod, och TSA:ns
> certifikatkedja.

**Var det landar.** `KOMMUNSIGN_SIGNING_TSA_URL`. Så snart den är satt
rapporterar `/health` `timestampConfigured: true` och `PAdES-T` dyker upp i
`supportedPadesLevels`.

**Vad som brukar gå fel.** Gratis publika TSA:er används "tills vidare". De har
ingen utfästelse om tillgänglighet och ingen part som svarar för tidpunkten —
i en handling som ska hålla i tio år är det inte en besparing.

**Ledtid.** 1–4 veckor. Kortast av de tre.

---

## 4. BankID i produktion, genom TIC

**Vad det är.** Produktionscredentials hos den BankID-förmedlare systemet redan
använder. Kommunsign talar med TIC; TIC håller bankrelationen.

**Vem du frågar.** TIC, kommersiellt. Observera att BankID inte säljs direkt
till tjänsteleverantörer i det vanliga fallet — man går genom en bank som är
BankID-utgivare, eller genom en förmedlare. Det är därför förmedlaren finns.

**Vad du ber om, ordagrant:**

> Produktionsåtkomst för underskrift med BankID. Vi behöver API-nyckel för
> produktion, bekräftad bas-URL, samt registrering av vår callback-URL och
> webhook-URL. Vi behöver också veta vilket visningsnamn som visas för
> användaren i BankID-appen, och hur vi ändrar det.

**Vad du får tillbaka.** API-nyckel, bas-URL, webhook-hemlighet, och en
bekräftelse på registrerade URL:er.

**Var det landar.** `TIC_BASE_URL`, `TIC_API_KEY`, `TIC_CALLBACK_URL`,
`TIC_WEBHOOK_URL`, `TIC_WEBHOOK_SECRET`, samt `TIC_BANKID_ENABLED=true`.

**Viktigt om ordningen.** BankID-utrullning per tenant sätts vid provisionering
utifrån installationens konfiguration. En tenant som provisionerats medan
BankID var okonfigurerat kan inte starta en signering. Sätt credentials
**innan** ni provisionerar Kungälvs tenant, eller uppdatera
`app.tenant_signing_settings.tic_bankid_rollout_enabled` efteråt.

**Vad som brukar gå fel.** Visningsnamnet i BankID-appen blir förmedlarens i
stället för kommunens. Fråga uttryckligen — det är det enda undertecknaren ser.

**Ledtid.** 2–6 veckor, beroende på avtal.

---

## 5. Freja (om det ska erbjudas)

Bara nödvändigt om Freja ska vara ett alternativ vid sidan av BankID.

**Vem du frågar.** Freja eID AB.

**Vad du ber om.** Relying party-avtal, mTLS-klientcertifikat för produktion,
och organisationsregistrering om OrgID ska användas.

**Ledtid.** 4–8 veckor.

---

## 6. Kungälvs IdP-metadata

**Vad det är.** Uppgifterna som gör att kommunens egna medarbetare kan logga in
med sina vanliga konton.

**Vem du frågar.** Kungälvs kommuns IT-avdelning, inte er egen.

**Vad du ber om, ordagrant:**

> För federerad inloggning behöver vi antingen er metadata-URL, eller
> EntityID, SSO-endpoint (HTTP-POST-bindning) och signeringscertifikatet i
> base64. Vi behöver också att Kommunsign registreras som service provider hos
> er, med vår ACS-URL och vårt EntityID. Slutligen behöver vi veta vilka
> grupper som ska ge vilka roller.

**Vad du får tillbaka.** Metadata-XML eller de tre uppgifterna, plus en
bekräftelse på att Kommunsign är registrerad som SP.

**Var det landar.** `control.tenant_identity_providers`, med `enabled = true`,
`environment = 'production'`, och `public_configuration` som bär `issuer` och
`signingCertificateBase64`.

**Vad som brukar gå fel.**
- Man får ett certifikat som går ut om tre månader utan att någon noterar det.
  Fråga efter förnyelserutinen samtidigt.
- Gruppmappningen glöms. Utan den får ingen någon roll — systemet ger
  medvetet ingen standardroll till en omappad grupp, så inloggningen lyckas och
  användaren kan ingenting.

**Ledtid.** 1–3 veckor om kommunens IT har rutinen; annars längre, eftersom det
ofta ligger hos en driftleverantör.

---

## 7. Mottagande e-arkivs FGS-version och lokala utökningar

**Vad det är.** Det sista steget för att arkivpaketet ska kunna tas emot.
Paketet valideras redan mot Riksarkivets publicerade schemauppsättning i CI.
Det som saknas är arkivets egen.

**Vem du frågar.** Kungälvs e-arkiv, eller dess leverantör.

**Vad du ber om, ordagrant:**

> Vilken version av FGS Paketstruktur tar ni emot? Vi bygger mot RAFGS1V1.2.
> Har ni lokala profilutökningar eller egna XSD:er utöver Riksarkivets
> publicerade uppsättning? Kan vi få dem, och en testinlämning för att bekräfta
> att paketet går att ta emot?

**Var det landar.** XSD:erna läggs bredvid de publicerade i
`services/validation-service/src/main/resources/fgs/`, registreras i
`BUNDLED_SCHEMAS`, och först när `npm run verify:fgs` är grön mot dem sätts
`receivingArchiveSchemaValidated: true`.

**Räkna med att det smäller första gången.** Valideringen mot den publicerade
uppsättningen hittade två profilbrott direkt. En lokal utökning är strängare
igen.

**Ledtid.** Dagar för svaret, veckor för en testinlämning.

---

## 8. Backupevidens och genomförd återläsning

**Vad det är.** Två skilda saker som ofta blandas ihop: att backuper tas, och
att de går att läsa tillbaka.

**Vem du frågar.** Den som driftar databaserna.

**Vad du ber om, ordagrant:**

> Vilket backupfönster och vilken retention gäller för våra databaser? Vi
> behöver också att ert backupjobb anropar vår endpoint efter varje lyckad
> körning — ett curl-anrop, formatet står i vår runbook. Slutligen behöver vi
> boka en återläsningsövning där vi tillsammans återställer till en testmiljö
> och dokumenterar utfallet.

**Var det landar.** `BACKUP_SIGNAL_TOKEN` sätts, backupjobbet postar till
`/metrics/backup-completions`, och `BACKUP_SIGNAL` går till MET av sig själv.
Den går tillbaka till BLOCKED om rapporterna slutar komma, vilket är hela
poängen.

**Ledtid.** Rapporteringen: dagar. Återläsningsövningen: boka den, den blir
annars aldrig av.

---

## 9. Avtal, priser, referenser, escrow

Dessa har ingen teknisk landningsplats och verifieras inte av något kommando.

| Post | Vem | Krav |
| --- | --- | --- |
| Avtalsvillkor, prisbilaga, förvaltningsprocess | Avtalsparterna | 2039–2043, 3554 |
| Supportbilagan från Kungälv | Kungälvs kommun | 2040 — jämförs mot `KUNGALV_SUPPORT_SLA.md` |
| Revisionsrätt och genomförd revision | Avtalsparterna | 3556 |
| Två referenskunder i drift | Kommersiellt | 2032 |
| Escrow-avtal | Tredje part | 3525 |
| Personuppgiftsbiträdesavtal och sekretessförbindelse | Avtalsparterna | 3555 |

Supportbilagan är värd att begära tidigt: den är en jämförelse mot ett dokument
som redan finns, inte ett utvecklingsarbete, och den blockerar inte teknisk
driftsättning.

---

## Ordning att beställa i

Utgå från ledtid, inte från hur viktigt något känns.

1. **Certifikat och HSM** (post 1 och 2) — beställs tillsammans, eftersom
   nyckeln ska genereras i HSM:et innan CSR:en skickas. Längst ledtid, blockerar
   flest tekniska krav.
2. **BankID genom TIC** (post 4) — parallellt, egen avtalsprocess.
3. **Kungälvs IdP-metadata** (post 6) — fråga tidigt även om det går fort, för
   det ligger ofta hos en tredje part.
4. **TSA** (post 3) — kortast ledtid, men beställ ändå innan ni behöver den.
5. **E-arkivets schemauppsättning** (post 7) — svaret går fort, testinlämningen
   inte.
6. **Backup** (post 8) — kan göras när som helst, glöms alltid bort.
7. **Avtalsposterna** (post 9) — löper vid sidan av.

## När något har landat

Kör verifieringen för just den posten enligt
`../../runbooks/GO_LIVE_VERIFICATION.md`, och därefter:

```bash
npm run check:production-go
```

på målmiljön, inte på en laptop. Kör den någon annanstans läser fem av nio
förutsättningar UNKNOWN, och det säger något om ditt skal snarare än om
leveransen.
