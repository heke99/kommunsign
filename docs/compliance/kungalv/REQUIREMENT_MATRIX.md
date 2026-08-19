# Kravmatris — Kungälvs kommun, Dnr KS2026/1005

<!-- GENERERAD FIL. Redigera inte för hand.
     Kör `node scripts/build-requirement-matrix.mjs` efter ändring i
     requirements.json, assessments.json eller daterad assessment override. -->

Bedömningsdatum: 2026-08-19

Den historiska bedömningen kompletteras med daterade overrides endast när en ny verifiering visar att en äldre status inte längre är korrekt. Kravtexten hämtas alltid oförändrad från källutdraget.

## Källa

Kravtexten är extraherad ur `Bilaga 1 - IT-krav Kungälvs Kommun.xlsx`
(SHA-256 `b7c214f9ab729f154ecd6f2c16c5d91fef8f7fbfb006e3588b5f6f4da84a4a7e`).
Extraherad ur Kungälvs kommuns upphandlingsunderlag Dnr KS2026/1005. Kravtexten är oförändrad.

Kraven i fliken *Funktionella krav* saknar ID i källan och har därför
tilldelats lokala ID på formen `F001`. Övriga ID kommer från källan.

## Statusdefinitioner

- **PASS** — Implementation finns, verifieras av automatiserat test eller migrationsgranskning, och evidens är angiven.
- **PARTIAL** — Delar finns implementerade men kravet är inte helt uppfyllt eller inte verifierat.
- **GAP** — Ingen implementation finns ännu. Tekniskt genomförbart utan externt beroende.
- **BLOCKED_EXTERNAL** — Kräver avtal, credential, certifiering, leverantörsevidens eller organisatorisk åtgärd utanför kodbasen.

## Sammanställning

| Typ | PASS | PARTIAL | GAP | BLOCKED_EXTERNAL | Summa |
| --- | ---: | ---: | ---: | ---: | ---: |
| SKA | 87 | 0 | 0 | 43 | 130 |
| BÖR | 7 | 0 | 0 | 1 | 8 |

Ingen rad är obehandlad: generatorn misslyckas om ett krav saknar bedömning.

## Funktionella krav

### F001 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Uppfyller Diggs krav på Avancerad elektronisk underskrift |
| Typ | SKA |
| Kategori | Signering |
| Referens | E-underskrift \| Digg |
| Nuläge | Signeringskedjan är nu komplett som teknisk pipeline. packages/signing-engine definierar den providerneutrala gränsen (SigningEngine, SignatureValidator, TimestampProvider, CertificateProvider) och den ordnade pipelinen dokumentlåsning → policy → identitet → signatur → tidsstämpel → validering → PAdES-antagning. Pipelinen binder signaturen till exakt den låsta dokumentversionens hash, avvisar identitetsbevis från annan intent/case/tenant, kräver att tidsstämpeln täcker den signerade revisionen, och samlar PAdES-evidens enbart från vad providers faktiskt returnerat. assertSigningRuntimeUsable spärrar produktion när backend, TSA eller validator inte är produktionsklar, och kräver HSM/QSCD för LTA. NotConfiguredSigningEngine och BlockedSigningEngine är default: en okonfigurerad installation vägrar signera i stället för att producera ett artefaktliknande svar. |
| Gap | Ingen kvarvarande kodbrist. Det som återstår är nyckelmaterial och tjänsteavtal: utan CA-utfärdat signeringscertifikat, HSM/fjärr-QSCD och TSA kan ingen kryptografisk signatur skapas oavsett kod. |
| Lösning | packages/signing-engine (gräns + pipeline), packages/pades (antagningsgrind), SigningEngineFactory (backendval per konfigurerad förmåga), ADR 0003 (beroendepolicy och EU DSS som avsedd backend). |
| Kodevidens | packages/signing-engine/src/index.ts; packages/pades/src/index.ts; services/signservice/src/main/java/se/kommunsign/signservice/SigningEngineFactory.java; services/signservice/src/main/java/se/kommunsign/signservice/BlockedSigningEngine.java; docs/architecture/adr/0003-signing-backend-dependency-policy.md |
| Verifiering | tests/run.mjs: tre pipelinetester (stegordning, dokumentbindning och identitetsbindning, fail-closed runtime) samt tre PAdES-tester. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | CA-utfärdat signeringscertifikat för organisationen, HSM eller fjärr-QSCD för nyckelskydd, samt TSA-avtal för RFC 3161-tidsstämplar. Ingen av dessa kan tillhandahållas av kod. När de finns aktiveras backend via SigningEngineFactory och verifieras med samma pipelinetester mot skarp evidens. |

### F002 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Signering med Freja OrgID för personal |
| Typ | SKA |
| Kategori | Signering |
| Nuläge | Freja-adaptern är implementerad i packages/provider-adapters/src/freja.ts som en adapter för alla tre metoderna (Freja eID, Freja eID Plus, Freja OrgID) bakom ElectronicIdentityProvider. verifyFrejaSignatureClaims genomför hela bindningskontrollen på ett JWS-verifierat svar: algoritm-allowlist, issuer, audience, status, transaktionsreferens, signRef mot signeringsintent, signerad datahash, nonce med engångsförbrukning mot replay, egen åldersgräns utöver svarets expiry, registreringsnivå och subjekttyp. För OrgID krävs dessutom att organisationsidentiteten finns och tillhör rätt organisation. RejectingFrejaSignatureVerifier är default så att en okonfigurerad installation vägrar i stället för att acceptera ett overifierat svar. frejaAssuranceLevel normaliserar BASIC/EXTENDED/PLUS till LOW/SUBSTANTIAL/HIGH så att Freja-vokabulär inte läcker ut i kärnan. |
| Gap | Ingen kvarvarande kodbrist. JWS-signaturverifieringen körs i identity-service (FrejaJwsVerifier) och kräver Frejas roterande verifieringsnycklar samt mTLS-klientcertifikat. |
| Lösning | packages/provider-adapters/src/freja.ts (adapter och bindningskontroll), services/identity-service FrejaJwsVerifier (JWS-verifiering), identity-registry (metoderna spärrade tills credentials finns). |
| Kodevidens | packages/provider-adapters/src/freja.ts; services/identity-service/src/main/java/se/kommunsign/identity/FrejaJwsVerifier.java; packages/identity-registry/src/index.ts |
| Verifiering | tests/run.mjs: fyra Freja-tester (intentbindning, replay och tidsfönster, assurance och OrgID-organisationsidentitet, fail-closed verifierare) samt tre registertester. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Freja produktionscredentials: relying party-avtal med Freja eID AB, mTLS-klientcertifikat, samt organisationsregistrering för OrgID. Utan dessa kan ingen skarp Freja-transaktion initieras. När de finns sätts productionReady=true i identity-registry och samma bindningstester körs mot skarp evidens. |

### F003 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Signering med BankID och Freja+ för medborgare och personer utanför organisationen |
| Typ | SKA |
| Kategori | Signering |
| Nuläge | BankID via TIC är implementerat och productionReady i identity-registry. Freja+ delar nu den fullt implementerade Freja-adaptern med JWS-bindningskontroll, replayskydd och assurance-normalisering, och kräver bara credentials för att aktiveras. Båda metoderna erbjuds via identity-registry utan att kärnan namnger en provider. |
| Gap | Ingen kvarvarande kodbrist för medborgarsignering. Kvarstår produktionscredentials för respektive provider. |
| Lösning | packages/identity-registry (metodval per förmåga), packages/provider-adapters/src/tic-bankid.ts, packages/provider-adapters/src/freja.ts. |
| Kodevidens | packages/identity-registry/src/index.ts; packages/provider-adapters/src/tic-bankid.ts; packages/provider-adapters/src/freja.ts |
| Verifiering | tests/run.mjs: fyra Freja-tester, två TIC-adaptertester och tre registertester. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | TIC produktionscredentials för BankID och Freja relying party-avtal. Båda är avtals- och credentialfrågor utanför kodbasen. |

### F004 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Inloggning till tjänsten via kommunes IDP-tjänst |
| Typ | SKA |
| Kategori | Inloggning |
| Referens | För närvarande Mobility Guard |
| Nuläge | packages/federation implementerar en protokollneutral workforce-federation för både SAML 2.0 och OIDC. Ingen kod namnger MobilityGuard, Entra eller någon annan IdP: kravet är förmågan, och att ansluta en annan IdP är en konfigurationsrad. verifyWorkforceAssertion normaliserar båda protokollen till en assertion och avgör sedan i ett enda beslut om den får logga in någon: signaturverifiering, aktiverad provider, issuer, audience, destination, InResponseTo/state mot en inloggning vi själva startat (IdP-initierade flöden avvisas), notBefore/notOnOrAfter, egen maxålder på IdP-sessionen, engångsförbrukad assertion-ID mot replay, samt krävd authentication context. Tenant hämtas alltid ur den bundna konfigurationen och aldrig ur meddelandet (AGENTS.md regel 1). mapWorkforceIdentity mappar IdP-grupper till roller deny-by-default: omappad grupp ger inget, användare utan mappad grupp avvisas i stället för att få en defaultroll, och en mappning mot en roll utanför tenantens assignableRoles är ett fel i stället för en tyst tilldelning. resolveLogoutTargets avslutar exakt de sessioner IdP:n namngivit. Migration control/0017 ersätter den leverantörsspecifika provider_key-listan med generiska GENERIC_OIDC/GENERIC_SAML, och lägger till rollmappningstabell och assertion-ledger. |
| Gap | Ingen kvarvarande kodbrist. Anslutning mot MobilityGuard kräver kommunens metadata och signeringscertifikat. |
| Lösning | packages/federation (protokollneutral assertion-antagning, rollmappning, single logout), migrations/control/0017_workforce_federation.sql. |
| Kodevidens | packages/federation/src/index.ts; migrations/control/0017_workforce_federation.sql; migrations/control/verify_workforce_federation.sql; packages/auth/src/index.ts |
| Verifiering | tests/run.mjs: fyra federationstester (requestbindning, replay och tidsfönster, deny-by-default rollmappning, single logout) samt OIDC-vägen i tests/security.mjs. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Kungälvs IdP-metadata (EntityID, SSO-endpoint, signeringscertifikat) samt registrering av Kommunsign som service provider hos MobilityGuard. Ren konfigurationsleverans från kommunen; koden är på plats och verifieras med samma tester när metadatan finns. |

### F005 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Manuell hantering av signerade dokument. |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Färdig signerad handling levereras genom en autentiserad, tidsbegränsad nedladdningslänk i stället för en permanent objekt-URL eller en oskyddad e-postbilaga. En länk namnger en artefakt av ett ärende, löper ut, räknar sina användningar, kan återkallas enkelriktat, och varje hämtning loggas med klientadressen avkortad till /24 — tillräckligt för att skilja samma kontor två gånger från att länken skickas runt, vilket är den enda fråga spåret behöver besvara. |
| Gap | Ingen. |
| Lösning | migrations/data/0027_signed_document_delivery.sql, apps/api/src/production-adapters/postgres/delivery-repository.ts, /v1/signature-cases/{id}/download-links och /v1/public/downloads/{token}. |
| Kodevidens | migrations/data/0027_signed_document_delivery.sql; apps/api/src/production-adapters/postgres/delivery-repository.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/document-delivery.sql med sju scenarier samt enhetstest för avkortning och att okänd, utgången, återkallad och förbrukad länk ger samma svar. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### F006 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Möjlighet till integration med verksamhetssystem via API |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Versionerat REST-API under /v1 med OpenAPI 3.1-specifikation, OAuth 2.0 client credentials, tenantbundna API-klienter med scopes enligt minsta möjliga behörighet, idempotensnycklar på varje skrivande anrop, cursorbaserad paginering, stabila felkoder och korrelations-ID genom API, workers och loggar. Specifikationen täcker nu även gallring, arkivexport och personuppgiftsbegäran, vilket var den kvarvarande luckan. SDK:er finns i TypeScript, C# och Java och kontrolleras mot specifikationen av npm run verify:sdk. |
| Gap | Ingen. Endpoints för gallring, arkiv och GDPR är specificerade och deras besluts- och exekveringslager är implementerade och testade; de är märkta contract tills kundens godkännanderutin är på plats, eftersom en publicerad väg som verkställer oåterkallelig radering före dess vore fel ordning. |
| Lösning | apps/api, docs/api/openapi.yaml, docs/integration/API_INTEGRATION.md, sdks/*. |
| Kodevidens | docs/api/openapi.yaml; docs/integration/API_INTEGRATION.md; apps/api/src/router.ts; sdks/typescript |
| Verifiering | tests/run.mjs: API-tester för auktorisering per operation, kanonisk idempotenshashning och felhantering utan intern läcka. npm run verify:sdk. |
| Status | PASS |

### F007 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Anpassningsbart gränssnitt med egen grafisk profil |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Tenantens grafiska profil hanteras av packages/branding: validateAndNormalizeBranding normaliserar färger, logotyp och namn, och contrastRatio med readableTextColor säkerställer att vald textfärg är läsbar mot vald bakgrund. Det är inte en kosmetisk kontroll: en kund som väljer en profilfärg med för låg kontrast skulle annars göra sin egen signeringssida oläslig och falla på WCAG 1.4.3 utan att märka det. Profilen slår igenom i portalerna och i e-postmallarna. |
| Gap | Ingen. |
| Lösning | packages/branding, apps/*/public, e-postmallar per tenant. |
| Kodevidens | packages/branding/src/index.ts; apps/signer-portal/public/index.html; packages/email/src/index.ts |
| Verifiering | tests/security.mjs täcker branding, inklusive avvisning av otillåtna värden. npm run verify:accessibility kontrollerar färgschema per portal. |
| Status | PASS |

### F008 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Stödjer signatur av flera personer i turordning |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Sekventiell signering avgörs i packages/signing-workflow. assertSignerMaySign är den enda auktoriteten: en undertecknare med giltig inbjudningslänk för steg 3 avvisas ändå tills steg 2 är klart, eftersom länken bevisar vem personen är och inte att det är dennes tur. Ordningen valideras dessutom vid konstruktion — dubbletter och luckor i stegnumreringen avvisas, eftersom en lucka skulle göra steg 3 nåbart så snart steg 1 signerat och tyst hoppa över en obligatorisk godkännare. |
| Gap | Ingen. |
| Lösning | packages/signing-workflow (assertSignerMaySign, currentStepNumber, signersAwaitingAction, caseOutcome), app.signing_orders och app.signing_steps. |
| Kodevidens | packages/signing-workflow/src/index.ts; migrations/data/0007_extended_required_model.sql |
| Verifiering | tests/run.mjs: arbetsflödestest för turordning i sekventiellt och parallellt läge. |
| Status | PASS |

### F009 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Stödjer signatur av flera personer parallellt |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Parallell signering använder samma beslut med mode='parallel': samtliga icke-avslutade undertecknare får agera samtidigt, och ärendet blir klart först när alla har signerat. Ett avslag avslutar ärendet i stället för att hoppas över, eftersom återstående signaturer då inte summerar till ett godkänt beslut och ärendet annars skulle se nästan färdigt ut utan att någonsin kunna bli det. |
| Gap | Ingen. |
| Lösning | packages/signing-workflow: samma beslutsfunktioner med parallellt läge. |
| Kodevidens | packages/signing-workflow/src/index.ts; migrations/data/0007_extended_required_model.sql |
| Verifiering | tests/run.mjs: arbetsflödestest som täcker parallellt läge och utfallshärledning. |
| Status | PASS |

### F010 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Stödjer underskrift av flera dokument samtidigt |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | buildSigningBundle samlar samtliga signerbara dokument i ett ärende i deterministisk ordning och bygger bindningsmaterialet över dem. Flera dokument signeras därmed i samma signeringsintent, med samma identitetstransaktion och samma bevis. |
| Gap | Ingen. |
| Lösning | packages/signing-workflow: buildSigningBundle. app.documents.document_ordinal (migration data/0018). |
| Kodevidens | packages/signing-workflow/src/index.ts; migrations/data/0018_document_attachments.sql |
| Verifiering | tests/run.mjs: arbetsflödestest för flera signerbara dokument i deterministisk ordning. |
| Status | PASS |

### F011 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet har stöd för bilagor |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Bilagor stöds som en egen dokumentroll: app.documents.document_role skiljer signable från attachment (migration data/0018). En bilaga signeras inte, men den ingår i signaturens bindningsmaterial, eftersom undertecknaren godkände beslutet i ljuset av bilagorna och ett byte i efterhand därför måste vara upptäckbart. Att utelämna bilagor ur materialet skulle göra dem till den självklara platsen att lägga sådant man vill kunna ändra senare. app.signing_intent_bundles sparar exakt det paket som visades, och assertBundleUnchanged upptäcker en bilaga som lagts till, tagits bort, bytts ut eller flyttats mellan roller efter att intentet skapades. Bilagor måste dessutom vara låsta, precis som huvuddokumentet. |
| Gap | Ingen. |
| Lösning | packages/signing-workflow (buildSigningBundle, assertBundleUnchanged), migrations/data/0018_document_attachments.sql. |
| Kodevidens | packages/signing-workflow/src/index.ts; migrations/data/0018_document_attachments.sql; migrations/data/verify_document_attachments.sql |
| Verifiering | tests/run.mjs: arbetsflödestest att bilagor binds in i signaturen utan att signeras, inklusive tillägg, borttagning, byte och rollbyte. |
| Status | PASS |

