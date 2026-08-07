# Leveransmognad — Kungälvs kommun, Dnr KS2026/1005

Bedömningsdatum: 2026-08-07
Branch: `claude/kommunsign-production-remediation-p5empn`

Detta dokument sammanfattar var Kommunsign står mot Kungälvs krav och vad som
återstår. Det är avsiktligt konservativt: ett krav räknas som uppfyllt först
när implementation, verifiering och evidens finns samtidigt.

## Sammanställning

| Typ | PASS | PARTIAL | GAP | BLOCKED_EXTERNAL | Summa |
| --- | ---: | ---: | ---: | ---: | ---: |
| SKA | 9 | 63 | 23 | 35 | 130 |
| BÖR | 0 | 4 | 3 | 1 | 8 |

Detaljer per krav finns i `REQUIREMENT_MATRIX.md`, externa beroenden i
`EXTERNAL_EVIDENCE_BLOCKERS.md`. Båda genereras av
`node scripts/build-requirement-matrix.mjs`, som misslyckas om ett krav saknar
bedömning eller om ett BLOCKED_EXTERNAL-krav saknar namngiven blockerare.

## Slutsats

**Kommunsign är i dag inte redo att tas i drift hos Kungälv.** Det beror inte
i första hand på arkitekturen, som på flera punkter är starkare än vad kraven
fordrar, utan på att kedjan från signering till bevis inte är komplett och att
flera SKA-krav saknar implementation.

Tre saker avgör tidplanen.

### 1. Signeringskedjan är inte bevisbar än

Funktionella kravet på avancerad elektronisk underskrift enligt DIGG (F001) är
det mest centrala i hela upphandlingen, och det kan inte styrkas i dag.
Grunden finns: signeringsavsikt med dokumentsnapshot och hash, oföränderliga
dokumentversioner, identitetstransaktioner och evidenspaket med
manipulationsdetektering. TIC/BankID-bevis verifieras mot XML-DSig och OCSP,
och verifieraren är fail-closed — ett overifierat bevis avvisas.

Det som saknas är PAdES-produktion och DSS-validering. `BlockedSigningEngine`
i signservice blockerar signering, vilket är rätt beteende, men innebär att
ingen signerad PDF ännu producerats eller validerats. Utan det kan varken AEU
(F001), PDF/A-leverans (F013) eller Adobe Reader DC-verifiering (2007) styrkas.

Det gäller att inte förväxla delarna: BankID-autentisering plus en lagrad
SHA-256 är inte en avancerad elektronisk underskrift.

### 2. Flera SKA-krav saknar implementation

23 SKA-krav är rena implementationsluckor utan externt beroende. De tyngsta:

- **Digitalt bevarande (2064–2067)** — ingen FGS 1.2-export finns.
- **GDPR (2023)** — inget stöd för registerutdrag, rättelse, begränsning,
  radering eller dataportabilitet, och det måste täcka både CONTROL och DATA.
- **Provisionering (2082–2085)** — ingen automatisk livscykel för användare.
- **Tillgänglighet (2015)** — WCAG 2.0 AA är inte verifierat. En grön
  automatisk skanning räcker inte som bevis.
- **Systemdokumentation på svenska (2057–2061)** — saknas som sammanhållen
  leverans.

### 3. 36 krav kan inte lösas med kod

De kräver avtal, leverantörsevidens eller organisatoriska åtgärder. De mest
tidskritiska, eftersom de har ledtid och inte kan forceras sent:

- **3527/3528** — fysisk skyddsnivå i datahall enligt MSB nivå 3. Att drift
  sker hos en molnleverantör är inte i sig bevis för detta. Antingen hämtas
  leverantörsevidens, eller så måste driften flyttas — det senare påverkar
  hela tidplanen.
- **3536** — tidssynkronisering mot GPS eller svensk UTC(SP) ska styrkas av
  infrastrukturleverantören.
- **2032** — minst två kunder i drift.
- **3501** — ledningssystem för informationssäkerhet.
- **3525** — källkodsdeposition.
- **2030/2031/3548** — underbiträdesförteckning godkänd av kommunen.
- **3555** — tecknat personuppgiftsbiträdesavtal.

## Åtgärdat i denna omgång

**Läckta produktionsnycklar.** `.kommunsign-production-secrets.env` låg
incheckad i git med upplösta värden för PII-krypteringsnyckeln,
blind index-nyckeln för personnummer och den interna gatewaynyckeln.
Allvarligast är blind index-nyckeln: personnummer har litet sökrum, så med
nyckeln kan indexet återidentifieras och pseudonymiseringen är därmed bruten.
Filen är borttagen och scannern hårdare, men värdena finns kvar i historiken —
**nycklarna måste roteras innan produktionsdrift**. Se
`docs/operations/leaked-key-rotation-2026-08.md`.

**Kravmatris.** Samtliga 138 krav extraherade ur källdokumentet, låsta mot
dess SHA-256, med bedömning per krav och genererade blockerarlistor.

**Gallring (2068–2072).** Beslutslagret implementerat: legal hold spärrar,
retentionklockan startar först vid ärendets avslut, och åtkomstloggar kan inte
gallras under PUB-avtalets femårsgolv utan dokumenterad Instruktion.
Gallringsrapporten rapporterar ofullständig gallring i stället för att
rapportera framgång vid delvis radering. Exekveringen återstår.

**Leverantörsoberoende identitetsregister.** Anropare frågar efter
identitetsmetod, inte provider. Freja OrgID, Freja+, Sverige-id och eIDAS är
modellerade och kan aktiveras utan ombyggnad. Alla grindar fail-closed:
oavslutade integrationer och testprovidern avvisas i produktion, policy
rangordnas över feature flag, och QES avvisas helt så länge ingen QTSP är
integrerad.

## Rekommenderad ordning

1. Rotera de läckta nycklarna. Blockerar allt annat.
2. Slutför PAdES och DSS-validering. Utan detta finns ingen produkt att
   leverera mot F001.
3. Begär leverantörsevidens för 3527, 3528 och 3536 tidigt — svaret kan
   tvinga fram en driftmigrering.
4. Implementera FGS-export, GDPR-flöde och provisionering.
5. Verifiera WCAG och webbläsarstöd med riktiga mätningar.
6. Etablera support- och incidentprocess enligt `KUNGALV_SUPPORT_SLA.md`.

## Vad som medvetet inte gjorts

Inget krav har markerats som uppfyllt utan evidens. Där implementationen
finns men verifieringen saknas står PARTIAL, inte PASS. Där kravet beror på
något utanför kodbasen står BLOCKED_EXTERNAL med namngiven blockerare, inte en
uppskattning av att det troligen är uppfyllt.