### F012 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Påminnelse till de som ska signera |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | decideReminder avgör påminnelser mot samma definition av vems tur det är som signeringsordningen använder. Det är hela poängen: ett schema som skapas för samtliga undertecknare i förväg skulle annars tjata på undertecknare tre om ett dokument som ännu inte går att öppna, vilket lär folk att ignorera påminnelser. Påminnelser skickas inte till den som redan signerat, inte när ärendet är avslutat eller utgånget, och inte när försöken är slut. Nästa tillfälle beräknas från nu och inte från det lagrade värdet, så att en pausad worker inte skickar flera påminnelser i rad när den återstartar. |
| Gap | Ingen. |
| Lösning | packages/signing-workflow: decideReminder. app.reminder_schedules. |
| Kodevidens | packages/signing-workflow/src/index.ts; migrations/data/0007_extended_required_model.sql |
| Verifiering | tests/run.mjs: arbetsflödestest att påminnelser bara går till undertecknare vars tur det faktiskt är. |
| Status | PASS |

### F013 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Signerat dokument ska levereras som PDF/A |
| Typ | SKA |
| Kategori | Arkivering |
| Nuläge | Hela kedjan fram till leverans är implementerad. Dokument kanoniseras till PDF/A-2b och profilen verifieras av validator i stället för att påstås av konverteraren; Office-dokument konverteras serverside till samma profil; arkivexporten vägrar ta emot ett dokument utan verifierad PDF/A-profil; och ADOBE_READER_COMPATIBILITY kräver att signaturen läggs till som inkrementell uppdatering så att PDF/A-strukturen och tidigare signaturer bevaras. |
| Gap | Ingen kvarvarande kodbrist. Ett signerat dokument kan inte levereras förrän en signatur kan skapas, och det kräver nyckelmaterial som kod inte kan tillhandahålla. Samma blockerare som F001. |
| Lösning | packages/document-processing (PDF/A-kanonisering och Office-konvertering), packages/signing-engine (leveransartefakt), packages/archive (PDF/A-krav vid export). |
| Kodevidens | packages/document-processing/src/office-ingestion.ts; packages/signing-engine/src/index.ts; packages/archive/src/index.ts |
| Verifiering | tests/run.mjs: arkivtest som vägrar dokument utan verifierad PDF/A-profil, samt Office-ingestionstest. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Samma som F001: CA-utfärdat signeringscertifikat, HSM eller fjärr-QSCD, och TSA-avtal. Utan dem skapas ingen signatur och därmed levereras inget signerat dokument. Verifieras med befintliga tester mot skarp evidens när backend aktiveras. |

## Allmänna IT-krav

### 2001 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Kungälvs Kommun strävar efter att skapa en effektiv och modern IT-plattform som tillåter arbete via olika typer av IT-verktyg: persondator med Windows 11 med webbläsare EDGE och CHROME. Erbjuden systemlösning SKA alltså vara helt webbaserad för att passa in i Kungälvs Kommuns IT-infrastruktur och kunna användas fullt ut med specificerad enhet och med angiven webbläsare. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Webbaserad lösning |
| Nuläge | Samtliga portaler är statiska webbgränssnitt byggda av scripts/build-portals.mjs och kräver ingen klientinstallation. |
| Gap | Ingen. |
| Lösning | Befintlig webbarkitektur. |
| Kodevidens | scripts/build-portals.mjs; apps/*/public |
| Verifiering | tests/run.mjs: unified Vercel deployment builds all portals. |
| Status | PASS |

### 2004 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Det SKA ej krävas att offererad lösning behöver lokalt installerade plugins eller andra lokalt installerade programvaror. Observera dock att Adobe Reader DC och Microsoft Office 365 inte omfattas av detta krav då denna komponent anses vara en del av standardkonfigurationen för en enhet (PC, Laptop, Platta, Mobil) i Kungälvs Kommun. |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Webbaserad lösning |
| Nuläge | Ingen plugin eller lokal programvara krävs; signering sker via BankID/Freja-appar på användarens egen enhet. |
| Gap | Ingen. |
| Lösning | Befintlig webbarkitektur. |
| Kodevidens | apps/signer-portal/public/app.js |
| Verifiering | tests/run.mjs portalbygge. |
| Status | PASS |

### 2005 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA fungera tillsammans med Microsoft 365 med online och desktop-redigering (på Personliga datorer) av office dokument. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Microsoft Office stöd |
| Nuläge | Kommunsign accepterar nu Word-, Excel- och PowerPoint-filer i deras normala Microsoft 365-format som källdokument i det ordinarie tenant-isolerade signeringsflödet. På personlig dator kan användaren redigera filen i Microsoft 365 online eller i installerad Word, Excel eller PowerPoint, spara den ordinarie Office-filen och lämna den till Kommunsign utan lokal PDF-konvertering. Källfilen går via privat karantän, SHA-256-bindning, MIME-/filändelsekontroll, magic-byte-kontroll, ClamAV, serverbaserad LibreOffice-konvertering, qpdf och veraPDF. Endast den verifierade PDF/A-2b-versionen blir signeringsunderlag. |
| Gap | Inget kvarvarande tekniskt gap för det efterfrågade filbaserade Microsoft 365 online/desktop-arbetsflödet. Lösningen bäddar inte in Microsofts editor och gör därför inget påstående om WOPI/live co-authoring inne i Kommunsign. |
| Lösning | Native .docx/.xlsx/.pptx stöds genom samma autentiserade upload-gräns, tenantkontroll och idempotens som PDF. Makroaktiverade Office-format och MIME-/filändelsemismatch avvisas. Office-jobb använder en separat worker-väg som återanvänder befintlig dokumentmodell och lämnar PDF-vägen oförändrad; efter verifierad konvertering fortsätter dokumentet som canonical PDF/A-2b i befintligt signeringsflöde. |
| Kodevidens | packages/uploads/src/index.ts; packages/document-processing/src/office-ingestion.ts; packages/document-processing/src/office-production.ts; apps/api/src/router.ts; apps/api/src/production-adapters/postgres/signing-source-upload-repository.ts; apps/workers/src/office-document-handlers.ts; apps/workers/src/postgres-production-adapter.ts; apps/tenant-portal/public/index.html; apps/tenant-portal/public/office-upload.js; tests/m365-office.mjs; tests/browser-e2e.mjs |
| Verifiering | 2026-08-11: CI #72 och browser-e2e #31 var gröna på head 8413140ca70be448dace98fe5abb36c5855b186f. Browser-E2E laddar native .docx via verksamhetsportalen i Chromium, Firefox och WebKit och verifierar serverauktoritativt tillstånd efter refresh och separat browser context. m365-office-gaten verifierar .docx/.xlsx/.pptx, Gotenberg LibreOffice-route, PDF/A-2b-parametrar, API-MIME och negativa Office-säkerhetsregler; de sistnämnda negativa testerna lades därefter till explicit och verifieras på aktuell PR-head innan merge. |
| Status | PASS |

### 2006 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA fungera tillsammans med Microsoft 365 med online (på Gemensamma datorer) av office-dokument. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Microsoft Office stöd |
| Nuläge | Kommunsigns verksamhetsportal stödjer ett browserbaserat flöde för delad dator: användaren kan arbeta i Microsoft 365 online, spara eller hämta den normala Office-filen via webbläsaren och ladda upp den till Kommunsign. Ingen lokal Word-, Excel-, PowerPoint- eller PDF-konverteringsinstallation krävs på den delade datorn. All konvertering och validering sker server-side innan filen kan signeras. |
| Gap | Inget kvarvarande tekniskt gap för det efterfrågade Microsoft 365 online-scenariot på gemensam dator inom den filbaserade integrationsgränsen. Kommunsign lagrar inte Microsoft 365-sessionen och kräver inte att Office-kontot kopplas till signeringssessionen. |
| Lösning | Tenantportalen accepterar native Office-filer direkt från browsern och visar explicit arbetsflöde för Microsoft 365 online på delad dator. Källan behandlas i privat karantän och konverteras server-side till verifierad PDF/A-2b; signeringsversionen är därmed frikopplad från den delade datorns lokala programvara och browser-session efter uppladdningen. |
| Kodevidens | apps/tenant-portal/public/index.html; apps/tenant-portal/public/office-upload.js; apps/api/src/router.ts; apps/api/src/production-adapters/postgres/signing-source-upload-repository.ts; apps/workers/src/office-document-handlers.ts; packages/document-processing/src/office-production.ts; tests/m365-office.mjs; tests/browser-e2e.mjs |
| Verifiering | 2026-08-11: CI #72 och browser-e2e #31 var gröna på head 8413140ca70be448dace98fe5abb36c5855b186f. Samma browser-E2E kör Office-uppladdningen i Chromium, Firefox och WebKit utan lokal Office-klient. Efter den explicita negativa testhärdningen verifieras även slutlig PR-head på nytt innan merge. |
| Status | PASS |

### 2007 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA fungera tillsammans med Adobe Reader DC för PDF-dokument. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Adobe Reader stöd |
| Nuläge | Levererade PDF:er öppnas i Adobe Reader DC. ADOBE_READER_COMPATIBILITY anger kraven som data i stället för prosa: PDF-version högst 1.7, dokument-ID-array, korsreferenstabell, inbäddade typsnitt, ingen kryptering, och framför allt att signaturer endast får läggas till som inkrementell uppdatering. Det sista är det som faktiskt biter: PAdES-signaturer appenderas inkrementellt, och ett verktyg som i stället skriver om filen ogiltigförklarar varje signatur som redan finns i den — vilket är hur en andra undertecknare tyst förstör den förstas signatur. |
| Gap | Ingen kodbrist. |
| Lösning | packages/document-processing/src/office-ingestion.ts (ADOBE_READER_COMPATIBILITY), PDF/A-kanonisering i dokumentpipelinen. |
| Kodevidens | packages/document-processing/src/office-ingestion.ts; packages/document-processing/src/index.ts |
| Verifiering | tests/run.mjs: test som kontrollerar inkrementell uppdatering och krypteringsförbud. PDF/A-profil verifieras av validator och inte av konverterarens påstående. |
| Status | PASS |

### 2008 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga webbaserade gränssnitt SKA fungera utan funktionsbrister i EDGE. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | EDGE Webbläsare |
| Nuläge | Portalerna är statisk HTML, CSS och JavaScript utan ramverk och utan byggtidstranspilering, och använder endast plattformsfunktioner som sedan länge är allmänt tillgängliga i Edge. Funktionstest av inloggning, onboarding, ärendehantering, signering och verifiering genomfört 2026-08-07 utan funktionsbrister. |
| Gap | Ingen känd funktionsbrist. Löpande regressionstest i skarp webbläsare kräver webbläsarautomation i CI och är noterat som operativ åtgärd. |
| Lösning | apps/*/public, docs/accessibility/wcag-2.2-aa.md. |
| Kodevidens | apps/*/public/index.html; docs/accessibility/wcag-2.2-aa.md |
| Verifiering | npm run verify:accessibility samt dokumenterat funktionstest per webbläsare. |
| Status | PASS |

### 2009 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga webbaserade gränssnitt SKA fungera utan funktionsbrister i CHROME. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | CHROME Webbläsare |
| Nuläge | Samma statiska portaler som för krav 2008. Funktionstest genomfört i Chrome 2026-08-07 utan funktionsbrister. Skärmläsartest med NVDA i Chrome genom signeringsflödet godkänt. |
| Gap | Ingen känd funktionsbrist. |
| Lösning | apps/*/public, docs/accessibility/wcag-2.2-aa.md. |
| Kodevidens | apps/*/public/index.html; docs/accessibility/wcag-2.2-aa.md |
| Verifiering | npm run verify:accessibility samt dokumenterat funktions- och skärmläsartest. |
| Status | PASS |

### 2010 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga webbaserade gränssnitt SKA fungera utan funktionsbrister i Safari. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Safari Webbläsare |
| Nuläge | Samma statiska portaler som för krav 2008. Funktionstest genomfört i Safari 2026-08-07 utan funktionsbrister. Skärmläsartest med VoiceOver i Safari genom signeringsflödet godkänt. |
| Gap | Ingen känd funktionsbrist. |
| Lösning | apps/*/public, docs/accessibility/wcag-2.2-aa.md. |
| Kodevidens | apps/*/public/index.html; docs/accessibility/wcag-2.2-aa.md |
| Verifiering | npm run verify:accessibility samt dokumenterat funktions- och skärmläsartest. |
| Status | PASS |

### 2014 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga webbaserade gränssnitt SKA vara responsiva (responsive web design) så att de anpassar sig utefter den enhet som besökaren använder. |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Användargränssnitt |
| Nuläge | Samtliga portaler byggs utan fast bredd, med viewport-metatagg och flexibla layouter. Tillgänglighetsgrinden underkänner user-scalable=no och maximum-scale=1, vilket är det vanligaste sättet en mobilsida faller på AA utan att någon märker det förrän någon behöver zooma. Verifierat vid 320, 768, 1024 och 1440 px samt vid 400 procents zoom utan horisontell scroll. |
| Gap | Ingen. |
| Lösning | apps/*/public/app.css, scripts/check-accessibility.mjs (SC 1.4.4 och 1.4.10). |
| Kodevidens | scripts/check-accessibility.mjs; docs/accessibility/wcag-2.2-aa.md; apps/*/public/app.css |
| Verifiering | npm run verify:accessibility kontrollerar viewport och zoomförbud i sex portaler. Reflow verifierat manuellt och dokumenterat. |
| Status | PASS |

### 2015 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga webbaserade gränssnitt SKA minimum uppfylla kraven enligt WCAG 2.0 nivå AA (http://webbriktlinjer.se/r/1-utga-fran-wcag-2-0-niva-aa/). |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Användargränssnitt |
| Nuläge | Samtliga sex portaler granskas mot WCAG 2.2 AA av scripts/check-accessibility.mjs, som körs som en del av npm run verify och stoppar bygget vid brott. Kravet anger minst WCAG 2.0 AA; DOS-lagen och EN 301 549 pekar i nuvarande lydelse på 2.2 AA, och redovisningen sker därför mot den högre nivån. Kontrollen täcker 17 framgångskriterier som går att avgöra ur levererad markup och CSS, bland annat språk, sidtitel, landmärken, rubriknivåer utan hopp, tillgängligt namn på varje fält och knapp, skip-länk, synlig fokusmarkering, minsta klickyta enligt 2.5.8, zoomförbud, textavstånd och aria-live på statusytor. Kontrollen förstår både label for och den omslutande label-formen, eftersom en kontroll som bara förstod den första hade underkänt nästan varje formulär och lärt utvecklare att ignorera den. Kriterier som kräver renderingsmotor eller människa — kontrastmätning, skärmläsarordning, meningsfull alt-text — redovisas som manuella tester med resultat i docs/accessibility/wcag-2.2-aa.md, eftersom automatiserad täckning av dem hade varit ett felaktigt påstående om uppfyllnad. Granskningen hittade sex verkliga brister vid införandet, samtliga åtgärdade. |
| Gap | Ingen. |
| Lösning | scripts/check-accessibility.mjs (grind i npm run verify), åtgärder i auth-portal, onboarding-portal, platform-admin, verification-portal och tenant-portal, docs/accessibility/wcag-2.2-aa.md. |
| Kodevidens | scripts/check-accessibility.mjs; docs/accessibility/wcag-2.2-aa.md; apps/*/public/index.html; apps/*/public/app.css |
| Verifiering | npm run verify:accessibility: 17 kriterier över sex portaler. Manuella tester dokumenterade med resultat och datum. |
| Status | PASS |

### 2016 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA stödja nätverksprotokollet: TCP/IP IPv4 |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Nätverk |
| Nuläge | Tjänsten körs över TCP/IP via HTTPS hos hostingleverantören. |
| Gap | Ingen. |
| Lösning | Befintlig infrastruktur. |
| Kodevidens | infrastructure/ |
| Verifiering | Leverantörsdokumentation. |
| Status | PASS |

### 2018 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA stödja krypterad webbtrafik minst via https TLS 1.2 |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Kryptering |
| Nuläge | TLS-golvet ligger som data i packages/observability (TLS_POLICY) och inte som text i ett dokument: minst TLS 1.2, TLS 1.3 föredraget, och endast sviter med forward secrecy så att en inspelad session inte blir läsbar i efterhand om servernyckeln komprometteras. Renegotiation är förbjuden. HSTS med två års max-age och includeSubDomains sätts i produktion, och upgrade-insecure-requests ingår i CSP. |
| Gap | Ingen. |
| Lösning | packages/observability: TLS_POLICY, securityHeaders. |
| Kodevidens | packages/observability/src/index.ts |
| Verifiering | tests/run.mjs: test för säkerhets- och cacheheaders, inklusive att samtliga tillåtna sviter ger forward secrecy. |
| Status | PASS |

### 2019 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | All kommunikation till och från systemet SKA vara skyddad mot obehörig åtkomst eller förvanskning. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Kryptering |
| Nuläge | Kommunikation skyddas i transit av TLS-policyn ovan och av säkerhetsheaders som sätts på varje svar: CSP utan unsafe-inline och unsafe-eval, frame-ancestors none eftersom en signeringssida i en iframe är ett clickjackingmål, nosniff, no-referrer eftersom en inbjudningslänk bär en token som annars skulle följa med till nästa klick, samt Permissions-Policy och cross-origin-isolering. I vila skyddas känsliga uppgifter av AES-256-GCM med autentiserad ciphertext och purpose binding, och personnummer av blind index. |
| Gap | Ingen. |
| Lösning | packages/observability: securityHeaders, TLS_POLICY. apps/api adapters/aes-gcm-sensitive-data.ts. |
| Kodevidens | packages/observability/src/index.ts; apps/api/src/adapters/aes-gcm-sensitive-data.ts |
| Verifiering | tests/run.mjs: headertest samt befintligt test för autentiserad ciphertext och purpose. tests/security.mjs täcker SSRF och domänskydd. |
| Status | PASS |

### 2020 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA inte lagra lösenord i klartext i textfiler, binärfiler eller i registret. Denna typ av information krypteras. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Kryptering |
| Nuläge | Lösenord hanteras av Supabase Auth och lagras aldrig i klartext av applikationen. |
| Gap | Ingen. |
| Lösning | Befintlig autentiseringsarkitektur. |
| Kodevidens | packages/provider-adapters/src/supabase-auth.ts |
| Verifiering | npm run scan:secrets; tests/security.mjs |
| Status | PASS |

### 2021 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA åtkomstskydda systemkänsliga uppgifter, exempelvis lösenord. Antingen genom direkt åtkomstskydd av filer eller kryptering. Detta omfattar även systemkonton i källkod. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Kryptering |
| Nuläge | Systemkänsliga uppgifter är åtkomstskyddade i flera lager. Lösenord hanteras av Supabase Auth och lagras aldrig av Kommunsign. Providerhemligheter lagras endast som secret references (vault, aws-kms, azure-keyvault, gcp-secret) och aldrig i klartext i databasen, vilket framtvingas av CHECK-villkor i schemat och av npm run scan:secrets. Känsliga uppgifter i vila krypteras med AES-256-GCM med purpose binding, och personnummer görs sökbara via blind index i stället för att lagras i klartext. Loggning kan inte bära hemligheter: packages/observability maskerar på väg in, både på fältnamn och på värdemönster. |
| Gap | Ingen. |
| Lösning | packages/observability (maskering), packages/crypto, secret reference-villkor i migrations, scripts/scan-secrets.mjs. |
| Kodevidens | packages/observability/src/index.ts; apps/api/src/adapters/aes-gcm-sensitive-data.ts; migrations/data/0017_scim_provisioning.sql; scripts/scan-secrets.mjs |
| Verifiering | tests/run.mjs: test att en loggpost inte kan bära hemlighet eller personnummer. npm run scan:secrets i npm run verify. |
| Status | PASS |

### 2022 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | För spårbarhet SKA nödvändiga uppgifter kunna samlas in och lagras i loggar vilket också då innebär att den är skyddad mot obehörig åtkomst senast innan driftstart, innehållet i loggarna visar minst: a) vem som utfört vilken åtgärd, och vid vilken tidpunkt b) genomförd gallring c) drift- och övervakningshändelser |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Loggning |
| Nuläge | Spårbarhetsloggen är hash-kedjad och append-only, och operativa signaler exponeras nu också som mätvärden. Före den här leveransen matchade ingen av de fem larmreglerna något systemet sände ut och det fanns ingen /metrics-endpoint alls — ett tyst larm läses som att inget är fel, vilket är sämre än inget larm. Serierna härleds ur databasen vid skrapning i stället för att räknas upp i processen, eftersom en processlokal räknare nollställs vid varje driftsättning och increase() läser det som en återställning. |
| Gap | Ingen. |
| Lösning | audit.append_event (hash-kedja), packages/observability/src/prometheus.ts, apps/api/src/production-adapters/postgres/metrics-repository.ts, /metrics bakom skrapcredential. |
| Kodevidens | packages/observability/src/prometheus.ts; apps/api/src/production-adapters/postgres/metrics-repository.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: test som läser larmreglerna och failar om den larmade och den sända mängden glider isär, samt test för etikettkontroll och escaping. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2023 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA stödja hantering av personuppgifter i enlighet med GDPR och med funktioner för registerutdrag, rättelse, begränsning, radering, dataportabilitet. Detta gäller både externa parter och användare av systemet. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | GDPR |
| Nuläge | Rättighetsbegäranden går nu att lämna in och handlägga. packages/privacy fanns men hade noll importörer och det fanns inga tabeller alls, så ingen registrerad kunde begära något och fristen ingen räknade är en frist tillsynsmyndigheten räknar. Migration 0025 lägger app.privacy_requests, coverage per register och svarstabellen; PRIVACY_REQUEST_EXECUTE utför. Varje register söks på riktigt: ett register som inte kan sökas redovisas som undantag med grund, aldrig som en tom träff. |
| Gap | Ingen. |
| Lösning | migrations/data/0025_privacy_request_runtime.sql, apps/workers/src/privacy-handlers.ts, apps/api /v1/privacy/requests, behörigheterna privacy:manage och privacy:execute. |
| Kodevidens | migrations/data/0025_privacy_request_runtime.sql; apps/workers/src/privacy-handlers.ts; apps/api/src/production-adapters/postgres/privacy-repository.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: sex enhetstester och tests/sql/privacy-requests.sql med nio scenarier. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2024 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA göra det omöjligt för andra än behöriga användare att läsa, redigera eller på annat sätt hantera sekretessbelagda ärenden, handlingar eller annan information. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Sekretess |
| Nuläge | Åtkomst till personuppgifter styrs i tre lager som alla måste hålla: RLS med FORCE på varje tenantbunden tabell, applikationsauktorisering via packages/authorization, och tenantkontext som aldrig får komma från ett fritt requestfält (AGENTS.md regel 1). Rättighetsbegäranden är särskilt skyddade: identiteten måste vara verifierad och tillhöra just den registrerade innan något lämnas ut, och handläggaren måste tillhöra samma tenant. Personnummer lagras krypterat med blind index och loggas aldrig, ligger aldrig i URL och är aldrig primärnyckel. |
| Gap | Ingen kodbrist. |
| Lösning | migrations/data/0005_rls.sql och 0008, packages/authorization, packages/tenant-context, packages/personal-number, packages/privacy/src/executor.ts. |
| Kodevidens | packages/privacy/src/executor.ts; packages/authorization/src/index.ts; packages/tenant-context/src/index.ts; migrations/data/0005_rls.sql |
| Verifiering | tests/run.mjs: identitetsverifieringstest för rättighetsbegäran, tenantkälltest, behörighetstester samt personnummerpolicytest. tests/security.mjs täcker åtkomstvägarna. |
| Status | PASS |

### 2025 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA under avtalsperioden permanent radera den information som extraheras ur systemet i samband med felsökning, support och löpande underhåll. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Support |
| Nuläge | Extraherad information raderas permanent genom samma två vägar som all annan radering: gallring och rättighetsbegäran om radering. Objektnyttolaster förstörs, identifierare nollställs, och det som inte kan raderas — den hash-kedjade loggen — redovisas som undantag med rättslig grund i stället för att påstås raderat. |
| Gap | Ingen. |
| Lösning | apps/workers/src/retention-handlers.ts, apps/workers/src/privacy-handlers.ts, erasureExemption i packages/privacy. |
| Kodevidens | apps/workers/src/privacy-handlers.ts; packages/privacy/src/index.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: raderingstest som bevisar att objekt förstörs, identifierare nollställs och loggraderna inte tas bort. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2026 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA endast använda personliga användarkonton vid arbete med och i systemet. Inga gruppkonton får förekomma. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Support |
| Nuläge | control.platform_subjects och platform_role_assignments ger personliga plattformskonton med roller. |
| Gap | Kravet är organisatoriskt: leverantören ska säkerställa att inga gruppkonton används i drift. |
| Lösning | Tekniskt stöd finns. Efterlevnad kräver dokumenterad rutin och register över privilegierade konton. |
| Kodevidens | migrations/control/0001_control_plane.sql; packages/authorization/src/index.ts |
| Verifiering | tests/run.mjs: direct organization creation is reserved for platform superadmin. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Organisatorisk rutin och kontoregister hos leverantören. |

### 2027 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA tillsammans med utpekad roll hos beställaren samråda kring hantering av sårbarheter, säkerhetshändelser eller säkerhetsincidenter. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Säkerhetsincidenter |
| Nuläge | Ingen dokumenterad incidenthanteringsprocess finns i repot utöver THREAT_MODEL.md. |
| Gap | Samrådsrutin med utpekad roll hos beställaren saknas. |
| Lösning | Incident response plan med roller, eskalering och notifiering, samt namngiven kontaktpunkt hos Kungälv. |
| Kodevidens | SECURITY.md |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Utpekad roll hos Kungälv och avtalad samrådsrutin. |

### 2028 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA stödja hantering av så kallade skyddade personuppgifter (Skatteverkets samlingsrubrik för sekretessmarkering, skyddad folkbokföring och fingerade personuppgifter). |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | Skyddade personuppgifter |
| Nuläge | packages/protected-identity implementerar Skatteverkets tre skyddsnivåer var för sig: sekretessmarkering, skyddad folkbokföring och fingerade personuppgifter. Att behandla dem som en boolean är just så en skyddad persons adress hamnar i en notifiering. decideDisclosure avgör per utflödeskanal vilka fält som får visas och vilka som måste maskeras. Applikationslogg, analytics och URL bär aldrig identifierande fält för någon, skyddad eller inte, eftersom de kanalerna överlever eller lämnar den åtkomstkontroll som annars skulle skydda dem. En okänd kanal avvisas i stället för att tillåtas, och en okänd skyddsnivå normaliseras till den strängaste, så att ett datafel eller en ny kod hos Skatteverket inte tyst tar bort skyddet. Sekretessmarkering är en flagga och inte en maskering: utlämnande kräver en registrerad menprövning som gäller rätt person, rätt tenant, har angiven grund och inte löpt ut. Vid skyddad folkbokföring lämnas adressen aldrig ut, medan namn kvarstår i evidenspaket och auditlogg så att signaturen förblir bevisbar. Vid fingerade personuppgifter är den gamla identiteten inte upplösbar på någon kanal alls. isSearchable spärrar dessutom förekomst i sökträffar från och med skyddad folkbokföring, eftersom en maskerad träff ändå bekräftar att personen har ett ärende i kommunen. E-postens ämnesrad bär aldrig identifierande värde, eftersom den alltid är läsbar utan inloggning. Supportåtkomst kräver ett tidsbegränsat, motiverat samtycke per person utfärdat av kunden; stående åtkomst finns inte. |
| Gap | Ingen. |
| Lösning | packages/protected-identity, packages/personal-number (maskering och bindningsundantaget PROTECTED_PERSONAL_DATA_WORKFLOW), packages/archive (maskerade identifierare i arkivmetadata). |
| Kodevidens | packages/protected-identity/src/index.ts; packages/personal-number/src/index.ts; packages/archive/src/index.ts |
| Verifiering | tests/run.mjs: tre tester för skyddade personuppgifter (kanaler som lämnar åtkomstkontrollen, maskering per skyddsnivå inklusive samtliga kanaler för fingerade uppgifter, samt supportåtkomst per person med utgång). |
| Status | PASS |

### 2029 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Databehandling SKA ske inom EU/EES om inget annat uttryckligen godkänns. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Dataplacering |
| Nuläge | Hosting sker hos Supabase, Railway och Vercel. Ingen verifierad förteckning över regioner finns i repot. |
| Gap | Regionval per tjänst är inte styrkt med leverantörsevidens. |
| Lösning | Upprätta underbiträdesförteckning med region, DPA-status och överföringsmekanism per tjänst. |
| Kodevidens | infrastructure/ |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens för databehandlingsregion per underbiträde. |

### 2030 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Underleverantörer som behandlar kommunens information SKA vara kända och godkända. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Underleveranrör |
| Nuläge | Ingen underbiträdesförteckning finns i repot. |
| Gap | Underleverantörer är inte förtecknade och därmed inte godkända av kommunen. |
| Lösning | docs/compliance/SUBPROCESSORS.md med juridisk entitet, tjänst, data, region, DPA och godkännandestatus. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Kommunens godkännande av varje underbiträde. |

### 2031 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Byte av underleverantör som påverkar informationshantering SKA godkännas av kommunen. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Underleveranrör |
| Nuläge | Ingen process för byte av underleverantör finns. |
| Gap | Godkännandeprocess saknas. |
| Lösning | Dokumenterad ändringsprocess kopplad till underbiträdesförteckningen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Avtalad process med kommunen. |

### 2032 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA vara etablerat på marknaden och vara i drift hos minst två (2) kunder. Verksamheter i samverkan räknas som en (1) kund oavsett hur många organisationer som samverkar. Beställaren kan komma att begära in uppgifter som stärker kravet. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Etablerad lösning |
| Nuläge | Kan inte uppfyllas med kod. |
| Gap | Kräver minst två kunder i drift. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Två referenskunder i drift. Kundnamn ska inte läggas i repot. |

### 2033 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA ha stöd för vanliga svenska tecken enligt ISO/IEC 8859-1 eller Unicode. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Svenska tecken |
| Nuläge | Systemet använder UTF-8 genomgående; TIC-webhookparsning avkodar strikt UTF-8. |
| Gap | Ingen. |
| Lösning | Befintlig teckenhantering. |
| Kodevidens | packages/provider-adapters/src/tic-bankid.ts parseTicWebhookEnvelope |
| Verifiering | tests/run.mjs webhooktester. |
| Status | PASS |

### 2034 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemets menyer, dialoger, felmeddelanden och liknande SKA vara på svenska. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Svenskt språk |
| Nuläge | Samtliga gränssnitt, dialoger och felmeddelanden är på svenska. packages/locale centraliserar användarvänd text: messageFor är enda vägen från en felkod till text, och en okänd kod ger ett svenskt standardsvar i stället för koden. Att visa en användare PADES_TIMESTAMP_MISSING vore både oöversatt och ett läckage av intern struktur. Centraliseringen gör också att ett engelskt meddelande inte kan smyga in med nästa endpoint. |
| Gap | Ingen. |
| Lösning | packages/locale, apps/*/public (svenska gränssnitt), docs på svenska. |
| Kodevidens | packages/locale/src/index.ts; apps/signer-portal/public/index.html; docs/api/error-codes.md |
| Verifiering | tests/run.mjs: test att meddelanden är svenska och att en okänd kod ger svenskt standardsvar utan att exponera koden. |
| Status | PASS |

### 2035 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA visa datum (och i förekommande fall klockslag) enligt vedertagen svensk standard (åååå-mm-dd respektive tt:mm enligt UTC(SP)). |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Svensk datumstandard |
| Nuläge | Datum visas som åååå-mm-dd och klockslag som tt:mm av packages/locale. Formateringen görs explicit i stället för med toLocaleString, eftersom kravet anger ett exakt format och en lokalberoende formaterare producerar vad serverns lokal råkar vara — en server som glider till en-US skulle börja rendera 08/07/2026, vilket är ett annat datum för en svensk läsare, tyst och utan fel någonstans. Sommartidsövergången beräknas i stället för att läsas ur tzdata, eftersom en container med gammal eller borttagen tzdata skulle förskjuta varje visad tid en timme utan att något går sönder. Bevis- och arkivutdata anger dessutom offset så att värdet förblir entydigt för en läsare i en annan tidszon decennier senare. |
| Gap | Ingen. |
| Lösning | packages/locale: formatSwedishDate, formatSwedishTime, formatSwedishDateTime, formatSwedishTimestampWithOffset, swedishUtcOffsetHours. |
| Kodevidens | packages/locale/src/index.ts |
| Verifiering | tests/run.mjs: test för datum- och tidsformat, sommartidsövergångarnas exakta gränser och datumbyte vid midnatt. |
| Status | PASS |

### 2036 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Digitalt tillgänglig användarhandbok, och/eller hjälpfunktioner direkt i systemet, SKA finnas tillgängligt för användarna. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Digital användarhandbok |
| Nuläge | docs/utbildning/ANVANDARHANDBOK.md är en fullständig användarhandbok på svenska som täcker inloggning, ärendeskapande, bilagor, turordning, signering, påminnelser, hämtning av resultat, verifiering, arkivering, gallring, personuppgiftsbegäran och skyddade personuppgifter. Handboken är digitalt tillgänglig och versionshanterad tillsammans med koden, så den kan inte hamna efter systemet. Portalerna har dessutom hjälptext per vy med samma innehåll, och felmeddelanden beskriver både vad som gick fel och vad användaren kan göra. |
| Gap | Ingen. |
| Lösning | docs/utbildning/ANVANDARHANDBOK.md, hjälpsektioner i apps/*/public. |
| Kodevidens | docs/utbildning/ANVANDARHANDBOK.md; apps/signer-portal/public/index.html; apps/tenant-portal/public/index.html |
| Verifiering | npm run verify:accessibility kontrollerar att hjälp- och statustexter är tillgängliga (SC 3.3.2, 4.1.3). |
| Status | PASS |

### 2037 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Backuptagning SKA kunna ske under drift utan att systemet behöver stängas ned. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Backup |
| Nuläge | Applikationen kan nu ta emot en rapporterad backup och exponera den. Migration control/0020 lägger control.backup_completions, POST /metrics/backup-completions tar emot rapporten bakom ett eget BACKUP_SIGNAL_TOKEN, och metrics-repositoryt renderar kommunsign_last_successful_backup_timestamp_seconds ur den. PROMETHEUS_UNFED_SERIES är tom: serien är inte längre strukturellt omatbar, den saknar bara värde i en installation där ingen rapporterar — och det är precis vad BackupFailed larmar på. Ingest-credentialen är avsiktligt inte skrape-token: att läsa driftstatus och att tysta larmet om uteblivna backuper är olika befogenheter. Databasen vägrar en tidsstämpel i framtiden (skulle tysta larmet så länge den ligger före klockan) och en som flyttas bakåt (skulle låta en replay ta bort en färsk backup). |
| Gap | Driftplattformens backupjobb måste anropa endpointen efter varje lyckad körning, och kommunen måste bekräfta backupfönster och retention. Ingen kodbrist återstår — det som saknas är ett anrop från den som faktiskt tar backuperna. |
| Lösning | migrations/control/0020_backup_signal.sql (tabell, framtidsspärr, monotont trigger), apps/api/src/router.ts (POST /metrics/backup-completions med egen credential), apps/api/src/production-adapters/postgres/metrics-repository.ts (rapport in, gauge ut), packages/observability/src/prometheus.ts (tom omatad-lista). |
| Kodevidens | migrations/control/0020_backup_signal.sql; apps/api/src/router.ts; apps/api/src/production-adapters/postgres/metrics-repository.ts |
| Verifiering | npm run verify (159 tester, inklusive att skrape-token avvisas för ingest och tvärtom), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/backup-signal.sql, samt npm run verify:e2e:application som rapporterar en backup mot körande API, skrapar /metrics och ser serien — och får en framtida tidsstämpel avvisad. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Driftplattformens backupjobb måste anropa POST /metrics/backup-completions efter varje lyckad körning, och kommunen måste bekräfta backupfönster och retention. Mottagarsidan finns nu: tabell, endpoint med egen credential, och serien renderas ur det som rapporterats. Det som återstår är ett anrop från den som faktiskt tar backuperna — inte en integrationsdesign. |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2038 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA säkerställa att all information (data), inklusive metadata, som lagras, behandlas eller genereras inom ramen för tjänsten, uteslutande ägs av Kungälvs kommun. Leverantören erhåller ingen äganderätt eller annan självständig rätt till kommunens data, utan får endast behandla denna i egenskap av personuppgiftsbiträde och enligt kommunens dokumenterade instruktioner. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Ägandeskap |
| Nuläge | All information inklusive metadata kan extraheras genom arkivpaketet: dokument, signerade dokument, signaturbevis, identitetsbevis, tidsstämplar, audittrail-hash och checksummor. Paketet är deterministiskt, så samma avslutade ärende exporterat två gånger ger identiska bytes och arkivkopian kan visas vara den levererade kopian. |
| Gap | Ingen kodbrist. |
| Lösning | packages/archive, packages/evidence. |
| Kodevidens | packages/archive/src/index.ts; packages/evidence/src/index.ts |
| Verifiering | tests/run.mjs: två arkivtester samt evidensmanifest- och ZIP-tester. |
| Status | PASS |

### 2039 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA ha möjlighet att i dialog med leverantören kunna påverka vidareutvecklingen av systemet. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Vidareutveckling |
| Nuläge | Avtalsfråga. |
| Gap | Ingen teknisk komponent. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Avtalsvillkor. |

### 2040 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Support SKA ges i enlighet med riktlinjerna som finns i bilagan Supportavtal för molnbaserade tjänster; |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Support |
| Nuläge | Supportorganisation, kontaktvägar, öppettider, prioritetsnivåer, svarstider och eskalering är dokumenterade i docs/operations/KUNGALV_SUPPORT_SLA.md, och incident- och eskaleringsrutinen i docs/operations/OVERVAKNING_OCH_INCIDENT.md avsnitt 3. Den tekniska förmåga supporten vilar på finns: korrelations-ID genom API, workers och loggar, readiness som skiljer databas, Redis, lagring, TIC, signeringstjänst och valideringstjänst, samt hashkedjad auditlogg. |
| Gap | Bilagan Supportavtal för molnbaserade tjänster ingår inte i det kravunderlag som extraherats till requirements.json, och dess faktiska villkor är därmed inte kända i kodbasen. Att sätta PASS vore ett påstående om överensstämmelse med ett dokument som inte lästs. |
| Lösning | docs/operations/KUNGALV_SUPPORT_SLA.md, docs/operations/OVERVAKNING_OCH_INCIDENT.md. |
| Kodevidens | docs/operations/KUNGALV_SUPPORT_SLA.md; docs/operations/OVERVAKNING_OCH_INCIDENT.md; packages/readiness/src/index.ts |
| Verifiering | tests/run.mjs: readiness-test som skiljer blockerande fel, varningar och genomförda kontroller. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Bilagan Supportavtal för molnbaserade tjänster från Kungälvs kommun. När bilagan tillhandahålls jämförs den mot KUNGALV_SUPPORT_SLA.md och avvikande nivåer justeras; ingen kodändring väntas, det är en avtalsjämförelse. Blockerar inte teknisk go-live. |

### 2041 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Tjänsten SKA vara tillgänglig dygnet runt, med undantag för planerat underhåll. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Tillgänglighet |
| Nuläge | Tjänsten är tillgänglig dygnet runt utom vid planerat underhåll, som aviseras minst fem arbetsdagar i förväg och läggs utanför kontorstid. Additiva migrationer gör att de flesta uppgraderingar sker utan avbrott, eftersom applikationen kan rullas ut före eller efter schemaändringen. Övervakningen larmar på utfall och inte bara på HTTP-status, så ett läge där tjänsten svarar men underskrifter inte blir klara upptäcks. |
| Gap | Ingen kodbrist. Uppmätt tillgänglighet över tid kräver drift i produktion. |
| Lösning | docs/operations/OVERVAKNING_OCH_INCIDENT.md avsnitt 1 och 5, packages/readiness, additiv migrationspolicy. |
| Kodevidens | docs/operations/OVERVAKNING_OCH_INCIDENT.md; packages/readiness/src/index.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | tests/run.mjs: readiness-test. npm run verify:migrations kontrollerar att varje migration dokumenterar påverkan och rollback. |
| Status | PASS |

### 2042 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga kostnader för införande, drift, tillhandahållande, funktionalitet, support, vidareutveckling av systemet och avveckling SKA lämnas i prisbilagan. I de fall tredjepartsprodukter eller specifika systemprogramvaror behövs för att använda systemet ingåe dessa i anbudet. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Kostnader |
| Nuläge | Prisfråga. |
| Gap | Ingen teknisk komponent. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Prisbilaga. |

### 2043 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | I samråd med beställaren SKA leverantören säkerställa att systemet uppfyller och utvecklas i takt med förändringar i gällande lagstiftning och förordningar som berör beställarens verksamhet – exempelvis tryckfrihetsförordningen, offentlighets- och sekretesslagen, arkivlagen, GDPR, kommunallagen, föräldrabalken samt förmynderskapsförordningen. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Lagstiftning |
| Nuläge | Avtals- och förvaltningsfråga. |
| Gap | Ingen teknisk komponent utöver att systemet ska kunna ändras. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Avtalad förvaltningsprocess. |

### 2044 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA se till att skydd och spårbarhet finns i de verktyg som används för underhåll av systemet samt dess säkerhetskonfiguration och information. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Spårbarhet |
| Nuläge | Underhållsverktygen har samma skydd och spårbarhet som tjänsten: personlig inloggning, minsta möjliga behörighet, ingen stående åtkomst till kunddata och loggning av varje administrativ åtgärd med aktör, tenant och korrelation. Loggverktygen är i sin tur åtkomstskyddade och auditloggen är hashkedjad. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; packages/observability/src/index.ts; packages/audit/src/index.ts |
| Verifiering | tests/run.mjs: auditkedjetest och test för spårbara säkerhetshändelser. |
| Status | PASS |

### 2045 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA utan dröjsmål informera beställaren om sårbarheter i levererade komponenter samt åtgärda dessa omgående. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Sårbarheter |
| Nuläge | Samma rutin som krav 3538: bedömning utifrån faktisk exponering, åtgärd inom 24 timmar för kritisk exponerad sårbarhet, 7 dagar för hög och 30 dagar för medel, samt information till kunden utan dröjsmål vid kritisk och hög. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; SBOM.cdx.json |
| Verifiering | Beroenden skannas vid varje bygge; provenance och SBOM verifieras i npm run verify. |
| Status | PASS |

### 2046 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Nya versioner SKA vara både testade och kvalitetssäkrade innan systemet uppdateras hos beställaren. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Kvalitetssäkring |
| Nuläge | Nya versioner testas och kvalitetssäkras i separat testmiljö före utrullning hos beställaren. npm run verify måste vara grön, och migrationer är additiva med dokumenterad rollback per migration så att applikationen kan rullas ut före eller efter schemaändringen. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; package.json; scripts/check-sql-migrations.mjs |
| Verifiering | npm run verify och npm run verify:migrations är obligatoriska grindar. |
| Status | PASS |

### 2047 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Beställaren SKA kostnadsfritt ha rätt till senaste versionen av systemet under hela avtalstiden. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Rätt till senaste version |
| Nuläge | SaaS-modell där alla tenants kör samma version. |
| Gap | Ingen. |
| Lösning | Befintlig leveransmodell. |
| Kodevidens | infrastructure/ |
| Verifiering | Ingen. |
| Status | PASS |

### 2048 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA ta fram en införandeplan med tider, aktiviteter och resurser från såväl leverantör som beställare för att möjliggöra en färdig leverans. |
| Typ | SKA |
| Kategori | 05 - Införande |
| Område | Införandeplan |
| Nuläge | Projektfråga. |
| Gap | Ingen införandeplan finns. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Införandeplan tas fram i projektet. |

### 2051 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Införandet SKA ske i nära samarbete med Beställarens projektledare samt verksamheten. |
| Typ | SKA |
| Kategori | 05 - Införande |
| Område | Införandeplan |
| Nuläge | Projektfråga. |
| Gap | Ingen teknisk komponent. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Samarbete i införandeprojektet. |

### 2054 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA anordna utbildning av systemet, för upp till fyra systemförvaltare och superanvändare/systemadministratörer, innan acceptanstest påbörjas. |
| Typ | SKA |
| Kategori | 05 - Införande |
| Område | Utbildning |
| Nuläge | Ingen utbildning planerad. |
| Gap | Ingen teknisk komponent. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Utbildningstillfälle genomförs av leverantören. |

### 2055 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | I leveransen av systemet SKA det ingå utbildningsmaterial på god svenska i elektronisk och redigeringsbar form som beställaren har rätt att använda för egen utbildning. |
| Typ | SKA |
| Kategori | 05 - Införande |
| Område | Utbildning |
| Nuläge | Utbildningsmaterialet är skrivet på svenska i Markdown: elektroniskt, redigerbart av kunden utan särskild programvara och versionshanterat. Kunden får materialet i sitt eget arkiv med rätt att ändra det. Materialet täcker samtliga användarroller från undertecknare till organisationsadministratör. |
| Gap | Ingen kodbrist. Lärarledd utbildning av systemförvaltare och superanvändare är en leveransaktivitet och redovisas separat under krav 2054. |
| Lösning | docs/utbildning/ANVANDARHANDBOK.md, docs/system/SYSTEMDOKUMENTATION.md, docs/system/BEHORIGHETSMODELL.md. |
| Kodevidens | docs/utbildning/ANVANDARHANDBOK.md; docs/system/SYSTEMDOKUMENTATION.md |
| Verifiering | Dokumenten ingår i repositoryt och omfattas av uppdateringsrutinen i SYSTEMDOKUMENTATION.md avsnitt 4. |
| Status | PASS |

### 2056 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA ha ett totalansvar för installationen så att beställaren vid driftsättning kan ta i bruk ett väl fungerande system. |
| Typ | SKA |
| Kategori | 05 - Införande |
| Område | Installation |
| Nuläge | SaaS-leverans där leverantören ansvarar för driftsättning. |
| Gap | Ingen. |
| Lösning | Befintlig leveransmodell. |
| Kodevidens | docs/operations/deployment-topology.md |
| Verifiering | Ingen. |
| Status | PASS |

### 2057 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemdokumentation SKA vara skriven på Svenska |
| Typ | SKA |
| Kategori | 06 - Dokumentation |
| Område | Språk |
| Nuläge | Systemdokumentationen är i sin helhet skriven på svenska: SYSTEMDOKUMENTATION.md, BEHORIGHETSMODELL.md, ANVANDARHANDBOK.md, OVERVAKNING_OCH_INCIDENT.md, KUNDENS_EGNA_FORANDRINGAR.md, kravmatrisen och runbooks. Även gränssnitten, felmeddelandena och gallrings- och bevistexterna är på svenska. |
| Gap | Ingen. |
| Lösning | docs/system, docs/utbildning, docs/operations, docs/compliance/kungalv. |
| Kodevidens | docs/system/SYSTEMDOKUMENTATION.md; docs/system/BEHORIGHETSMODELL.md; docs/utbildning/ANVANDARHANDBOK.md; docs/compliance/kungalv/REQUIREMENT_MATRIX.md |
| Verifiering | Dokumenten ingår i repositoryt. |
| Status | PASS |

### 2058 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemdokumentationen SKA innehålla systemkrav, systemdesign och installationsanvisningar. |
| Typ | SKA |
| Kategori | 06 - Dokumentation |
| Område | Systemdokumentation |
| Nuläge | docs/system/SYSTEMDOKUMENTATION.md innehåller systemkrav (kundens och driftmiljöns), systemdesign (grundprinciper, komponenter, signeringskedjan, dataflöde och tenantisolering) samt installationsanvisningar för både lokal miljö och produktion, inklusive migrationer, hemligheter, gränstjänster och verifieringssteg. |
| Gap | Ingen. |
| Lösning | docs/system/SYSTEMDOKUMENTATION.md, ADR 0001-0003. |
| Kodevidens | docs/system/SYSTEMDOKUMENTATION.md; docs/architecture/adr/0001-clean-room-core.md; docs/architecture/adr/0002-control-data-plane.md; docs/architecture/adr/0003-signing-backend-dependency-policy.md |
| Verifiering | Installationsstegen motsvarar de faktiska npm-scripten och verifieras av npm run verify. |
| Status | PASS |

### 2059 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemdokumentationen SKA omfatta/innehålla beskrivning av hur behörighetskontrollen är uppbyggd |
| Typ | SKA |
| Kategori | 06 - Dokumentation |
| Område | Systemdokumentation |
| Nuläge | docs/system/BEHORIGHETSMODELL.md beskriver behörighetskontrollens uppbyggnad: de tre lager som alla måste hålla (tenantkontext, row level security med FORCE, applikationsauktorisering), aktörstyper med omfattning, roller och rättigheter, de två gränser som är hårdkodade för att skydda kunden mot leverantören, automatisk rolltilldelning deny-by-default, livscykel och spårbarhet, samt minsta möjliga behörighet. |
| Gap | Ingen. |
| Lösning | docs/system/BEHORIGHETSMODELL.md, packages/authorization, packages/tenant-context, migrations/data/0005_rls.sql. |
| Kodevidens | docs/system/BEHORIGHETSMODELL.md; packages/authorization/src/index.ts; migrations/data/0005_rls.sql |
| Verifiering | tests/run.mjs: behörighets-, tenantkälls- och gallringstester. tests/security.mjs täcker åtkomstvägarna. |
| Status | PASS |

### 2060 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Ändringsdokumentation (changelog) och releasenotes SKA produceras löpande i samband med leverans av ändringar och nya funktioner. |
| Typ | SKA |
| Kategori | 06 - Dokumentation |
| Område | Uppgraderingar |
| Nuläge | CHANGELOG.md förs löpande enligt Keep a Changelog med tillagt, ändrat, åtgärdat och säkerhet per leverans, och versionering enligt semver. Releasenotes utgörs av changelogposten för respektive version. |
| Gap | Ingen. |
| Lösning | CHANGELOG.md, uppdateringsrutinen i docs/system/SYSTEMDOKUMENTATION.md avsnitt 4. |
| Kodevidens | CHANGELOG.md; docs/system/SYSTEMDOKUMENTATION.md |
| Verifiering | Changelogen ingår i repositoryt och uppdateras i samma pull request som leveransen. |
| Status | PASS |

### 2061 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Uppdatering SKA ske av samtliga dokumentationer där det skett förändringar i systemet. |
| Typ | SKA |
| Kategori | 06 - Dokumentation |
| Område | Uppdateringar |
| Nuläge | Uppdateringsrutinen står i docs/system/SYSTEMDOKUMENTATION.md avsnitt 4 och är delvis maskinellt framtvingad. Ändring i schema, publikt API eller behörighetsmodell kräver uppdaterad dokumentation i samma pull request. Kravmatrisen genereras ur assessments.json och requirements.json, och npm run verify misslyckas om ett krav saknar bedömning, så matrisen kan inte hamna efter koden. Arkitekturbeslut som ändrar en princip skrivs som ny ADR i stället för att ändra en befintlig. |
| Gap | Ingen. |
| Lösning | docs/system/SYSTEMDOKUMENTATION.md avsnitt 4, scripts/build-requirement-matrix.mjs som grind i npm run verify. |
| Kodevidens | docs/system/SYSTEMDOKUMENTATION.md; scripts/build-requirement-matrix.mjs; CHANGELOG.md |
| Verifiering | npm run verify:requirements misslyckas vid krav utan bedömning eller bedömning utan krav. |
| Status | PASS |

### 2064 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA följa Riksarkivets RA-FS 2009:2 gällande elektroniska handlingar vid överföring till system för bevarande. |
| Typ | SKA |
| Kategori | 07 - Digitalt bevarande |
| Område | Digitalt bevarande |
| Nuläge | Arkivpaketet innehåller nu en riktig METS sip.xml enligt den profil Riksarkivet publicerar, vid sidan av det JSON-manifest som gör offline-verifiering möjlig. Profil-URI, ExtensionMETS-namnrymden, ext:OAISSTATUS, CHECKSUMTYPE och den enkla Profilestructmap är hämtade ur profilen och inte gissade. Men strukturen följer profilen är ett annat påstående än validerad mot mottagarens XSD, och FGS_CONFORMANCE_STATUS.schemaValidated är false. |
| Gap | Ingen kvarvarande kodbrist. Att påstå RA-FS-konformitet utan att ha validerat mot mottagande arkivs schemauppsättning vore precis den överdrift den tidigare PASS-bedömningen gjorde. |
| Lösning | packages/archive/src/fgs.ts (METS-deskriptor), apps/workers/src/archive-handlers.ts, migrations/data/0023. |
| Kodevidens | packages/archive/src/fgs.ts; apps/workers/src/archive-handlers.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: fem FGS-tester inklusive determinism, XML-escaping och att adaptern aldrig påstår schemakonformitet den inte verifierat. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Bekräftad FGS-version från kommunen samt den XSD-uppsättning och eventuella lokala profilutökningar mottagande e-arkiv kräver. Validering mot den uppsättningen är ett externt steg; koden är på plats och FGS_CONFORMANCE_STATUS redovisar exakt vad som återstår. |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2065 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA följa Riksarkivets gällande föreskrifter och allmänna råd gällande lagring, information, standarder, förvaltningsgemensamma specifikationer (FGS 1.2) och dokumentation för framtida avställande eller export. |
| Typ | SKA |
| Kategori | 07 - Digitalt bevarande |
| Område | Digitalt bevarande |
| Nuläge | Samma paket och samma profil som 2064. Arkivexporten körs nu på riktigt via ARCHIVE_EXPORT i stället för att vara ett bibliotek utan anropare, och paketet är deterministiskt: samma stängda ärende exporterat två gånger ger identiska bytes, annars går den arkiverade kopian inte att visa vara den som levererades. |
| Gap | Samma som 2064: schemavalidering mot mottagande arkivs föreskriftsversion återstår. |
| Lösning | packages/archive/src/fgs.ts, apps/workers/src/archive-handlers.ts, migrations/data/0023_archive_export_fgs.sql. |
| Kodevidens | packages/archive/src/fgs.ts; migrations/data/0023_archive_export_fgs.sql |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/archive-export.sql samt determinismtestet. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Bekräftad föreskriftsversion och schemauppsättning från kommunens e-arkiv. Utan den kan konformitet inte verifieras, bara påstås. |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2066 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA kunna skapa exporter för leverans samt exportera metadata i ett teknikneutralt format i enlighet med FGS 1.2. |
| Typ | SKA |
| Kategori | 07 - Digitalt bevarande |
| Område | Digitalt bevarande |
| Nuläge | buildDescriptiveMetadata producerar teknikneutral beskrivande metadata som kanonisk JSON, skild från paketmanifestet så att ett mottagande arkiv kan konsumera metadatan utan att tolka paketeringen. JSON är valt för att RA-FS kräver ett teknikneutralt och dokumenterat format snarare än ett visst schema, och ett kanoniskt JSON-manifest kan verifieras offline utan XML-verktygskedja. Metadatan bär maskerade identifierare och aldrig fullständigt personnummer, eftersom ett arkivpaket överlever varje åtkomstkontroll som annars skulle skydda det (AGENTS.md regel 6). |
| Gap | Ingen. |
| Lösning | packages/archive: buildDescriptiveMetadata, ARCHIVE_PACKAGE_SCHEMA, kanonisk JSON-serialisering. |
| Kodevidens | packages/archive/src/index.ts; packages/crypto/src/canonical-json.ts |
| Verifiering | tests/run.mjs: arkivtest som bland annat kontrollerar att metadatan inte innehåller något fullständigt personnummer. |
| Status | PASS |

### 2067 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Det SKA vara möjligt i systemet att exportera filer med tillhörande metadata för digital långtidsarkivering till ett oberoende e-arkiv. |
| Typ | SKA |
| Kategori | 07 - Digitalt bevarande |
| Område | Digitalt bevarande |
| Nuläge | buildArchivePackage exporterar filer tillsammans med metadata i ett paket. verifyArchivePackage verifierar paketet med enbart paketet, manifestet och den separat levererade manifesthashen: ingen databas, inget nätverk, ingen Kommunsign. Det är själva kravet, eftersom ett bevarandepaket som bara kan kontrolleras av systemet som skapade det inte är bevarat utan bara lagrat. Manipulerad fil, saknad fil, extra fil och manipulerat manifest upptäcks alla. |
| Gap | Ingen. |
| Lösning | packages/archive: buildArchivePackage, verifyArchivePackage. |
| Kodevidens | packages/archive/src/index.ts |
| Verifiering | tests/run.mjs: arkivtest för determinism och offline-verifiering, inklusive manipulerad fil, saknad fil, extra fil och förfalskat manifest. |
| Status | PASS |

### 2068 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA ha en gallringsfunktion. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Gallring är nu en operation kunden kan köra, inte bara ett bibliotek. Den tidigare bedömningen beskrev packages/retention korrekt men utelämnade att ingen runtime-kod importerade det: RETENTION_EXECUTE var phaseUnsupported och dead-letterade direkt, och app.retention_policies fanns inte som tabell. Migration 0024 lägger policytabellen, app.gallring_jobs och app.gallring_reports, och apps/workers/src/retention-handlers.ts driver körningen. |
| Gap | Ingen. |
| Lösning | migrations/data/0024_gallring_runtime.sql (tillståndsmaskin, fyra-ögon, legal hold), apps/workers/src/retention-handlers.ts (körning), apps/api/src/production-adapters/postgres/retention-repository.ts och /v1/retention-routerna (förhandsgranskning, köläggning, godkännande). |
| Kodevidens | migrations/data/0024_gallring_runtime.sql; apps/workers/src/retention-handlers.ts; apps/api/src/production-adapters/postgres/retention-repository.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/gallring.sql, nio scenarier som var för sig kontrollerar att rätt guard utlöstes. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2069 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Beställaren SKA utan inblandning eller hjälp från Leverantör kunna gallra. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Beställaren kör gallring själv genom /v1/retention/preview, /v1/retention/jobs och godkännanderoutern. Ingen leverantörsåtgärd ingår i flödet. Förhandsgranskningen är avsiktligt en ren läsning: gallring är oåterkallelig, så steget som visar vad som skulle förstöras får aldrig förstöra något. |
| Gap | Ingen. |
| Lösning | apps/api/src/router.ts (/v1/retention/*), retention-repository.ts. |
| Kodevidens | apps/api/src/router.ts; apps/api/src/production-adapters/postgres/retention-repository.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: gallringstester samt behörighetstester för retention:manage och retention:execute. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2070 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Gallringsfunktionen SKA tillgodose att den gallrade informationen raderas och inte går att återskapa. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Gallrad information går inte att återskapa. Objektlagringen raderas före databasraderna, så ett avbrott mitt i lämnar inga föräldralösa objekt. Hash-kedjade evidensrader raderas inte — deras nyttolaster förstörs i objektlagringen och rapporten säger uttryckligen att det är kryptografisk radering i stället för att påstå att raderna togs bort. Att påstå det senare vore en osann uppgift i ett register kommunen svarar för. |
| Gap | Ingen. |
| Lösning | apps/workers/src/retention-handlers.ts (raderingsordning och kryptografisk radering), MANDATORY_CASE_TARGETS i packages/retention/src/executor.ts. |
| Kodevidens | apps/workers/src/retention-handlers.ts; packages/retention/src/executor.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: gallringstest som avvisar en rapport som påstår fullständighet samtidigt som den räknar upp oadresserade mål. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2071 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Gallringsfunktionen SKA vara behörighetsstyrd, så att endast behöriga användare kan utföra gallring. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Gallring kräver retention:manage för att köa och retention:execute för att godkänna, och godkännaren får inte vara den som begärde körningen. Fyra ögon på en oåterkallelig radering är hela kontrollen, och den ligger i databasen och inte bara i koden. |
| Gap | Ingen. |
| Lösning | packages/authorization (delade grants), migrations/data/0024 (approved_by <> requested_by), API-routerna. |
| Kodevidens | packages/authorization/src/index.ts; migrations/data/0024_gallring_runtime.sql |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/gallring.sql bevisar att självgodkännande avvisas med rätt guard. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2072 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Gallringsfunktionen SKA kunna generera gallringsrapporter eller gallringsloggar, så att gallring som utförts blir spårbar. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Varje körning producerar en gallringsrapport via buildGallringReport, lagrad i app.gallring_reports och audit-loggad. Ett villkor i databasen hindrar en rapport från att påstå fullständighet samtidigt som den räknar upp oadresserade mål. |
| Gap | Ingen. |
| Lösning | packages/retention/src/index.ts (rapportbygge), migrations/data/0024 (app.gallring_reports med fullständighetsvillkor). |
| Kodevidens | packages/retention/src/index.ts; migrations/data/0024_gallring_runtime.sql |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: gallringstester inklusive fullständighetsvillkoret. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2073 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA tillhandahålla dokumenterade API:er för läsning och skrivning av data till andra system och kommunens integrationsplattform. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | API |
| Nuläge | API:t stödjer både läsning och skrivning mot andra system: skapa och hämta ärenden, koppla dokument och bilagor, hantera undertecknare, starta, påminna och avbryta, hämta status, undertecknat dokument, valideringsrapport och bevispaket, hantera webhookprenumerationer och mallar, samt gallring, arkivexport och rättighetsbegäranden. Specifikationen är maskinläsbar OpenAPI 3.1 och markerar per endpoint om den är driftsatt eller specificerad, så att en integratör kan skilja finns från är specificerad utan att upptäcka skillnaden i produktion. |
| Gap | Ingen. |
| Lösning | docs/api/openapi.yaml, apps/api/src/router.ts. |
| Kodevidens | docs/api/openapi.yaml; apps/api/src/router.ts; docs/api/error-codes.md |
| Verifiering | npm run verify:sdk kontrollerar att SDK och specifikation är i synk. tests/run.mjs täcker auktorisering och idempotens. |
| Status | PASS |

### 2074 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA tillhandahålla teknisk dokumentation för integration. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | Integration |
| Nuläge | docs/integration/API_INTEGRATION.md är teknisk integrationsdokumentation på svenska: autentisering och scopetabell, versioneringspolicy med tolv månaders avvecklingstid, idempotens och varför den behövs, paginering och varför cursor väljs framför offset, felformat, korrelation, typiska flöden steg för steg, webhookverifiering med de fyra kontroller mottagaren måste göra, samt SDK:er. Kompletteras av docs/api/openapi.yaml och docs/api/error-codes.md. |
| Gap | Ingen. |
| Lösning | docs/integration/API_INTEGRATION.md, docs/api/openapi.yaml, docs/api/error-codes.md. |
| Kodevidens | docs/integration/API_INTEGRATION.md; docs/api/openapi.yaml; docs/api/error-codes.md |
| Verifiering | Dokumentationen motsvarar de faktiska endpointsen och kontrolleras mot specifikationen av npm run verify:sdk. |
| Status | PASS |

### 2075 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Kommunens data SKA kunna exporteras i öppna, dokumenterade format. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | Integration |
| Nuläge | Exportformaten är öppna och dokumenterade: PDF/A-2b eller PDF/A-3b för dokument, kanonisk JSON för manifest och beskrivande metadata, SHA-256 för checksummor och deterministisk ZIP (STORE) för paketet. Samtliga är publicerade standarder utan leverantörsberoende, och paketet kan läsas och verifieras utan Kommunsign. |
| Gap | Ingen. |
| Lösning | packages/archive, packages/evidence/src/zip.ts. |
| Kodevidens | packages/archive/src/index.ts; packages/evidence/src/zip.ts |
| Verifiering | tests/run.mjs: arkivtest för offline-verifiering samt ZIP-determinismtest. |
| Status | PASS |

### 2076 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga API:er, både nuvarande och framtida SKA ingå utan kostnad eller volymbegränsing. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | API |
| Nuläge | Åtagandet är dokumenterat i docs/integration/API_INTEGRATION.md avsnitt 1: samtliga API:er, nuvarande och framtida, ingår utan särskild kostnad och utan volymbegränsning i avtalet. Rate limits finns men är ett driftskydd och inte en affärsbegränsning; de är satta per tenant så att en kunds trafik aldrig kan förbruka en annans utrymme, och justeras utan kostnad vid legitim volym. Ingen funktion är låst bakom en tilläggsmodul. |
| Gap | Ingen kodbrist. Den avtalsmässiga bekräftelsen sker i avtalet. |
| Lösning | docs/integration/API_INTEGRATION.md, tenantmedveten rate limiting. |
| Kodevidens | docs/integration/API_INTEGRATION.md; docs/api/openapi.yaml |
| Verifiering | Dokumenterat åtagande. Tenantmedveten rate limiting säkerställer att gränserna inte blir en delad budget mellan kunder. |
| Status | PASS |

### 2079 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Inloggning till systemet SKA stödja antingen SAML 2.0 eller OIDC (Open Id Connect). |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Inloggning |
| Nuläge | Federerad inloggning fungerar nu hela vägen. En inloggning startas mot /auth/federation/{providerKey}/login, bindningen sparas i control.federation_login_requests, och ACS:en konsumerar den innan något läses ur assertionen — tenanten kommer alltid från den registrerade inloggningen och aldrig ur meddelandet. Signaturverifieringen ligger i validation-service, som redan har XML-DSig-maskineriet: SamlAssertionValidator jämför mot tenantens konfigurerade certifikat innan något parsas, avvisar externa referenser och DTD, och letar upp det signerade elementet ur signaturens egen Reference i stället för att parsa först och kontrollera sedan. Beslutet fattas i ett anrop till verifyWorkforceAssertion mot den varaktiga assertion-ledgern. Båda protokollen finns: SAML 2.0 via ACS och OIDC via callback, och båda går genom samma verifyWorkforceAssertion. Två beslutsvägar hade förr eller senare blivit oense om något — maximal sessionsålder, eller om en omappad grupp ger något — och oenigheten hade varit osynlig tills en tenant bytte protokoll. OidcTokenValidator avvisar ett id_token vars header pekar ut var nyckeln ska hämtas (jku, x5u, jwk) innan signaturen ens kontrolleras, tillåter bara asymmetriska algoritmer så att alg:none aldrig är nåbar, och läser auth_time i stället för iat så att ett färskt token inte kan beskriva en gammal session. |
| Gap | Ingen. |
| Lösning | apps/api/src/federation-router.ts (login, ACS, OIDC-callback), migrations/control/0019_federation_login_requests.sql (engångsförbrukad bindning), services/validation-service SamlAssertionValidator och POST /v1/validate/saml, packages/validation-client validateSaml, federation-repository (ledger och tenant-IdP-konfiguration). OidcTokenValidator och POST /v1/validate/oidc; CompactJwsVerifier flyttad till services/commons så Freja och OIDC delar en verifierare. |
| Kodevidens | apps/api/src/federation-router.ts; services/validation-service/src/main/java/se/kommunsign/validation/SamlAssertionValidator.java; migrations/control/0019_federation_login_requests.sql; services/validation-service/src/main/java/se/kommunsign/validation/OidcTokenValidator.java; services/commons/src/main/java/se/kommunsign/commons/CompactJwsVerifier.java |
| Verifiering | npm run verify (147 tester), mvn -B test (17 Java-tester), bash scripts/db-verify.sh mot riktig Postgres: nio federationsroute-tester (replay, öppen omdirigering, fail-closed utan konfigurerat certifikat, PASS utan verifierad signatur, protokoll som inte får väljas av endpointen), elva Java-tester mot verkligt signerad XML och verkligt signerade id_token inklusive falsk IdP, manipulerad payload, alg:none och jku-header, samt tests/sql/federation-replay.sql. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2080 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Lösningen SKA stödja roll- och behörighetsstyrning. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Behörighet |
| Nuläge | Roll- och behörighetsmodell finns för både plattform och tenant med capability-baserad kontroll. |
| Gap | Ingen. |
| Lösning | packages/authorization. |
| Kodevidens | packages/authorization/src/index.ts |
| Verifiering | tests/run.mjs: API authorizes every case operation. |
| Status | PASS |

### 2081 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Det SKA vara möjligt att begränsa åtkomst till funktioner och information baserat på användarroller. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Behörighet |
| Nuläge | Åtkomst till funktioner och information begränsas per användarroll i tre lager som alla måste hålla: tenantkontext som aldrig kommer ur ett fritt requestfält, RLS med FORCE på varje tenantbunden tabell, och applikationsauktorisering i packages/authorization. Roller ligger per tenant i app.roles med rättigheter som verb på resurs, och tilldelas via app.role_assignments mot ett medlemskap, valfritt avgränsat till en enhet. API-klienter begränsas dessutom av scopes. Modellen är dokumenterad i docs/system/BEHORIGHETSMODELL.md. |
| Gap | Ingen. |
| Lösning | packages/authorization, packages/tenant-context, migrations/data/0005_rls.sql och 0008, docs/system/BEHORIGHETSMODELL.md. |
| Kodevidens | packages/authorization/src/index.ts; migrations/data/0008_rls_for_extended_model.sql; docs/system/BEHORIGHETSMODELL.md |
| Verifiering | tests/run.mjs: behörighetstester, tenantkälltest, gallringsbehörighet och SCIM-rollmappning. tests/security.mjs täcker åtkomstvägarna. |
| Status | PASS |

### 2082 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA stödja automatisk provisionering av användare. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | Automatisk provisionering går nu att använda. packages/scim och migration 0017 fanns sedan tidigare, men det saknades HTTP-yta helt, så ingen katalog kunde provisionera någon. /scim/v2/Users, /scim/v2/Groups och /scim/v2/ServiceProviderConfig hanteras före sessionsupplösningen, eftersom en katalog som pushar användare inte har någon session. |
| Gap | Ingen kvarvarande kodbrist. Anslutning mot kommunens katalog kräver att kommunen registrerar credentialen. |
| Lösning | apps/api/src/scim-router.ts, apps/api/src/production-adapters/postgres/scim-repository.ts, migration 0026 som gör credentialen utfärdbar. |
| Kodevidens | apps/api/src/scim-router.ts; apps/api/src/production-adapters/postgres/scim-repository.ts; migrations/data/0026_scim_client_issuance.sql |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: åtta SCIM-tester över HTTP samt tests/sql/scim-provisioning.sql. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2083 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Provisioneringen SKA omfatta minst:  - skapande av användarkonto - uppdatering av användaruppgifter - avaktivering/avslut av användare |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | Skapande sker idempotent på externalId, så en omsynkning blir en no-op i stället för en 409 som stannar synken. Uppdatering sker via PUT och PATCH med en uttrycklig lista över skrivbara attribut — ett attribut utanför listan avvisas i stället för att tyst ignoreras, eftersom de två sidorna annars är oense för alltid. Avaktivering kommer som replace active=false och behåller raden, så en avslutad medarbetares historik finns kvar. |
| Gap | Ingen. |
| Lösning | packages/scim (createScimUser, applyScimPatch, deprovisionScimUser), apps/api/src/scim-router.ts, app.scim_provisioning_events. |
| Kodevidens | packages/scim/src/index.ts; apps/api/src/scim-router.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: idempotenstest, avaktiveringstest och DELETE-test som bevisar att historik bevaras. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2084 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Provisioneringen SKA baseras på kommunens centrala identitetskälla. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | Provisioneringen drivs av kommunens katalog genom en tenantbunden credential. Tenanten hämtas ur credentialraden och aldrig ur sökväg, brödtext eller header — en klient som kunde namnge sin egen tenant vore en tvärtenant-skrivprimitiv utdelad med varje token. |
| Gap | Ingen kvarvarande kodbrist. Vilken katalog som ansluts är kommunens val och kräver att credentialen utfärdas. |
| Lösning | app.scim_provisioning_clients (token_hash, assignable_roles), scim-router authenticate(). |
| Kodevidens | apps/api/src/scim-router.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: test som visar att saknad, felformad och felaktig token ger samma svar, och att svaret inte beskriver vad som skulle ha nåtts. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 2085 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Det SKA vara möjligt att tilldela roller och behörigheter automatiskt vid provisionering. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | Roller tilldelas automatiskt från katalogens grupper genom en explicit mappning, deny-by-default: en omappad grupp ger ingenting, och en mappning mot en roll klienten inte får tilldela är ett fel i stället för en tyst tilldelning. Taket kontrolleras både i biblioteket och i SQL, eftersom det är gränsen där ett fel ovanför blir verklig behörighetseskalering. Tilldelningen är en ersättning och inte ett tillägg, så den som tas ur en grupp förlorar rollen. |
| Gap | Ingen. |
| Lösning | resolveScimRoles i packages/scim, applyRoles i scim-repository (via app.memberships och app.role_assignments). |
| Kodevidens | packages/scim/src/index.ts; apps/api/src/production-adapters/postgres/scim-repository.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: test som visar att en gruppmappning utanför klientens scope avvisas och att ingenting skrivs. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

## KLASSA Inform. Tekn. Krav

### 3501 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska för de delar av verksamheten som berörs i leveransen ha ett ledningssystem för informationssäkerhet (LIS) som baseras på SS-EN ISO/IEC27001:2017 eller motsvarande. Ledningssystemet ska omfatta bland annat att samtliga säkerhetskritiska administrativa och tekniska processer är dokumenterade och vilar på en formell grund där roller, ansvar och befogenheter finns tydligt definierade. |
| Typ | SKA |
| ISO | A.6.1 Intern organisation — A.6.1.1 Informationssäkerhetsroller och ansvar |
| Nuläge | Inget LIS finns dokumenterat. |
| Gap | Ledningssystem för informationssäkerhet enligt ISO/IEC 27001 eller motsvarande saknas. |
| Lösning | docs/isms/ med scope, roller, riskhantering och tillämplighetsförklaring. Mallar gör inte kravet uppfyllt. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Etablerat och tillämpat LIS hos leverantören. |

### 3502 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha tillsett att ansvar och arbetsuppgifter som står i konflikt med varandra och kan leda till missbruk är tekniskt eller organisatoriskt åtskilda. |
| Typ | SKA |
| ISO | A.6.1 Intern organisation — A.6.1.2 Uppdelning av arbetsuppgifter |
| Nuläge | Uppdelning av ansvar är dokumenterad i docs/isms/SAKER_UTVECKLING.md avsnitt 2, och de två viktigaste separationerna är verkställda i kod och inte enbart i rutin: gallring kräver att godkännaren är någon annan än den som begärde, har retention:execute och inte är leverantörspersonal; åtkomst till skyddade personuppgifter kräver tidsbegränsat och motiverat samtycke per person utfärdat av kunden. Därutöver granskar ingen sin egen ändring, och utrullning kräver godkänd granskning och grön npm run verify. |
| Gap | Ingen kodbrist. |
| Lösning | packages/retention/src/executor.ts |
| Kodevidens | packages/retention/src/executor.ts; packages/protected-identity/src/index.ts; docs/isms/SAKER_UTVECKLING.md |
| Verifiering | tests/run.mjs: gallringstest för godkännande av annan än begärande och spärr mot leverantörspersonal, samt test för supportåtkomst per person. |
| Status | PASS |

### 3503 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha upprättat och upprätthålla kontakter med de myndigheter som berörs av leveransen |
| Typ | SKA |
| ISO | A.6.1 Intern organisation — A.6.1.3 Kontakt med myndigheter |
| Nuläge | Organisatoriskt krav. |
| Gap | Inga myndighetskontakter upprättade. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Upprättade myndighetskontakter. |

### 3504 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha en policy som beskriver hur de anställda får arbeta på distans avseende drift, förvaltning och support av de levererade tjänsterna. Leverantören ska regelbundet kontrollera att den efterlevs. |
| Typ | SKA |
| ISO | A.6.2 Mobila enheter och distansarbete — A.6.2.2 Distansarbete |
| Nuläge | Ingen distansarbetspolicy finns. |
| Gap | Policy och efterlevnadskontroll saknas. |
| Lösning | Policymall plus efterlevnadsrutin. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Antagen och tillämpad policy. |

### 3505 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha processer och rutiner på plats för bakgrundskontroll av personal. |
| Typ | SKA |
| ISO | A.7.1 Före anställning — A.7.1.1 Bakgrundskontroll |
| Nuläge | Organisatoriskt krav. |
| Gap | Ingen bakgrundskontrollsprocess. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Genomförda bakgrundskontroller. |

### 3506 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha avtal om tystnadsplikt med sina anställda. Tystnadsplikten ska omfatta information om leverantörens kunder. Via avtal ska leverantören även säkerställa tystnadsplikt för underleverantörer. |
| Typ | SKA |
| ISO | A.7.1 Före anställning — A.7.1.2 Anställningsvillkor |
| Nuläge | Organisatoriskt krav. |
| Gap | Inga tystnadspliktsavtal. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Tecknade avtal med anställda och underleverantörer. |

### 3507 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska för sin personal regelbundet genomföra utbildningar för ökad medvetenhet kring informationssäkerhet samt hålla sig uppdaterad kring beställarens policys, regler och rutiner. |
| Typ | SKA |
| ISO | A.7.2 Under anställning — A.7.2.2 Medvetenhet, utbildning och fortbildning vad gäller informationssäkerhet |
| Nuläge | Organisatoriskt krav. |
| Gap | Ingen säkerhetsutbildning. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Genomförd utbildning. |

### 3508 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha tydliga och kommunicerade åtgärder för överträdelse av informationssäkerhetsregler. |
| Typ | SKA |
| ISO | A.7.2 Under anställning — A.7.2.3 Disciplinär process |
| Nuläge | Organisatoriskt krav. |
| Gap | Ingen disciplinär process. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Fastställd process. |

### 3509 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska till personalen ha kommunicerat de ansvar och skyldigheter som förblir gällande efter ändring eller avslut av anställning. Personalen ska ha skrivit under en ansvarsförbindelse avseende detta. |
| Typ | SKA |
| ISO | A.7.3 Avslut eller ändring av anställning — A.7.3.1 Avslut eller ändring av anställds ansvar |
| Nuläge | Organisatoriskt krav. |
| Gap | Ingen offboardingprocess med ansvarsförbindelse. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Undertecknade ansvarsförbindelser. |

### 3510 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha dokumenterade regler, rutiner och roller som beskriver tillåten användning av de resurser som ingår i leveransen. Leverantören ska regelbundet kontrollera att de efterlevs. |
| Typ | SKA |
| ISO | A.8.1 Ansvar för tillgångar — A.8.1.3 Tillåten användning av tillgångar |
| Nuläge | AGENTS.md innehåller icke förhandlingsbara regler för utveckling. |
| Gap | Ingen policy för tillåten användning av driftresurser. |
| Lösning | Acceptable use policy plus efterlevnadskontroll. |
| Kodevidens | AGENTS.md |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Antagen policy och kontrollrutin. |

### 3511 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner och funktioner för att permanent radera information som är relaterade till leveransen. Leverantören ska på begäran kunna uppvisa underlag på att så skett. |
| Typ | BÖR |
| ISO | A.8.1 Ansvar för tillgångar — A.8.1.4 Återlämnande av tillgångar |
| Nuläge | Rutinen är körbar och inte bara dokumenterad: gallring och rättighetsbegäran om radering är två inkopplade jobbtyper med tillståndsmaskin, godkännande och rapport. Tidigare fanns rutinen som bibliotek utan anropare. |
| Gap | Ingen. |
| Lösning | RETENTION_EXECUTE och PRIVACY_REQUEST_EXECUTE med tillhörande migrationer och API-routes. |
| Kodevidens | apps/workers/src/retention-handlers.ts; apps/workers/src/privacy-handlers.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: gallrings- och privacy-sviterna mot riktig Postgres. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 3512 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska genomföra regelbundna riskbedömningar för systemet dock minst årligen. Identifierade brister ska åtgärdas omgående enligt en dokumenterad plan och ska kunna redovisas för beställaren. |
| Typ | SKA |
| ISO | A.8.2 Informationsklassning — A.8.2.1 Klassning av information |
| Nuläge | THREAT_MODEL.md finns men ingen återkommande riskbedömningsprocess. |
| Gap | Ingen årlig riskbedömning med åtgärdsplan. |
| Lösning | Rutin och mall för årlig riskbedömning. |
| Kodevidens | THREAT_MODEL.md |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Genomförd riskbedömning. |

### 3513 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Beställarens krav på informationshanteringen ska efterföljas. Om sådana krav inte uttryckligen ställts ska leverantören utan anmodan kunna uppvisa de rutiner som gäller hos leverantören. |
| Typ | SKA |
| ISO | A.8.2 Informationsklassning — A.8.2.3 Hantering av tillgångar |
| Nuläge | Kungälvs uttryckliga krav följs enligt den genererade kravmatrisen, där npm run verify misslyckas om ett krav saknar bedömning. Där kommunen inte uttryckligen ställt krav tillämpas den strängare av branschpraxis och egen policy — konkret bland annat personnummer krypterat med blind index i stället för klartext, no-referrer i stället för same-origin, WCAG 2.2 AA i stället för 2.0 AA som kravet anger, och radering som kräver verifierad borttagning i varje kopia i stället för enbart i primärlagret. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; docs/compliance/kungalv/REQUIREMENT_MATRIX.md; scripts/build-requirement-matrix.mjs |
| Verifiering | npm run verify:requirements misslyckas vid krav utan bedömning. |
| Status | PASS |

### 3514 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Det ska finnas en dokumenterad och formell process för hur användaridentiteter hanteras i systemet. Identiteterna ska vara personliga, unika över tid, samt verifieras kontinuerligt mot offentliga register såsom folkbokföringsregistret. Se tillitsramverket (ELN0700) tillitsnivå 3 (LoA3) för detaljer. |
| Typ | BÖR |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.1 Registrering och avregistrering av användare |
| Nuläge | Användaridentiteters livscykel är formaliserad i kod och schema i stället för enbart i text: SCIM-provisionering styr skapande, uppdatering, behörighetsändring och avaktivering, och app.scim_provisioning_events ger en granskningsbar logg per åtgärd. Manuell hantering utan katalog beskrivs i docs/operations/account-provisioning.md. |
| Gap | Ingen kodbrist. |
| Lösning | packages/scim, app.scim_provisioning_events, docs/operations/account-provisioning.md. |
| Kodevidens | packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql; docs/operations/account-provisioning.md |
| Verifiering | tests/run.mjs: fyra SCIM-tester. |
| Status | PASS |

### 3515 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska följa en överenskommen rutin som möjliggör för Beställaren att godkänna hantering (skapande, borttag, ändring) av utpekade behörighetsroller t ex avseende priviligierade (högre) behörigheter. Hanteringen ska vara spårbar och redovisas för Beställaren enligt överenskommelse, dock minst årligen. |
| Typ | BÖR |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.2 Tilldelning av användaråtkomst |
| Nuläge | Skapande, ändring och borttagning av användare sker antingen av kundens egen administratör eller genom SCIM från kundens katalog. Leverantören skapar inte konton åt kunden på eget initiativ. Rutinen är dokumenterad i docs/isms/SAKER_UTVECKLING.md avsnitt 5 och docs/operations/account-provisioning.md, och varje åtgärd loggas i app.scim_provisioning_events. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | tests/run.mjs: fyra SCIM-tester inklusive att provisioneringsklienten inte kan tilldela roller utanför sitt scope. |
| Status | PASS |

### 3516 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska använda särskilda personliga användaridentiteter för systemadministration. Dessa konton ska vara spårbara och lätta att skilja från vanliga användare. Beställaren ska informeras vid förändringar av vilka som innehar dessa behörigheter. |
| Typ | SKA |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.3 Hantering av privilegierade åtkomsträttigheter |
| Nuläge | Systemadministration sker med personliga, namngivna konton. Delade konton används inte, och administrativa konton är skilda från de konton samma person använder för vanligt arbete, så att en komprometterad vardagssession inte bär administrativ behörighet. Break glass-åtkomst är separat, tidsbegränsad och larmar vid användning. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; docs/system/BEHORIGHETSMODELL.md; migrations/control/0005_auth_domain_and_break_glass_runtime.sql |
| Verifiering | tests/run.mjs: behörighetstester och test att direkt organisationsskapande är reserverat för plattformssuperadmin. |
| Status | PASS |

### 3517 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska tillhandahålla ett sätt att distribuera och återställa lösenord utan att lösenordet kan röjas till obehöriga. Behörighetsinformation som t.ex. lösenord får ej lagras i klartext (gäller även systemkonton i källkod). Motsvarande krav gäller även för temporära filer som skapas i användarens arbetsstation när systemet används. Se vägledning för tillitsnivå 3 (LoA3) för detaljer. |
| Typ | SKA |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.4 Hantering av användares konfidentiella autentiseringsinformation |
| Nuläge | Lösenord distribueras aldrig i klartext, varken vid nytt konto eller vid återställning. Kommunsign skickar en engångslänk med kort giltighet till den registrerade e-postadressen och mottagaren sätter själv lösenordet. Kommunsign lagrar aldrig lösenord. Vid återställning avslöjar svaret aldrig om kontot finns, eftersom ett svar som skiljer sig åt gör återställningsflödet till ett verktyg för att kartlägga användare. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; packages/provider-adapters/src/supabase-auth.ts; docs/security/password-authentication.md |
| Verifiering | tests/run.mjs: test att lösenordsåterställning exponerar rate limits i stället för att rapportera ett falskt accepterat resultat, samt att en befintlig bekräftad identitet får ny länk först när lokal åtkomst finns. |
| Status | PASS |

### 3518 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Behörighetssystemet ska logga information om när användare skapades, togs bort eller förändrades samt senaste inloggning. |
| Typ | SKA |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.5 Granskning av användares åtkomsträttigheter |
| Nuläge | Behörighetssystemet loggar skapande, borttagning och förändring. app.scim_provisioning_events skrivs nu på riktigt av SCIM-ytan, med maskerad detalj och aldrig den råa katalogpayloaden — den bär attribut vi inte har någon anledning att spara. |
| Gap | Ingen. |
| Lösning | app.scim_provisioning_events skriven av scim-repository, plus audit.append_event för övriga behörighetsändringar. |
| Kodevidens | apps/api/src/production-adapters/postgres/scim-repository.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/scim-provisioning.sql kontrollerar att avprovisionering lämnar spår. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 3519 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha en rutin för att både avaktivera användarkonton och permanent ta bort konton från systemet. |
| Typ | BÖR |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.6 Borttagning eller justering av åtkomsträttigheter |
| Nuläge | Både avaktivering och permanent borttagning finns och är körbara. DELETE mot SCIM avaktiverar en användare med historik och tar bort roller i båda fallen — ett avprovisionerat konto ska sluta ge behörighet omedelbart, oavsett om raden står kvar. Historiken måste överleva avgången, annars får spåret hål exakt där en avgången medarbetare är inblandad. |
| Gap | Ingen. |
| Lösning | deprovisionScimUser i packages/scim, deleteUser i apps/api/src/scim-router.ts. |
| Kodevidens | apps/api/src/scim-router.ts; packages/scim/src/index.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: DELETE-test över båda grenarna. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 3520 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska för sin personal ha fastställda regler för hur autentiseringsinformation får hanteras. |
| Typ | SKA |
| ISO | A.9.3 Användaransvar — A.9.3.1 Användning av konfidentiell autentiseringsinformation |
| Nuläge | Organisatoriskt krav. |
| Gap | Inga fastställda regler för hantering av autentiseringsinformation. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Fastställda regler. |

### 3521 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantörens behörigheter ska tilldelas enligt principen där minsta möjliga behörighet tilldelas utifrån användares roll och arbetsuppgifter. Detta gäller även konton som används vid kommunikation mellan systemkomponenter, exempelvis mellan applikation och databas samt priviligierade konton. |
| Typ | SKA |
| ISO | A.9.4 Styrning av åtkomst till system och tillämpningar — A.9.4.1 Begränsning av åtkomst till information |
| Nuläge | Minsta möjliga behörighet är genomfört per aktörstyp: API-klienter får bara de scopes integrationen behöver, SCIM-klienter kan inte tilldela roller utanför sin assignable_roles, federationsmappning avvisar roller utanför tenantens assignableRoles, och leverantörspersonal har ingen stående åtkomst till kunddata. Modellen är dokumenterad i docs/system/BEHORIGHETSMODELL.md. |
| Gap | Ingen kodbrist. |
| Lösning | docs/system/BEHORIGHETSMODELL.md |
| Kodevidens | docs/system/BEHORIGHETSMODELL.md; packages/scim/src/index.ts; packages/federation/src/index.ts; packages/protected-identity/src/index.ts |
| Verifiering | tests/run.mjs: rollmappningstester som visar att en katalogadministratör inte kan eskalera bortom klientens scope, samt supportåtkomsttest. |
| Status | PASS |

### 3522 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Inloggningen ska vara flerfaktorsbaserad i enlighet med kraven som följer av ELN0700. Endast utfärdare godkända av E-legitimationsnämnden (minst nivå 3) eller anslutna inom eIDAS (minst nivå substantial) rekommenderas. Se vägledning för tillitsnivå 3 (LoA3) för detaljer. |
| Typ | BÖR |
| ISO | A.9.4 Styrning av åtkomst till system och tillämpningar — A.9.4.2 Säkra inloggningsrutiner |
| Nuläge | Inloggning sker via kommunens IdP där MFA hanteras. Kravet är BÖR. |
| Gap | Beror på MobilityGuard-konfigurationen som inte är verifierad. |
| Lösning | Kräv MFA i federationskonfigurationen. |
| Kodevidens | packages/auth/src/index.ts |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Kommunens IdP-konfiguration. |

### 3524 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska skydda och tillse att det finns spårbarhet i de verktyg som avses för underhåll av systemet, dess säkerhetskonfiguration och information. |
| Typ | SKA |
| ISO | A.9.4 Styrning av åtkomst till system och tillämpningar — A.9.4.4 Användning av privilegierade verktygsprogram |
| Nuläge | Underhållsverktygen har samma skydd och spårbarhet som tjänsten. Plattformspersonal saknar stående åtkomst till kunddata; åtkomst till skyddade personuppgifter kräver tidsbegränsat och motiverat samtycke per person utfärdat av kunden, och break glass-åtkomst är separat, tidsbegränsad och larmar vid användning. Alla administrativa åtgärder loggas med aktör, tenant och korrelation. |
| Gap | Ingen kodbrist. |
| Lösning | packages/protected-identity, packages/observability, docs/system/BEHORIGHETSMODELL.md. |
| Kodevidens | packages/protected-identity/src/index.ts; packages/observability/src/index.ts; docs/system/BEHORIGHETSMODELL.md |
| Verifiering | tests/run.mjs: test för supportåtkomst per person med utgång, samt spårbarhetstest för säkerhetshändelser. |
| Status | PASS |

### 3525 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Källkod framtagen i egen utveckling ska skyddas för obehöriga förändringar gentemot den godkända och fastställda versionen. Källkod ska deponeras på ett sådant sätt att beställaren garanteras tillgång om leverantören inte uppfyller sina avtalade förpliktelser. |
| Typ | SKA |
| ISO | A.9.4 Styrning av åtkomst till system och tillämpningar — A.9.4.5 Åtkomstkontroll till källkod för program |
| Nuläge | Källkoden ligger i git med FILE_MANIFEST.sha256 och PROVENANCE_REPORT.txt. Branch protection och deposition är inte verifierade. |
| Gap | Ingen källkodsdeposition (escrow). |
| Lösning | Branch protection, signerade releaser och escrow-avtal. |
| Kodevidens | FILE_MANIFEST.sha256; PROVENANCE_REPORT.txt; .github/workflows/ci.yml |
| Verifiering | scripts/verify-repository.mjs; scripts/check-provenance.mjs |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Escrow-avtal med tredje part. |

### 3526 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner för kryptering där val av algoritmer, protokoll och nyckellängder samt hantering av krypteringsnycklar framgår. |
| Typ | BÖR |
| ISO | A.10.1 Kryptografiska säkerhetsåtgärder — A.10.1.1 Regler för användning av kryptografiska säkerhetsåtgärder |
| Nuläge | Rutinen för kryptering finns och nyckelrotation är nu en operation som går att köra, följa och verifiera. Nio tabeller bär key_version, så frågan vilka rader som fortfarande ligger på den gamla nyckeln går att besvara — utan den var rotation en förhoppningsfull massuppdatering utan möjlighet att återuppta eller verifiera. Databasen vägrar markera en rotation verifierad medan någon kolumn fortfarande rapporterar utestående rader. |
| Gap | Ingen kodbrist. Själva rotationen är en operatörsåtgärd mot kundens KMS eller HSM. |
| Lösning | packages/crypto/src/key-rotation.ts (nyckelring och tillståndsmaskin), migrations/data/0029_key_rotation_backfill.sql (key_version, app.key_rotations, app.key_rotation_columns), docs/runbooks/KEY_ROTATION.md. |
| Kodevidens | migrations/data/0029_key_rotation_backfill.sql; docs/runbooks/KEY_ROTATION.md; packages/crypto/src/key-rotation.ts |
| Verifiering | npm run verify (138 tester), bash scripts/db-verify.sh mot riktig Postgres: tests/sql/key-rotation.sql, sju scenarier inklusive att en rotation utan registrerade kolumner inte kan rapportera sig verifierad. |
| Status | PASS |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 3527 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Om leverantörens anbud avser tjänst som driftas utanför Kungälvs Kommun gäller kravet: Datahallen uppfyller minst skyddsnivå 3 ("datahall" enligt MSB "Vägledning för fysisk informationssäkerhet i it-utrymmen") |
| Typ | SKA |
| ISO | A.11.1 Säkra områden — A.11.1.1 Fysiska säkerhetsavgränsningar |
| Nuläge | Drift sker hos molnleverantörer. |
| Gap | Ingen evidens för MSB skyddsnivå 3. |
| Lösning | Hämta leverantörsevidens eller migrera drift. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. Att en molnleverantör används är inte bevis för MSB-nivå 3. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens för datahallens fysiska skyddsnivå. |

### 3528 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Om leverantörens anbud avser tjänst som driftas utanför Kungälvs Kommun gäller kravet: Leverantören ska ha rutiner som säkerställer att endast behörig personal har fysisk åtkomst till datahall. |
| Typ | SKA |
| ISO | A.11.1 Säkra områden — A.11.1.2 Fysiska tillträdesbegränsningar |
| Nuläge | Fysisk åtkomst hanteras av hostingleverantören. |
| Gap | Ingen leverantörsevidens. |
| Lösning | Hämta evidens. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens för fysisk tillträdeskontroll. |

### 3529 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner avseende förändringshantering för de delar som kan påverka leveransens säkerhet och tillgänglighet. Leverantören ska vid anmodan redovisa sin process för beställaren. |
| Typ | SKA |
| ISO | A.12.1 Driftsrutiner och ansvar — A.12.1.2 Ändringshantering |
| Nuläge | Förändringshantering är dokumenterad i docs/isms/SAKER_UTVECKLING.md avsnitt 6: förslag, granskning, automatiserad verifiering, test i separat testmiljö, godkännande, utrullning och dokumentation. npm run verify är grinden och kör bygge, repositoryverifiering, deployment-konfiguration, migrationsverifiering, kravmatris, provenance, SDK-synk, tillgänglighet, hemlighetsskanning, Java-gränstjänster samt enhets-, integrations- och säkerhetstester. Ändringar som påverkar säkerhet eller bevisvärde kräver dessutom uttrycklig säkerhetsgranskning och negativa tester för den nya attackytan. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; package.json; AGENTS.md |
| Verifiering | npm run verify är obligatorisk grind och är grön. |
| Status | PASS |

### 3530 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha funktioner, processer och rutiner för att övervaka och göra prognoser avseende kapacitet och prestanda. |
| Typ | BÖR |
| ISO | A.12.1 Driftsrutiner och ansvar — A.12.1.3 Kapacitetshantering |
| Nuläge | Kapacitetsövervakning och prognos beskrivs i docs/operations/OVERVAKNING_OCH_INCIDENT.md avsnitt 4: ärende- och underskriftsvolym per tenant, lagrad datavolym, databas- och indexstorlek, ködjup, API-anrop per klient och e-postvolym mäts löpande och trendas månadsvis. Prognos görs kvartalsvis och åtgärd planeras när en resurs prognostiseras nå 70 procent av kapaciteten inom två kvartal, alltså innan den är full. |
| Gap | Ingen. |
| Lösning | docs/operations/OVERVAKNING_OCH_INCIDENT.md. |
| Kodevidens | docs/operations/OVERVAKNING_OCH_INCIDENT.md |
| Verifiering | Signalerna motsvarar de mätpunkter som finns i API:t och workers. |
| Status | PASS |

### 3531 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska testa samtliga leveranser i separat testmiljö innan de införs i Beställarens tjänst. Testdata ska skyddas och kontrolleras och får inte innehålla information som är känslig eller omfattas av sekretess. |
| Typ | SKA |
| ISO | A.12.1 Driftsrutiner och ansvar — A.12.1.4 Separation av utvecklings-, test och driftmiljöer |
| Nuläge | Samtliga leveranser testas i separat testmiljö före produktion, skild från produktion i nät, databaser, lagring och credentials. Produktionsdata kopieras inte till testmiljön; behövs realistisk volym genereras syntetiska data. Ett testdataset med riktiga personnummer vore en personuppgiftsbehandling utan rättslig grund, och testmiljöer har regelmässigt svagare skydd än produktion — vilket är hela problemet. Produktionsvägar kan inte använda testprovider, och identity-registry vägrar i produktion för varje metod som inte är produktionsklar. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; packages/identity-registry/src/index.ts; docs/architecture/environment-configuration.md |
| Verifiering | tests/run.mjs: test att identitetsregistret fail-closed i produktion för varje grind. |
| Status | PASS |

### 3532 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha ett skydd mot skadlig kod som uppdateras kontinuerligt för de delar som ingår i leveransen. |
| Typ | SKA |
| ISO | A.12.2 Skydd mot skadlig kod — A.12.2.1 Säkerhetsåtgärder mot skadlig kod |
| Nuläge | Uppladdade filer skannas med kontinuerligt uppdaterade signaturer före bearbetning. Endast PDF tas emot, kontrollerat på både MIME-typ och magiska bytes, och filer i karantän blir aldrig tillgängliga. PDF:er kanoniseras och aktivt innehåll tas bort innan dokumentet låses. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; packages/document-processing/src/index.ts; docs/architecture/document-processing-pipeline.md |
| Verifiering | tests/security.mjs täcker uppladdningsvalidering. npm run verify:container-health kontrollerar skannertjänsten. |
| Status | PASS |

### 3533 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Om leverantörens anbud avser tjänst som driftas utanför Kungälvs Kommun gäller kravet: Leverantören ska ha rutiner och funktioner för säkerhetskopiering och återställande av information enligt överenskomna tillgänglighetskrav med Beställaren. Säkerhetskopior ska skyddas på motsvarande sätt som originalinformationen samt förvaras åtskilt. |
| Typ | SKA |
| ISO | A.12.3 Säkerhetskopiering — A.12.3.1 Säkerhetskopiering av information |
| Nuläge | Samma mottagarsida som 2037: en lyckad backup kan rapporteras, lagras och skrapas. Vad som inte kan produceras här är evidensen för att backuperna faktiskt tas och går att återläsa. |
| Gap | Leverantörsevidens för backuprutinen och en genomförd restore-övning med dokumenterat utfall. |
| Lösning | migrations/control/0020_backup_signal.sql, apps/api/src/router.ts, apps/api/src/production-adapters/postgres/metrics-repository.ts. |
| Kodevidens | migrations/control/0020_backup_signal.sql; tests/sql/backup-signal.sql |
| Verifiering | bash scripts/db-verify.sh mot riktig Postgres: tests/sql/backup-signal.sql; npm run verify:e2e:application. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens för backuprutinen och en genomförd restore-övning med dokumenterat utfall. Rapporteringsvägen finns, men att en backup går att återläsa kan bara visas genom att någon återläser den. |
| Bedömningskälla | Override 2026-08-19: Ombedömning mot faktisk kod efter att signeringskedjan, de blockerade jobbtyperna, GDPR-, SCIM- och federationsruntime, leverans, observability och nyckelrotation färdigställts. Bedömningarna korrigeras i båda riktningarna: krav vars PASS byggde på ett bibliotek utan anropare har fått uppdaterad evidens där runtime nu finns, och krav där runtime fortfarande saknas eller där konformitet inte gått att verifiera har nedgraderats. PASS ges endast när implementation, databas, runtime, API och test finns tillsammans. Efter en andra omgång fick federationens ACS-route byggas färdigt, varpå 2079 går från PARTIAL till PASS, och OIDC-vägen byggdes färdigt ovanpå samma beslutslager. Efter go/no-go-arbetet: backup-signalens mottagarsida är byggd (2037, 3533 behåller BLOCKED_EXTERNAL men med annat kvarstående — ett anrop från driftplattformen i stället för en saknad integrationsdesign). |

### 3534 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Loggningsfunktioner ska finnas för säkerhetsrelaterade händelser, minst för felaktiga inloggningar, förändring av behörigheter, otillåten anslutning samt överträdelser av behörigheter. Tiden som logginformation sparas ska kunna bestämmas av Beställaren som också ska kunna genomföra granskning av användarrelaterade loggar. |
| Typ | SKA |
| ISO | A.12.4 Loggning och övervakning — A.12.4.1 Loggning av händelser |
| Nuläge | SECURITY_EVENTS är en explicit lista över de händelser som alltid loggas, vilket gör påståendet att säkerhetshändelser loggas till något kontrollerbart i stället för en avsikt. Listan täcker minst felaktiga inloggningar, lyckade inloggningar, lösenordsåterställning och lösenordsbyte, återkallad session, nekad behörighet, skapande, ändring, avaktivering och borttagning av användare, tilldelad och återkallad roll, korsande tenantförsök, åtkomst till skyddade personuppgifter, genomförd gallring, fullgjord rättighetsbegäran, nyckelrotation, samt ogiltig webhooksignatur. |
| Gap | Ingen. |
| Lösning | packages/observability: SECURITY_EVENTS, assertSecurityEventIsTraceable. |
| Kodevidens | packages/observability/src/index.ts |
| Verifiering | tests/run.mjs: test att säkerhetshändelser är spårbara till tenant och korrelation. |
| Status | PASS |

### 3535 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska skydda loggningsfunktioner och loggningsverktyg mot manipulation och obehörig åtkomst som även omfattar leverantörens personal. |
| Typ | SKA |
| ISO | A.12.4 Loggning och övervakning — A.12.4.2 Skydd av logginformation |
| Nuläge | Auditloggen är hashkedjad, så manipulation är detekterbar även för den som har skrivrättighet. Loggar bär aldrig lösenord, API-hemligheter, råa token, personnummer eller dokumentinnehåll, vilket framtvingas i kod och inte enbart i rutin. Metriketiketter är begränsade till en känd lågkardinalitetsmängd, eftersom en etikett som bär ett ärende-ID eller en e-postadress både förstör metrikbackenden och tyst gör metrikflödet till en omaskerad export av personuppgifter. Åtkomst till loggverktyg är behörighetsstyrd och loggas i sin tur. |
| Gap | Ingen. |
| Lösning | packages/audit (hashkedja), packages/observability (maskering, etikettkontroll), docs/operations/OVERVAKNING_OCH_INCIDENT.md avsnitt 6. |
| Kodevidens | packages/audit/src/index.ts; packages/observability/src/index.ts; docs/operations/OVERVAKNING_OCH_INCIDENT.md |
| Verifiering | tests/run.mjs: auditkedjetest, maskeringstest och test för säkra metriketiketter. |
| Status | PASS |

### 3536 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet och relaterad infrastruktur ska använda tidssynkronisering mot samma tidskälla (GPS eller svenska UTC (SP)). |
| Typ | SKA |
| ISO | A.12.4 Loggning och övervakning — A.12.4.4 Synkronisering av tid |
| Nuläge | Systemet använder UTC internt. |
| Gap | Ingen evidens för att infrastrukturen synkroniserar mot GPS eller svensk UTC(SP). |
| Lösning | Verifiera hostingleverantörens tidskälla. Om den inte kan styrkas krävs annan lösning. |
| Kodevidens | packages/contracts/src/index.ts |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens för tidssynkroniseringskälla. |

### 3537 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska verifiera och begränsa den mjukvara som får exekveras inom den levererade tjänsten |
| Typ | SKA |
| ISO | A.12.5 Styrning av driftsystem — A.12.5.1 Installation av program på driftsystem |
| Nuläge | Exekverbar kod i tjänsten begränsas till det som byggts ur repositoryt. Beroenden är pinnade med checksummor i lockfilen, provenance kontrolleras av npm run verify:provenance och en SBOM genereras med npm run sbom. Portalerna kör med strikt CSP utan unsafe-inline och unsafe-eval, och bygget misslyckas om inline-skript eller inline-stil dyker upp, så policyn och markupen kan inte glida isär. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; scripts/check-provenance.mjs; scripts/build-portals.mjs; packages/observability/src/index.ts |
| Verifiering | npm run verify:provenance rapporterar noll overifierade importer. scripts/build-portals.mjs bryter bygget vid inline-skript. |
| Status | PASS |

### 3538 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska utan dröjsmål informera beställaren om tekniska sårbarheter i levererade komponenter. Upptäckta sårbarheter ska åtgärdas omgående. |
| Typ | SKA |
| ISO | A.12.6 Hantering av tekniska sårbarheter — A.12.6.1 Hantering av tekniska sårbarheter |
| Nuläge | Sårbarhetshantering är dokumenterad i docs/isms/SAKER_UTVECKLING.md avsnitt 9 med bedömning utifrån faktisk exponering i Kommunsign och inte enbart CVSS, samt åtgärds- och informationstider per allvarlighetsnivå. Kunden informeras utan dröjsmål vid kritisk och hög allvarlighet, även innan åtgärden är klar, eftersom kommunen kan behöva vidta egna åtgärder under tiden. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; SBOM.cdx.json; scripts/check-provenance.mjs |
| Verifiering | Beroenden skannas vid varje bygge. SBOM genereras med npm run sbom. |
| Status | PASS |

### 3539 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | All kommunikation till och från systemet ska vara skyddad mot obehörig åtkomst eller förvanskning. Det gäller både kommunikation mellan klient och server och mellan olika systemkomponenter. Skyddet ska uppdateras löpande utifrån kända sårbarheter. |
| Typ | SKA |
| ISO | A.13.1 Hantering av nätverkssäkerhet — A.13.1.1 Säkerhetsåtgärder för nätverk |
| Nuläge | Samma skydd som krav 2019, och det gäller även mellan interna komponenter: gränstjänsterna nås över mTLS, providerhemligheter hämtas via secret references och webhookleveranser signeras med HMAC och tidsstämpelfönster mot replay. |
| Gap | Ingen. |
| Lösning | packages/observability, packages/webhooks, services/* över mTLS. |
| Kodevidens | packages/observability/src/index.ts; packages/webhooks/src/index.ts; docs/integration/freja.md |
| Verifiering | tests/run.mjs: headertest samt HMAC-, tidsfönster- och webhookbindningstest. |
| Status | PASS |

### 3540 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Om leverantörens anbud avser tjänst som driftas utanför Kungälvs Kommun gäller kravet: Leverantören ska tillhandahålla en (logisk eller fysiskt) separerad kundmiljö inklusive behörighetskontrollsystem, loggar och lagring för varje kund. |
| Typ | SKA |
| ISO | A.13.1 Hantering av nätverkssäkerhet — A.13.1.3 Separation av nätverk |
| Nuläge | Kommunikationen till och från den externt driftade tjänsten är krypterad enligt TLS_POLICY med minst TLS 1.2 och forward secrecy, HSTS i produktion, och upgrade-insecure-requests i CSP. Cacheklassificering säkerställer att autentiserade svar aldrig kan serveras av en mellanliggande cache till fel användare: Vary på Cookie och Authorization sätts på samtliga privata klasser, eftersom just den saknade headern räcker för ett läckage över tenantgräns. |
| Gap | Ingen. |
| Lösning | packages/observability: TLS_POLICY, securityHeaders, cacheHeaders. |
| Kodevidens | packages/observability/src/index.ts |
| Verifiering | tests/run.mjs: headertest inklusive Vary på varje privat cacheklass. |
| Status | PASS |

### 3541 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Beställaren ska godkänna alla informationsutbyten som sker med andra system |
| Typ | SKA |
| ISO | A.13.2 Informationsöverföring — A.13.2.1 Regler och rutiner för informationsöverföring |
| Nuläge | Informationsutbyten med andra system godkänns av kunden innan de aktiveras: en integration kräver en API-klient som kunden själv skapar och scopar, en webhookprenumeration kräver en endpoint kunden själv registrerar, och federation och provisionering kräver konfiguration från kunden. Ingen väg ut ur systemet öppnas utan att kunden vidtagit en aktiv åtgärd. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; docs/integration/API_INTEGRATION.md; packages/webhooks/src/index.ts |
| Verifiering | tests/run.mjs: webhook-HMAC- och bindningstester. tests/security.mjs täcker SSRF och domänvalidering. |
| Status | PASS |

### 3543 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha fastlagda och dokumenterade principer och metoder för utveckling av säkra system. Vid webbutveckling ska OWASP:s (www.owasp.org) rekommendationer följas. |
| Typ | SKA |
| ISO | A.14.1 Säkerhetskrav på informationssystem — A.14.1.1 Analys och specifikation av informationssäkerhetskrav |
| Nuläge | Principerna för säker utveckling är dokumenterade i docs/isms/SAKER_UTVECKLING.md avsnitt 1 och verkställda i kod och bygge snarare än enbart beskrivna: fail closed, servern äger tillstånd, tenant kommer aldrig ur ett fritt requestfält, och ingen egen kryptografi. Webbutveckling följer OWASP ASVS nivå 2 som referens, och attackytorna testas negativt i tests/security.mjs. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; AGENTS.md; docs/architecture/adr/0003-signing-backend-dependency-policy.md; tests/security.mjs |
| Verifiering | tests/security.mjs täcker SSRF, domäner, uppladdning, inbjudningar och OIDC. tests/run.mjs täcker fail-closed och tenantbindning. |
| Status | PASS |

### 3544 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha genomfört säkerhetsåtgärder mot obehörig åtkomst samt obehörig ändring av information som systemet utbyter med andra. |
| Typ | SKA |
| ISO | A.14.1 Säkerhetskrav på informationssystem — A.14.1.2 Säkerställande av programtjänster på publika nätverk |
| Nuläge | Säkerhetsåtgärder mot obehörig åtkomst och obehörig ändring finns i flera lager: tenantkontext som aldrig kommer från ett fritt requestfält, RLS med FORCE på varje tenantbunden tabell, composite foreign keys som bär tenant_id över varje relation, applikationsauktorisering, serverstyrda statusövergångar som klienten aldrig kan sätta, immutabla slutliga dokument, hashkedjad auditlogg och säkerhetsheaders som stänger clickjacking, MIME-sniffing och referrerläckage. |
| Gap | Ingen. |
| Lösning | packages/tenant-context, packages/authorization, packages/observability, migrations/data/0005_rls.sql och 0009, 0010. |
| Kodevidens | packages/observability/src/index.ts; packages/tenant-context/src/index.ts; migrations/data/0009_integrity_and_worker_recovery.sql; migrations/data/0010_immutability_and_evidence_states.sql |
| Verifiering | tests/run.mjs: headertest, tenantkälltest, statusövergångstest och immutabilitetstest. tests/security.mjs täcker attackytorna. |
| Status | PASS |

### 3545 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha riktlinjer för informationssäkerhet inom sina utvecklingsprocesser. Vid större ändringar ska leverantören identifiera och hantera risker som säkerställer att säkerhetskraven i systemet är uppfyllda. |
| Typ | SKA |
| ISO | A.14.2 Säkerhet i utvecklings- och supportprocesser — A.14.2.2 Rutiner för hantering av systemändringar |
| Nuläge | Riktlinjerna för informationssäkerhet i utvecklingsprocessen står i docs/isms/SAKER_UTVECKLING.md avsnitt 1 och 6. Vid större ändringar krävs uttrycklig säkerhetsgranskning och negativa tester för den nya attackytan enligt AGENTS.md definition av en säker förändring. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; AGENTS.md; THREAT_MODEL.md |
| Verifiering | npm run verify är obligatorisk grind. AGENTS.md definierar när en förändring är klar. |
| Status | PASS |

### 3546 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner för att granska och testa tillgänglighet och säkerhet av ändringar i verksamhetskritiska driftsplattformar. |
| Typ | SKA |
| ISO | A.14.2 Säkerhet i utvecklings- och supportprocesser — A.14.2.3 Teknisk granskning av tillämpningar efter ändringar i driftsmiljö |
| Nuläge | Rutinen för att granska och testa ändringar står i docs/isms/SAKER_UTVECKLING.md avsnitt 6. Tillgänglighet verifieras av npm run verify:accessibility mot WCAG 2.2 AA, och säkerhet av tests/security.mjs samt de negativa testerna i tests/run.mjs. Båda är obligatoriska steg i npm run verify och inte valfria kontroller. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/SAKER_UTVECKLING.md |
| Kodevidens | docs/isms/SAKER_UTVECKLING.md; scripts/check-accessibility.mjs; tests/security.mjs |
| Verifiering | npm run verify:accessibility och tests/security.mjs ingår i npm run verify. |
| Status | PASS |

### 3547 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha riktlinjer och instruktioner om Beställaren avser att göra egna förändringar i programpaket. |
| Typ | SKA |
| ISO | A.14.2 Säkerhet i utvecklings- och supportprocesser — A.14.2.4 Restriktioner för ändringar av programpaket |
| Nuläge | docs/operations/KUNDENS_EGNA_FORANDRINGAR.md anger vad kunden själv råder över (signaturpolicyer, roller, gruppmappning, gallringsregler, grafisk profil, egen domän, API-klienter, webhooks), vad kunden inte ska ändra själv och varför (schema, RLS, migrationer och gränstjänster bär tenantisoleringen och bevisvärdet), samt processen för ändringsbegäran. Riktlinjerna täcker även integrationer kunden bygger själv mot det publika API:t. |
| Gap | Ingen. |
| Lösning | docs/operations/KUNDENS_EGNA_FORANDRINGAR.md. |
| Kodevidens | docs/operations/KUNDENS_EGNA_FORANDRINGAR.md; docs/system/BEHORIGHETSMODELL.md |
| Verifiering | Riktlinjerna motsvarar den faktiska behörighetsmodellen och de gränser som testas i tests/run.mjs. |
| Status | PASS |

### 3548 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantörens ansvar omfattar även underleverantörer. Underleverantörer ska godkännas av beställaren.Leverantören ska lista sina underleverantörer i anbudet som kommentar till detta krav. |
| Typ | SKA |
| ISO | A.15.1 Informationssäkerhet i leverantörsrelationer — A.15.1.1 Informationssäkerhetsregler för leverantörsrelationer |
| Nuläge | Samma som 2030. |
| Gap | Samma som 2030. |
| Lösning | Samma som 2030. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Underbiträdesförteckning och kommunens godkännande. |

### 3549 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha dokumenterade rutiner för övervakning, upptäckt, analys, rapportering, eskalering och hantering av säkerhetshändelser och säkerhetsincidenter. |
| Typ | SKA |
| ISO | A.16.1 Hantering av informationssäkerhetsincidenter och förbättringar — A.16.1.1 Ansvar och rutiner |
| Nuläge | docs/operations/OVERVAKNING_OCH_INCIDENT.md dokumenterar övervakning, upptäckt, analys, rapportering och eskalering. Övervakningen mäter utfall och inte bara svar: en signeringstjänst kan svara 200 på varje anrop medan ingen underskrift blir klar, och därför larmar systemet på påbörjade underskrifter utan slutförande, ködjup, providerfel och valideringsfel — inte bara på HTTP-status. Eskaleringen har fyra nivåer med första svarstid och rapporteringskadens, och personuppgiftsincident har egen väg med underlag i tid för kommunens anmälan till IMY. |
| Gap | Ingen. |
| Lösning | docs/operations/OVERVAKNING_OCH_INCIDENT.md, packages/readiness, befintliga runbooks under docs/runbooks. |
| Kodevidens | docs/operations/OVERVAKNING_OCH_INCIDENT.md; packages/readiness/src/index.ts; docs/runbooks/tic-outage.md |
| Verifiering | tests/run.mjs: readiness-test som skiljer blockerande fel, varningar och genomförda kontroller. |
| Status | PASS |

### 3550 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska tillsammans med utpekad roll hos Beställaren samverka i hanteringen av sårbarheter, säkerhetshändelser eller säkerhetsincidenter. |
| Typ | SKA |
| ISO | A.16.1 Hantering av informationssäkerhetsincidenter och förbättringar — A.16.1.4 Bedömning av och beslut om informationssäkerhetshändelser |
| Nuläge | Samma som 2027. |
| Gap | Samma som 2027. |
| Lösning | Samma som 2027. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Utpekad roll hos Kungälv. |

### 3551 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner för att hantera säkerhetsincidenter enligt gällande lagar och förordningar. |
| Typ | SKA |
| ISO | A.16.1 Hantering av informationssäkerhetsincidenter och förbättringar — A.16.1.5 Hantering av informationssäkerhetsincidenter |
| Nuläge | Rutinen för säkerhetsincidenter står i docs/operations/OVERVAKNING_OCH_INCIDENT.md avsnitt 3 med omgående första svar, löpande rapportering och efteranalys som letar systemfel och inte personfel. Vid personuppgiftsincident kontaktas kundens utpekade roll utan onödigt dröjsmål med underlag som räcker för kommunens egen anmälan till IMY inom 72 timmar; Kommunsign anmäler inte i kommunens ställe eftersom kommunen är personuppgiftsansvarig. |
| Gap | Ingen kodbrist. |
| Lösning | docs/operations/OVERVAKNING_OCH_INCIDENT.md, docs/runbooks/*. |
| Kodevidens | docs/operations/OVERVAKNING_OCH_INCIDENT.md; docs/runbooks/domain-incident.md; docs/runbooks/tic-outage.md |
| Verifiering | Rutinen refererar de faktiska larmsignalerna och readiness-kontrollerna. |
| Status | PASS |

### 3552 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha reservrutiner, reservlösningar och återstartsplaner som uppfyller beställarens krav på tillgänglighet (SLA). |
| Typ | BÖR |
| ISO | A.17.1 Kontinuitet för informationssäkerhet — A.17.1.2 Införa kontinuitet för informationssäkerhet |
| Nuläge | docs/isms/KONTINUITET.md anger RPO 15 minuter, RTO 4 timmar och 90 dagars bevarandetid, kontinuerlig arkivering av transaktionsloggen för återställning till godtycklig tidpunkt, samt kvartalsvis full återställningstest till isolerad miljö — en återställning som aldrig provats är en hypotes. Testet omfattar att ett bevispaket från före återställningen fortfarande validerar. Reservlösningar per bortfall är dokumenterade, och genomgående gäller att ett bortfall leder till att en operation vägras och aldrig till att den genomförs med svagare garantier. |
| Gap | Ingen kodbrist. |
| Lösning | docs/isms/KONTINUITET.md |
| Kodevidens | docs/isms/KONTINUITET.md; docs/operations/backup-and-restore.md; apps/workers |
| Verifiering | tests/run.mjs: workertest för lease-semantik och återupptagning efter avbrott. |
| Status | PASS |

### 3554 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska löpande och i samråd med Beställaren arbeta för att leveransen i alla lägen följer de aktuella lagar, förordningar, regler och föreskrifter som ställs på Beställarens verksamhet |
| Typ | SKA |
| ISO | A.18.1 Efterlevnad av juridiska och avtalsmässiga krav — A.18.1.1 Identifiering av tillämplig lagstiftning och avtalsmässiga krav |
| Nuläge | Avtals- och förvaltningsfråga. |
| Gap | Ingen teknisk komponent. |
| Lösning | Ingen. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Avtalad förvaltningsprocess. |

### 3555 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Om leverantören behandlar personuppgifter i systemet ska Beställaren upprätta biträdesavtal med leverantören avseende personuppgiftsbiträde samt sekretessförbindelse innan avtalet träder i kraft. |
| Typ | SKA |
| ISO | A.18.1 Efterlevnad av juridiska och avtalsmässiga krav — A.18.1.4 Skydd av personlig integritet och personuppgifter |
| Nuläge | Bilaga 4 är personuppgiftsbiträdesavtalet. DATA_PROCESSING.md beskriver behandlingen. |
| Gap | Avtalet är inte tecknat. |
| Lösning | Ingen teknisk komponent. |
| Kodevidens | DATA_PROCESSING.md |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Tecknat personuppgiftsbiträdesavtal och sekretessförbindelse. |

### 3556 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Beställaren ska i samråd med leverantören ha rätt att genomföra säkerhetsrevisioner av ingående delar i leveransen. |
| Typ | SKA |
| ISO | A.18.2 Granskningar av informationssäkerhet — A.18.2.3 Granskning av teknisk efterlevnad |
| Nuläge | Ingen revisionsprocess avtalad. |
| Gap | Ingen rutin för säkerhetsrevision. |
| Lösning | docs/security/PENTEST_SCOPE.md plus revisionsrutin. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Avtalad revisionsrätt och genomförd revision. |

### 3557 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska begära tillstånd innan information i systemet (texter, bilder etc) återanvänds i andra sammanhang. |
| Typ | SKA |
| ISO | A.18.1 Efterlevnad av juridiska och avtalsmässiga krav — A. 18.1.2 Immateriella rättigheter |
| Nuläge | Organisatoriskt krav. |
| Gap | Ingen rutin för tillstånd före återanvändning av information. |
| Lösning | Policy som förbjuder återanvändning utan tillstånd, inklusive förbud mot att skicka kunddata till externa AI- eller utvecklingsverktyg. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Antagen policy. |

