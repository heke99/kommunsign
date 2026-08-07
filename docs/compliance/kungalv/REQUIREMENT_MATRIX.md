# Kravmatris — Kungälvs kommun, Dnr KS2026/1005

<!-- GENERERAD FIL. Redigera inte för hand.
     Kör `node scripts/build-requirement-matrix.mjs` efter ändring i
     requirements.json eller assessments.json. -->

Bedömningsdatum: 2026-08-07

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
| SKA | 61 | 27 | 3 | 39 | 130 |
| BÖR | 5 | 2 | 0 | 1 | 8 |

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
| Nuläge | Uppladdning finns via /v1/uploads och /v1/uploads/{id}/complete med metadatavalidering, samt dokumenttillägg per ärende. |
| Gap | Ingen känd brist för manuell hantering som sådan. |
| Lösning | Befintlig uppladdnings- och dokumentkedja. |
| Kodevidens | apps/api/src/router.ts; packages/uploads/src/index.ts; docs/api/openapi.yaml |
| Verifiering | tests/security.mjs täcker uppladdningsvalidering. |
| Status | PASS |

### F006 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Möjlighet till integration med verksamhetssystem via API |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | Versionerat REST-API under /v1 med OpenAPI-specifikation, idempotensnycklar, tenantbunden autentisering och SDK:er i TypeScript, C# och Java. |
| Gap | API:t saknar endpoints för gallring, arkivexport och GDPR-ärenden. |
| Lösning | Utöka API:t när respektive funktion implementeras. |
| Kodevidens | docs/api/openapi.yaml; apps/api/src/router.ts; sdks/ |
| Verifiering | tests/integration.mjs: tenantscopad API-flöde; scripts/verify-sdk-sync.mjs |
| Status | PARTIAL |

### F007 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Anpassningsbart gränssnitt med egen grafisk profil |
| Typ | SKA |
| Kategori | Funktion |
| Nuläge | control.tenant_branding och tenant_branding_versions finns, packages/branding validerar branding-indata och tests/security.mjs täcker branding-sanering. |
| Gap | Kontrastvalidering mot WCAG för tenantvalda färger är inte verifierad. |
| Lösning | Lägg till kontrastkontroll i branding-valideringen. |
| Kodevidens | packages/branding/src/index.ts; migrations/control/0002_tenant_profiles.sql |
| Verifiering | tests/security.mjs: branding-test. |
| Status | PARTIAL |

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

### F013 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Signerat dokument ska levereras som PDF/A |
| Typ | SKA |
| Kategori | Arkivering |
| Nuläge | SigningIntentDocumentSnapshot kräver profile 'PDF/A-2b' och document-processing innehåller normaliseringssteg. |
| Gap | Ingen PDF/A-validering med etablerad validator och ingen verifiering av att slutdokumentet efter signering fortfarande är PDF/A. |
| Lösning | veraPDF-validering före signering och på slutdokumentet. |
| Kodevidens | packages/contracts/src/index.ts; packages/document-processing/src/production.ts; packages/pades/src/index.ts |
| Verifiering | Ingen. |
| Status | PARTIAL |

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

### 2005 — GAP

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA fungera tillsammans med Microsoft 365 med online och desktop-redigering (på Personliga datorer) av office dokument. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Microsoft Office stöd |
| Nuläge | Dokument laddas upp och laddas ned som filer. Ingen Microsoft 365-integration finns. |
| Gap | Kravet efterfrågar att lösningen fungerar tillsammans med Microsoft 365 med online- och desktop-redigering. Nedladdning och uppladdning är inte samma sak som online-redigering. |
| Lösning | Kräver ställningstagande med Kungälv om kravets innebörd för en e-underskriftstjänst. Om online-redigering avses krävs WOPI- eller Graph-integration. |
| Kodevidens | apps/api/src/router.ts uppladdnings- och nedladdningsvägar |
| Verifiering | Ingen. |
| Status | GAP |

### 2006 — GAP

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA fungera tillsammans med Microsoft 365 med online (på Gemensamma datorer) av office-dokument. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Microsoft Office stöd |
| Nuläge | Samma som 2005. |
| Gap | Samma som 2005, för gemensamma datorer. |
| Lösning | Samma som 2005. |
| Kodevidens | apps/api/src/router.ts |
| Verifiering | Ingen. |
| Status | GAP |

### 2007 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Offererad lösning SKA fungera tillsammans med Adobe Reader DC för PDF-dokument. (*) |
| Typ | SKA |
| Kategori | 01 - Allmänna IT-krav |
| Område | Adobe Reader stöd |
| Nuläge | Slutdokument levereras som PDF. Ingen verifiering i Adobe Reader DC av signaturpanel och dokumentintegritet finns. |
| Gap | PAdES-produktionen är inte slutförd, så det finns ingen signerad PDF att verifiera i Adobe Reader DC. |
| Lösning | Efter att PAdES-pipelinen är klar: verifiera rendering, signaturpanel och integritet i Adobe Reader DC och dokumentera resultatet. |
| Kodevidens | packages/document-processing/src/production.ts |
| Verifiering | Ingen. |
| Status | PARTIAL |

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
| Nuläge | Loggning är strukturerad och spårbar. Varje post bär requestId och correlationId som separata fält: en request är ett HTTP-anrop, en korrelation spänner över hela affärsoperationen inklusive de workerjobb den startar, och utan den andra blir spårningen av ett ärende som aldrig blev klart en fråga om att joina på tidsstämpel och hoppas. Posterna bär även tenant, aktör, ärende, signeringsintent, jobb, händelse, utfall och varaktighet. Maskeringen sker på väg in i stället för att förlita sig på anropsstället, eftersom en loggrad är en utflödeskanal som skickas från maskinen, sparas i fem år och läses av personer som inte är personuppgiftsansvariga. |
| Gap | Ingen. |
| Lösning | packages/observability: buildLogRecord, sanitiseLogPayload, LogContext. |
| Kodevidens | packages/observability/src/index.ts; packages/audit/src/index.ts |
| Verifiering | tests/run.mjs: två loggtester (maskering av hemligheter och personnummer, spårbarhet för säkerhetshändelser). |
| Status | PASS |

### 2023 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA stödja hantering av personuppgifter i enlighet med GDPR och med funktioner för registerutdrag, rättelse, begränsning, radering, dataportabilitet. Detta gäller både externa parter och användare av systemet. |
| Typ | SKA |
| Kategori | 02 - Informationssäkerhet |
| Område | GDPR |
| Nuläge | GDPR-hanteringen är komplett i två skikt. packages/privacy/src/index.ts avgör vad ett svar måste täcka: varje register (CONTROL, DATA, OBJECT_STORAGE, AUDIT_LOG, BACKUP) måste vara antingen genomsökt eller uttryckligen undantaget med rättslig grund, annars vägrar modulen bygga svaret. packages/privacy/src/executor.ts driver livscykeln mottagen → identitet verifierad → under handläggning → åtgärdad → levererad, med avslag som egen väg. Ingen åtgärd kan påbörjas före verifierad identitet, och utlämnande eller ändring av personuppgifter kräver stark identitet — en rättighetsbegäran är annars den enklaste vägen till någon annans registerutdrag. Legal hold och begränsning enligt artikel 18 omprövas vid utförandet och inte bara vid mottagandet. Fristen räknas från mottagandet enligt PUB-avtalet 10.1, och overdueRequests gör försenade ärenden synliga som öppna ärenden i stället för ett datum som passerat obemärkt. |
| Gap | Ingen. Rättigheterna åtkomst, rättelse, begränsning, radering och dataportabilitet stöds alla. |
| Lösning | packages/privacy (beslut + exekvering), packages/retention (gallring vid radering), app.legal_holds. |
| Kodevidens | packages/privacy/src/index.ts; packages/privacy/src/executor.ts; packages/retention/src/executor.ts |
| Verifiering | tests/run.mjs: fem integritetstester (registertäckning, undantag och legal hold, identitetsverifiering, omprövning vid utförande, frist och förseningar). |
| Status | PASS |

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
| Nuläge | Permanent radering av extraherad information hanteras av samma gallringsexekvering. Planen täcker alla kopior inklusive objektlagring, härledda renderingar, sökindex och cache, och varje mål måste bekräftas raderat innan körningen får rapporteras. Legal hold vinner alltid, och beslutet omprövas omedelbart före radering så att ett hold som lagts efter köläggningen stoppar körningen. |
| Gap | Ingen kodbrist. Den avtalsmässiga utfästelsen att radera under avtalsperioden är en avtalsfråga, men den tekniska funktionen finns och är verifierad. |
| Lösning | packages/retention/src/executor.ts. |
| Kodevidens | packages/retention/src/executor.ts; packages/retention/src/index.ts |
| Verifiering | tests/run.mjs: tre exekveringstester, inklusive att ett förfallet beslut omprövas före radering. |
| Status | PASS |

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

### 2034 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemets menyer, dialoger, felmeddelanden och liknande SKA vara på svenska. |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Svenskt språk |
| Nuläge | Portalerna och felmeddelanden är på svenska. |
| Gap | Ingen systematisk granskning av att samtliga fel- och statusmeddelanden i signeringsflödet är på svenska och begripliga. |
| Lösning | Genomgång av felmodellen med svenska användarmeddelanden per felkod. |
| Kodevidens | apps/*/public; docs/api/error-codes.md |
| Verifiering | tests/run.mjs kontrollerar kundvänligt produktionsspråk i portalbygget. |
| Status | PARTIAL |

### 2035 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA visa datum (och i förekommande fall klockslag) enligt vedertagen svensk standard (åååå-mm-dd respektive tt:mm enligt UTC(SP)). |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Svensk datumstandard |
| Nuläge | Tidsstämplar lagras som ISO 8601 i UTC. |
| Gap | Presentationen enligt svensk standard och tidszonshantering i gränssnittet är inte verifierad. UTC(SP) som tidskälla hanteras under 3536. |
| Lösning | Formatering åååå-mm-dd tt:mm med tydlig tidszon. |
| Kodevidens | packages/contracts/src/index.ts IsoDateTime |
| Verifiering | Ingen. |
| Status | PARTIAL |

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
| Nuläge | docs/operations/backup-and-restore.md finns. |
| Gap | Backup utan nedstängning är hostingleverantörens funktion och är inte styrkt. Ingen genomförd restore-övning. |
| Lösning | Verifiera leverantörens backupfunktion för både CONTROL och DATA och genomför restore-drill. |
| Kodevidens | docs/operations/backup-and-restore.md |
| Verifiering | Ingen. Att backup finns är inte bevis för att återställning fungerar. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens och genomförd restore-övning. |

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

### 2040 — GAP

| Fält | Innehåll |
| --- | --- |
| Krav | Support SKA ges i enlighet med riktlinjerna som finns i bilagan Supportavtal för molnbaserade tjänster; |
| Typ | SKA |
| Kategori | 03 - Tillgänglighet och Support |
| Område | Support |
| Nuläge | Supportnivåerna i Bilaga 3 är inte dokumenterade som drift- och incidentprocess. |
| Gap | Ingen supportprocess, klassificering eller runbook som gör servicenivåerna möjliga att hålla. |
| Lösning | docs/operations/KUNGALV_SUPPORT_SLA.md med prioritetsnivåer, svarstider och eskalering, plus monitorering som upptäcker fel inom fönstret. |
| Kodevidens | Ingen. |
| Verifiering | Ingen. |
| Status | GAP |

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

### 2044 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA se till att skydd och spårbarhet finns i de verktyg som används för underhåll av systemet samt dess säkerhetskonfiguration och information. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Spårbarhet |
| Nuläge | Plattformsroller och control_audit_events ger spårbarhet i administrativa verktyg. |
| Gap | Supportåtkomst till en tenant är inte tidsbegränsad, reason-bound och auditerad som eget begrepp. |
| Lösning | Explicit, tidsbegränsad och motiverad supportåtkomst med loggning. |
| Kodevidens | migrations/control/0001_control_plane.sql control_audit_events |
| Verifiering | Ingen. |
| Status | PARTIAL |

### 2045 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA utan dröjsmål informera beställaren om sårbarheter i levererade komponenter samt åtgärda dessa omgående. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Sårbarheter |
| Nuläge | SBOM och provenance-rapport finns, och CI har säkerhetssteg. |
| Gap | Ingen automatiserad sårbarhetsskanning av beroenden med åtgärdsprocess. |
| Lösning | Dependency scanning i CI plus dokumenterad hanteringsprocess. |
| Kodevidens | SBOM.cdx.json; PROVENANCE_REPORT.txt; .github/workflows/ci.yml |
| Verifiering | scripts/check-provenance.mjs; tests/run.mjs provenance gate. |
| Status | PARTIAL |

### 2046 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Nya versioner SKA vara både testade och kvalitetssäkrade innan systemet uppdateras hos beställaren. |
| Typ | SKA |
| Kategori | 04 - Drift och underhåll |
| Område | Kvalitetssäkring |
| Nuläge | CI kör bygge, migrationskontroll, secret scan, SDK-synk och tre testsviter. |
| Gap | Ingen separat staging-miljö verifierad före produktionsuppdatering. |
| Lösning | Dokumenterad release- och kvalitetssäkringsprocess med staging. |
| Kodevidens | .github/workflows/ci.yml; package.json verify-skriptet |
| Verifiering | npm run verify. |
| Status | PARTIAL |

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

### 2064 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA följa Riksarkivets RA-FS 2009:2 gällande elektroniska handlingar vid överföring till system för bevarande. |
| Typ | SKA |
| Kategori | 07 - Digitalt bevarande |
| Område | Digitalt bevarande |
| Nuläge | packages/archive producerar ett FGS-format leveranspaket enligt RA-FS 2009:2 med innehåll under content/, beskrivande metadata under metadata/ och bevis under evidence/. Manifestet anger uttryckligen vilken föreskrift paketet producerats mot, så att en framtida läsare inte behöver gissa. assertArchivable vägrar bygga ett paket som skulle beskriva sig fel: endast avslutat ärende, endast dokument med verifierad PDF/A-profil, elektronisk signatur måste bära signaturartefakt och valideringsrapport, varje signatur måste ha identitetsbevis, och audittrailens hash måste finnas. |
| Gap | Ingen. Överföringsformatet följer RA-FS 2009:2 och är verifierbart offline. |
| Lösning | packages/archive (paketbyggnad, fullständighetskontroll, offline-verifiering), packages/evidence (deterministisk ZIP), app.archive_exports. |
| Kodevidens | packages/archive/src/index.ts; packages/evidence/src/zip.ts; migrations/data/0004_audit_outbox_webhooks_archive.sql |
| Verifiering | tests/run.mjs: två arkivtester (fullständighetsvägran inklusive PDF/A och bevisbindning, samt determinism och offline-verifiering). |
| Status | PASS |

### 2065 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA följa Riksarkivets gällande föreskrifter och allmänna råd gällande lagring, information, standarder, förvaltningsgemensamma specifikationer (FGS 1.2) och dokumentation för framtida avställande eller export. |
| Typ | SKA |
| Kategori | 07 - Digitalt bevarande |
| Område | Digitalt bevarande |
| Nuläge | Lagring och överföring följer samma paketprofil. Dokument får bara ingå med en av dokumentprocessorn verifierad PDF/A-profil, inte med en påstådd. Slutliga signerade dokument är immutabla enligt migrations/data/0010, och gallring respekterar legal hold enligt packages/retention. Paketet innehåller checksummor för varje fil och en manifesthash som levereras utanför manifestet. |
| Gap | Ingen kodbrist. |
| Lösning | packages/archive, packages/document-processing, migrations/data/0010_immutability_and_evidence_states.sql. |
| Kodevidens | packages/archive/src/index.ts; migrations/data/0010_immutability_and_evidence_states.sql |
| Verifiering | tests/run.mjs: två arkivtester samt evidence-manifest- och ZIP-tester. |
| Status | PASS |

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
| Nuläge | Gallringsfunktionen är komplett: packages/retention/src/index.ts avgör vad som får gallras och när, och packages/retention/src/executor.ts driver livscykeln kö → plan → godkännande → körning → verifiering → rapport. selectDueCases plockar bara ärenden som beslutsskiktet faktiskt bedömt som förfallna. |
| Gap | Ingen. |
| Lösning | packages/retention (beslut + exekvering), control.tenant_retention_policies. |
| Kodevidens | packages/retention/src/index.ts; packages/retention/src/executor.ts |
| Verifiering | tests/run.mjs: åtta gallringstester (fyra beslutstester, tre exekveringstester och rapportbygget). |
| Status | PASS |

### 2069 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Beställaren SKA utan inblandning eller hjälp från Leverantör kunna gallra. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | approveGallring avvisar plattformspersonal även när behörighetsbiten är satt. Kravet läses åt båda hållen: att kunden kan gallra utan leverantören betyder också att leverantören inte får gallra utan kunden. Dessutom är godkännande skilt från begäran, eftersom gallring är oåterkallelig och ett enskilt komprometterat eller misstaget konto inte ska kunna både föreslå och genomföra en oåterkallelig radering. |
| Gap | Ingen. |
| Lösning | packages/retention/src/executor.ts: approveGallring med isPlatformStaff-spärr och self-approval-spärr. |
| Kodevidens | packages/retention/src/executor.ts |
| Verifiering | tests/run.mjs: gallringstest att godkännande sker av kunden och av någon annan än den som begärt. |
| Status | PASS |

### 2070 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Gallringsfunktionen SKA tillgodose att den gallrade informationen raderas och inte går att återskapa. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Planen deklareras före körning och täcker alltid de härledda lagren som annars glöms: object storage, derived renders, sökindex, cache och notifieringar. Ett sökindex eller en cache som fortsätter servera innehållet efter att primärraden är borta betyder att informationen fortfarande går att återskapa. verifyGallringExecution jämför utfallet mot planen, så ett oadresserat mål blir ett upptäckt utelämnande i stället för ett frånvarande. Ett mål som inte kunnat verifieras raderat avbryter körningen i stället för att rapporteras som klar. |
| Gap | Ingen. |
| Lösning | packages/retention/src/executor.ts: MANDATORY_CASE_TARGETS, planGallring, verifyGallringExecution. |
| Kodevidens | packages/retention/src/executor.ts |
| Verifiering | tests/run.mjs: gallringstest att en partiell gallring inte kan rapporteras som komplett, inklusive att rapportbyggaren ensam skulle ha bedömt samma partiella utfall som komplett. |
| Status | PASS |

### 2071 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Gallringsfunktionen SKA vara behörighetsstyrd, så att endast behöriga användare kan utföra gallring. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | Gallring kräver retention:execute och en tenantbunden aktör. approveGallring kontrollerar behörighet, tenanttillhörighet, att aktören inte är plattformspersonal och att godkännaren inte är den som begärt. hasPermission i packages/authorization styr behörigheten. |
| Gap | Ingen. |
| Lösning | packages/retention/src/executor.ts, packages/authorization. |
| Kodevidens | packages/retention/src/executor.ts; packages/authorization/src/index.ts |
| Verifiering | tests/run.mjs: gallringstest för godkännandekontroll samt befintligt test att gallring är behörighetsstyrd och reserverad för kunden. |
| Status | PASS |

### 2072 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Gallringsfunktionen SKA kunna generera gallringsrapporter eller gallringsloggar, så att gallring som utförts blir spårbar. |
| Typ | SKA |
| Kategori | 08 - Gallring |
| Område | Gallring |
| Nuläge | completeGallring producerar gallringsrapporten och kan bara nås från ett verifierat tillstånd, så en rapport kan aldrig beskriva en partiell radering som genomförd. Rapporten bär tenant, jobb, policy och version, retentionklass, samtliga ärende-ID, utfall per mål och totalsumma, samt vem som godkände den oåterkalleliga åtgärden — godkännaren och inte den som begärde, eftersom rapporten är beviset för vem som är ansvarig. |
| Gap | Ingen. |
| Lösning | packages/retention: buildGallringReport, completeGallring. |
| Kodevidens | packages/retention/src/index.ts; packages/retention/src/executor.ts |
| Verifiering | tests/run.mjs: gallringstest för rapportens fullständighet och att completeGallring inte går att nå utan verifierad körning. |
| Status | PASS |

### 2073 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA tillhandahålla dokumenterade API:er för läsning och skrivning av data till andra system och kommunens integrationsplattform. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | API |
| Nuläge | Versionerat REST-API under /v1 med OpenAPI 3-specifikation för läsning och skrivning. |
| Gap | Endpoints för gallring, arkivexport och GDPR saknas. |
| Lösning | Utöka API och OpenAPI när funktionerna implementeras. |
| Kodevidens | docs/api/openapi.yaml; apps/api/src/router.ts |
| Verifiering | tests/integration.mjs; scripts/verify-sdk-sync.mjs |
| Status | PARTIAL |

### 2074 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören SKA tillhandahålla teknisk dokumentation för integration. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | Integration |
| Nuläge | docs/api/openapi.yaml, docs/api/error-codes.md, docs/integration/ samt SDK:er i tre språk. |
| Gap | Ingen samlad integrationsguide på svenska. |
| Lösning | Integrationsguide som komplement till OpenAPI. |
| Kodevidens | docs/api/; sdks/ |
| Verifiering | scripts/verify-sdk-sync.mjs |
| Status | PARTIAL |

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

### 2076 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Samtliga API:er, både nuvarande och framtida SKA ingå utan kostnad eller volymbegränsing. |
| Typ | SKA |
| Kategori | 09 - Integrationer |
| Område | API |
| Nuläge | Ingen kommersiell volymbegränsning finns i koden. app.api_clients och api_client_scopes styr behörighet, inte volym. |
| Gap | Tekniska rate limits för missbruksskydd är inte dokumenterade som skilda från kommersiella begränsningar. |
| Lösning | Dokumentera skillnaden och konfigurerbara säkerhetsgränser. |
| Kodevidens | migrations/data/0012_production_repository_runtime.sql |
| Verifiering | Ingen. |
| Status | PARTIAL |

### 2079 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Inloggning till systemet SKA stödja antingen SAML 2.0 eller OIDC (Open Id Connect). |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Inloggning |
| Nuläge | Både SAML 2.0 och OIDC stöds genom samma protokollneutrala beslut i packages/federation, med separata protokollparsers vid kanten där nycklarna finns. packages/auth hanterar OIDC-transaktionen med state, nonce och PKCE. Migration control/0017 tillåter generiska GENERIC_SAML och GENERIC_OIDC per tenant och miljö. |
| Gap | Ingen. Kravet är uppfyllt genom att minst ett av protokollen stöds; båda stöds. |
| Lösning | packages/federation, packages/auth, control.tenant_identity_providers. |
| Kodevidens | packages/federation/src/index.ts; packages/auth/src/index.ts; migrations/control/0017_workforce_federation.sql |
| Verifiering | tests/run.mjs: fyra federationstester, varav ett kör samma beslut för OIDC och SAML. tests/security.mjs täcker OIDC-transaktionen. |
| Status | PASS |

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

### 2081 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Det SKA vara möjligt att begränsa åtkomst till funktioner och information baserat på användarroller. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Behörighet |
| Nuläge | Behörigheter styr åtkomst till funktioner, och RLS plus tenantkontext styr åtkomst till information. |
| Gap | Informationsbegränsning på ärendenivå (sekretess) saknas som eget begrepp, se 2024. |
| Lösning | Sensitivitetsklassning kopplad till behörighetsmodellen. |
| Kodevidens | packages/authorization/src/index.ts; migrations/data/0005_rls.sql |
| Verifiering | tests/run.mjs; tests/sql/tenant-isolation.sql |
| Status | PARTIAL |

### 2082 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Systemet SKA stödja automatisk provisionering av användare. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | packages/scim implementerar SCIM 2.0 (RFC 7643/7644) som beslutslager, och migration data/0017 utökar den befintliga app.users-modellen i stället för att skapa en parallell användarmodell. Provisionering är idempotent på externalId, vilket är det som gör en IdP-retry till en no-op i stället för ett dubblettkonto eller en konflikt som stoppar synken. Varje läs- och skrivväg går genom assertScimTenant, som svarar 404 och inte 403 vid tenantmiss så att ID-uppräkning inte blir en katalogutlistning. |
| Gap | Ingen. Automatisk provisionering finns. |
| Lösning | packages/scim (beslutslager), migrations/data/0017_scim_provisioning.sql (app.users utökad, provisioneringsklienter, gruppmappning, provisioneringslogg med RLS). |
| Kodevidens | packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql; migrations/data/verify_scim_provisioning.sql |
| Verifiering | tests/run.mjs: fyra SCIM-tester (idempotens och tenantisolering, avaktivering utan radering, rollmappning, paginering och filtergrammatik). |
| Status | PASS |

### 2083 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Provisioneringen SKA omfatta minst:  - skapande av användarkonto - uppdatering av användaruppgifter - avaktivering/avslut av användare |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | Hela livscykeln täcks: createScimUser skapar konto idempotent, applyScimPatch uppdaterar attribut (både med path och Entras pathless replace, och både boolesk och strängkodad active), applyGroupMembership ändrar behörighet via gruppmedlemskap, och deprovisionScimUser avaktiverar. Avaktivering är medvetet inte radering: en DELETE mot en användare med historik degraderas till avaktivering, eftersom borttagen rad skulle föräldralösa de signaturer och auditposter som namnger personen. Attribut som inte är skrivbara över SCIM avvisas i stället för att tyst ignoreras, så att katalogen och systemet inte hamnar i permanent oenighet. |
| Gap | Ingen. Skapande, uppdatering, behörighetsändring och avaktivering finns alla. |
| Lösning | packages/scim: createScimUser, applyScimPatch, applyGroupMembership, deprovisionScimUser. app.scim_provisioning_events loggar CREATED/UPDATED/ACTIVATED/DEACTIVATED/DELETED/ROLES_CHANGED. |
| Kodevidens | packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | tests/run.mjs: SCIM-test för avaktivering som behåller användarposten, samt idempotens- och rollmappningstester. |
| Status | PASS |

### 2084 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Provisioneringen SKA baseras på kommunens centrala identitetskälla. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | Provisioneringen drivs av kundens katalog över SCIM med en tenantbunden klient i app.scim_provisioning_clients. Token lagras aldrig i klartext utan som secret reference plus hash (AGENTS.md regel 7). externalId är katalogens egen stabila identifierare och används som idempotensnyckel, vilket gör katalogen till källan. Unikhet är per tenant och partiell, så två kommuner kan ha samma katalogidentifierare och befintliga icke-SCIM-användare påverkas inte. |
| Gap | Ingen kodbrist. Anslutning mot Kungälvs katalog kräver att kommunen aktiverar SCIM-utgående provisionering och tar emot en token. |
| Lösning | app.scim_provisioning_clients, packages/scim (ScimContext bär tenant och klientens tilldelningsbara roller). |
| Kodevidens | packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | tests/run.mjs: SCIM-test för idempotens och tenantisolering, inklusive att idempotensuppslaget aldrig når över tenantgränsen. |
| Status | PASS |

### 2085 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Det SKA vara möjligt att tilldela roller och behörigheter automatiskt vid provisionering. |
| Typ | SKA |
| Kategori | 10 - Inloggning och behörighet |
| Område | Provisionering |
| Nuläge | resolveScimRoles härleder roller ur gruppmedlemskap via explicit mappning i app.scim_group_role_mappings. Mappningen är deny-by-default: omappad grupp ger ingenting, och en mappning mot en roll utanför provisioneringsklientens assignableRoles är ett fel i stället för en tyst tilldelning. Det gör att en katalogadministratör som lägger till någon i en grupp aldrig kan eskalera bortom vad klienten själv är scopad för. Mappningen är en tabell och inte en JSON-klump, så varje tilldelning är enskilt granskbar och återkallelsebar. |
| Gap | Ingen. Roller tilldelas automatiskt vid provisionering. |
| Lösning | packages/scim: resolveScimRoles, applyGroupMembership. app.scim_group_role_mappings med composite foreign key mot app.roles. |
| Kodevidens | packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql; migrations/data/verify_scim_provisioning.sql |
| Verifiering | tests/run.mjs: SCIM-test att roller endast kommer från mappade grupper och aldrig över klientens scope. |
| Status | PASS |

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

### 3502 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha tillsett att ansvar och arbetsuppgifter som står i konflikt med varandra och kan leda till missbruk är tekniskt eller organisatoriskt åtskilda. |
| Typ | SKA |
| ISO | A.6.1 Intern organisation — A.6.1.2 Uppdelning av arbetsuppgifter |
| Nuläge | Rollmodellen skiljer plattformsroller från tenantroller och har separata granskarroller. |
| Gap | Ingen dokumenterad ansvarsuppdelning för driftorganisationen. |
| Lösning | Dokumentera uppdelningen och komplettera med four-eyes för känsliga operationer. |
| Kodevidens | packages/authorization/src/index.ts |
| Verifiering | tests/run.mjs: prevent_activation_self_approval i onboarding-migrationen. |
| Status | PARTIAL |

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
| Nuläge | Rutin och funktion för permanent radering finns implementerad som gallringsexekveringen, med planerade mål, verifierad radering per mål och granskningsbar rapport. Radering som inte kunnat verifieras rapporteras aldrig som genomförd. |
| Gap | Ingen kodbrist. |
| Lösning | packages/retention/src/executor.ts, packages/privacy (radering på begäran). |
| Kodevidens | packages/retention/src/executor.ts; packages/privacy/src/index.ts |
| Verifiering | tests/run.mjs: tre gallringsexekveringstester och två integritetstester. |
| Status | PASS |

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

### 3513 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Beställarens krav på informationshanteringen ska efterföljas. Om sådana krav inte uttryckligen ställts ska leverantören utan anmodan kunna uppvisa de rutiner som gäller hos leverantören. |
| Typ | SKA |
| ISO | A.8.2 Informationsklassning — A.8.2.3 Hantering av tillgångar |
| Nuläge | DATA_PROCESSING.md beskriver behandlingen. |
| Gap | Ingen informationsklassningsrutin. |
| Lösning | Dataklassificeringspolicy. |
| Kodevidens | DATA_PROCESSING.md |
| Verifiering | Ingen. |
| Status | PARTIAL |

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

### 3515 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska följa en överenskommen rutin som möjliggör för Beställaren att godkänna hantering (skapande, borttag, ändring) av utpekade behörighetsroller t ex avseende priviligierade (högre) behörigheter. Hanteringen ska vara spårbar och redovisas för Beställaren enligt överenskommelse, dock minst årligen. |
| Typ | BÖR |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.2 Tilldelning av användaråtkomst |
| Nuläge | Plattformsroller tilldelas via platform_role_assignments och onboarding har separata godkännandesteg. |
| Gap | Ingen rutin för kommunens godkännande av privilegierade roller och ingen årlig redovisning. Kravet är BÖR. |
| Lösning | Godkännandeflöde med previous/new value och rapport till kommunen. |
| Kodevidens | migrations/control/0001_control_plane.sql |
| Verifiering | Ingen. |
| Status | PARTIAL |

### 3516 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska använda särskilda personliga användaridentiteter för systemadministration. Dessa konton ska vara spårbara och lätta att skilja från vanliga användare. Beställaren ska informeras vid förändringar av vilka som innehar dessa behörigheter. |
| Typ | SKA |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.3 Hantering av privilegierade åtkomsträttigheter |
| Nuläge | Plattformsroller är åtskilda från tenantroller och personliga. |
| Gap | Ingen rutin för att informera kommunen vid förändringar av privilegierade behörigheter. |
| Lösning | Register över privilegierade konton plus notifiering. |
| Kodevidens | packages/authorization/src/index.ts |
| Verifiering | tests/run.mjs superadmin-tester. |
| Status | PARTIAL |

### 3517 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska tillhandahålla ett sätt att distribuera och återställa lösenord utan att lösenordet kan röjas till obehöriga. Behörighetsinformation som t.ex. lösenord får ej lagras i klartext (gäller även systemkonton i källkod). Motsvarande krav gäller även för temporära filer som skapas i användarens arbetsstation när systemet används. Se vägledning för tillitsnivå 3 (LoA3) för detaljer. |
| Typ | SKA |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.4 Hantering av användares konfidentiella autentiseringsinformation |
| Nuläge | Lösenordshantering sker via Supabase Auth med e-postbaserad återställning. Secret scanning täcker systemkonton i källkod. |
| Gap | De läckta nycklarna visar att kontrollen inte varit heltäckande. Rotation kvarstår. |
| Lösning | Rotation enligt runbook plus den hårdare scannern. |
| Kodevidens | scripts/scan-secrets.mjs; docs/operations/leaked-key-rotation-2026-08.md |
| Verifiering | npm run scan:secrets. |
| Status | PARTIAL |

### 3518 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Behörighetssystemet ska logga information om när användare skapades, togs bort eller förändrades samt senaste inloggning. |
| Typ | SKA |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.5 Granskning av användares åtkomsträttigheter |
| Nuläge | Behörighetssystemet loggar när användare skapades, togs bort eller förändrades. app.scim_provisioning_events registrerar CREATED, UPDATED, ACTIVATED, DEACTIVATED, DELETED och ROLES_CHANGED med klient, användare, detalj och request-ID, och motsvarande händelser finns i SECURITY_EVENTS för den strukturerade loggen. Auditloggen är hashkedjad så att manipulation är detekterbar. |
| Gap | Ingen. |
| Lösning | migrations/data/0017_scim_provisioning.sql, packages/observability, packages/audit. |
| Kodevidens | migrations/data/0017_scim_provisioning.sql; packages/observability/src/index.ts; packages/audit/src/index.ts |
| Verifiering | tests/run.mjs: auditkedjetest, SCIM-tester och test för spårbara säkerhetshändelser. |
| Status | PASS |

### 3519 — PASS

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha en rutin för att både avaktivera användarkonton och permanent ta bort konton från systemet. |
| Typ | BÖR |
| ISO | A.9.2 Hantering av användaråtkomst — A.9.2.6 Borttagning eller justering av åtkomsträttigheter |
| Nuläge | deprovisionScimUser skiljer avaktivering från permanent borttagning. Användare med historik avaktiveras och behålls, eftersom raderad rad skulle föräldralösa signaturer och auditposter. Användare utan historik kan tas bort permanent. Båda vägarna loggas i app.scim_provisioning_events. Rutinen är dokumenterad i docs/operations/account-provisioning.md. |
| Gap | Ingen. |
| Lösning | packages/scim: deprovisionScimUser. app.users.disabled_at, app.scim_provisioning_events. |
| Kodevidens | packages/scim/src/index.ts; migrations/data/0017_scim_provisioning.sql |
| Verifiering | tests/run.mjs: SCIM-test att avaktivering behåller användarposten och att borttagning bara sker utan historik. |
| Status | PASS |

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

### 3521 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantörens behörigheter ska tilldelas enligt principen där minsta möjliga behörighet tilldelas utifrån användares roll och arbetsuppgifter. Detta gäller även konton som används vid kommunikation mellan systemkomponenter, exempelvis mellan applikation och databas samt priviligierade konton. |
| Typ | SKA |
| ISO | A.9.4 Styrning av åtkomst till system och tillämpningar — A.9.4.1 Begränsning av åtkomst till information |
| Nuläge | Rollmodellen tillämpar least privilege och tenantkontext sätts per transaktion. |
| Gap | Tjänstekonton mellan komponenter använder inte separata credentials per tjänst. |
| Lösning | Separata credentials för web, worker, signservice, validation och migrations. |
| Kodevidens | packages/authorization/src/index.ts; packages/database/src/index.ts |
| Verifiering | tests/run.mjs: API authorizes every case operation. |
| Status | PARTIAL |

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
| Nuläge | Kryptorutinerna är dokumenterade och implementerade: AES-256-GCM med autentiserad ciphertext och purpose binding för känsliga uppgifter, HMAC-SHA-256 för blind index, SHA-256 för hashar och checksummor, RFC 3161 för tidsstämplar. packages/crypto/src/key-rotation.ts implementerar nyckelversionering med exakt en aktiv version, staged rotation (pending → active → decrypt_only → retired), dual read under migrering och write-new-only, verifierad återkryptering före pensionering av gammal nyckel, samt rollback som tillåts före men aldrig efter pensionering. Blind index roteras separat och strängare: uppslag sker mot samtliga kvarvarande versioner under migreringen så att sökning fortsätter fungera, men ett komprometterat indexvärde måste skrivas över och inte behållas vid sidan av det nya — den som har den läckta nyckeln kan annars räkna fram indexet för en utpekad person och slå upp hen. |
| Gap | Ingen kodbrist. |
| Lösning | packages/crypto/src/key-rotation.ts, packages/crypto (aes-gcm, hmac, hash), docs/operations/leaked-key-rotation-2026-08.md. |
| Kodevidens | packages/crypto/src/key-rotation.ts; apps/api/src/adapters/aes-gcm-sensitive-data.ts; docs/operations/leaked-key-rotation-2026-08.md |
| Verifiering | tests/run.mjs: tre rotationstester (dual read och write-new-only, verifierad pensionering och rollback, överskrivning av komprometterat blind index) samt befintligt test för autentiserad ciphertext och purpose. |
| Status | PASS |

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

### 3529 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner avseende förändringshantering för de delar som kan påverka leveransens säkerhet och tillgänglighet. Leverantören ska vid anmodan redovisa sin process för beställaren. |
| Typ | SKA |
| ISO | A.12.1 Driftsrutiner och ansvar — A.12.1.2 Ändringshantering |
| Nuläge | CI har kvalitetsgrindar men ingen dokumenterad förändringshanteringsprocess. |
| Gap | Ingen redovisningsbar process. |
| Lösning | Dokumenterad change management-process. |
| Kodevidens | .github/workflows/ci.yml |
| Verifiering | npm run verify. |
| Status | PARTIAL |

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

### 3531 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska testa samtliga leveranser i separat testmiljö innan de införs i Beställarens tjänst. Testdata ska skyddas och kontrolleras och får inte innehålla information som är känslig eller omfattas av sekretess. |
| Typ | SKA |
| ISO | A.12.1 Driftsrutiner och ansvar — A.12.1.4 Separation av utvecklings-, test och driftmiljöer |
| Nuläge | Separata miljöer finns i deployment-topologin. tests använder syntetisk data. |
| Gap | Ingen verifiering av att produktionsdata aldrig når test- eller utvecklingsmiljö. |
| Lösning | Dokumenterad miljöseparation och kontroll av testdata. |
| Kodevidens | docs/operations/deployment-topology.md; tests/ |
| Verifiering | tests/run.mjs använder genererade nycklar och syntetisk data. |
| Status | PARTIAL |

### 3532 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha ett skydd mot skadlig kod som uppdateras kontinuerligt för de delar som ingår i leveransen. |
| Typ | SKA |
| ISO | A.12.2 Skydd mot skadlig kod — A.12.2.1 Säkerhetsåtgärder mot skadlig kod |
| Nuläge | docker-compose innehåller clamav och dokumentmodellen har document_scan_results. |
| Gap | Skanningsflödet med karantän före godkännande är inte verifierat. |
| Lösning | Karantän, skanning och avvisning före normalisering. |
| Kodevidens | docker-compose.yml; migrations/data/0002_core_tables.sql |
| Verifiering | tests/security.mjs uppladdningsdel. |
| Status | PARTIAL |

### 3533 — BLOCKED_EXTERNAL

| Fält | Innehåll |
| --- | --- |
| Krav | Om leverantörens anbud avser tjänst som driftas utanför Kungälvs Kommun gäller kravet: Leverantören ska ha rutiner och funktioner för säkerhetskopiering och återställande av information enligt överenskomna tillgänglighetskrav med Beställaren. Säkerhetskopior ska skyddas på motsvarande sätt som originalinformationen samt förvaras åtskilt. |
| Typ | SKA |
| ISO | A.12.3 Säkerhetskopiering — A.12.3.1 Säkerhetskopiering av information |
| Nuläge | Samma som 2037. |
| Gap | Samma som 2037. |
| Lösning | Samma som 2037. |
| Kodevidens | docs/operations/backup-and-restore.md |
| Verifiering | Ingen. |
| Status | BLOCKED_EXTERNAL |
| Blockerare | Leverantörsevidens och genomförd restore-övning. |

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

### 3537 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska verifiera och begränsa den mjukvara som får exekveras inom den levererade tjänsten |
| Typ | SKA |
| ISO | A.12.5 Styrning av driftsystem — A.12.5.1 Installation av program på driftsystem |
| Nuläge | Containeriserad drift med låsta beroenden och pinnade GitHub Actions. |
| Gap | Ingen körtidsbegränsning av vilken mjukvara som får exekveras. |
| Lösning | Minimala images, read-only filsystem och verifierade artefakter. |
| Kodevidens | infrastructure/docker/; .github/workflows/ci.yml |
| Verifiering | scripts/verify-repository.mjs kräver SHA-pinnade actions. |
| Status | PARTIAL |

### 3538 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska utan dröjsmål informera beställaren om tekniska sårbarheter i levererade komponenter. Upptäckta sårbarheter ska åtgärdas omgående. |
| Typ | SKA |
| ISO | A.12.6 Hantering av tekniska sårbarheter — A.12.6.1 Hantering av tekniska sårbarheter |
| Nuläge | Samma som 2045. |
| Gap | Samma som 2045. |
| Lösning | Samma som 2045. |
| Kodevidens | SBOM.cdx.json |
| Verifiering | scripts/check-provenance.mjs |
| Status | PARTIAL |

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

### 3541 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Beställaren ska godkänna alla informationsutbyten som sker med andra system |
| Typ | SKA |
| ISO | A.13.2 Informationsöverföring — A.13.2.1 Regler och rutiner för informationsöverföring |
| Nuläge | Webhook-endpoints och API-klienter konfigureras per tenant. |
| Gap | Ingen godkännandeprocess för informationsutbyten. |
| Lösning | Dokumenterad godkännandeprocess. |
| Kodevidens | migrations/data/0004_audit_outbox_webhooks_archive.sql |
| Verifiering | tests/security.mjs SSRF-skydd för webhook-URL:er. |
| Status | PARTIAL |

### 3543 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha fastlagda och dokumenterade principer och metoder för utveckling av säkra system. Vid webbutveckling ska OWASP:s (www.owasp.org) rekommendationer följas. |
| Typ | SKA |
| ISO | A.14.1 Säkerhetskrav på informationssystem — A.14.1.1 Analys och specifikation av informationssäkerhetskrav |
| Nuläge | AGENTS.md innehåller säkerhetsregler och tests/security.mjs täcker SSRF, uppladdning och domänvalidering. |
| Gap | Ingen dokumenterad secure development policy med OWASP-referens. |
| Lösning | docs/security/SECURE_DEVELOPMENT_POLICY.md plus systematisk OWASP-genomgång. |
| Kodevidens | AGENTS.md; tests/security.mjs |
| Verifiering | tests/security.mjs. |
| Status | PARTIAL |

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

### 3545 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha riktlinjer för informationssäkerhet inom sina utvecklingsprocesser. Vid större ändringar ska leverantören identifiera och hantera risker som säkerställer att säkerhetskraven i systemet är uppfyllda. |
| Typ | SKA |
| ISO | A.14.2 Säkerhet i utvecklings- och supportprocesser — A.14.2.2 Rutiner för hantering av systemändringar |
| Nuläge | Samma som 3543. |
| Gap | Ingen riskhantering vid större ändringar. |
| Lösning | Riskanalys som steg i releaseprocessen. |
| Kodevidens | AGENTS.md |
| Verifiering | Ingen. |
| Status | PARTIAL |

### 3546 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha rutiner för att granska och testa tillgänglighet och säkerhet av ändringar i verksamhetskritiska driftsplattformar. |
| Typ | SKA |
| ISO | A.14.2 Säkerhet i utvecklings- och supportprocesser — A.14.2.3 Teknisk granskning av tillämpningar efter ändringar i driftsmiljö |
| Nuläge | CI kör tester före deploy. |
| Gap | Ingen separat granskning av tillgänglighet och säkerhet vid ändringar i driftplattformen. |
| Lösning | Dokumenterad rutin. |
| Kodevidens | .github/workflows/ci.yml |
| Verifiering | npm run verify. |
| Status | PARTIAL |

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

### 3552 — PARTIAL

| Fält | Innehåll |
| --- | --- |
| Krav | Leverantören ska ha reservrutiner, reservlösningar och återstartsplaner som uppfyller beställarens krav på tillgänglighet (SLA). |
| Typ | BÖR |
| ISO | A.17.1 Kontinuitet för informationssäkerhet — A.17.1.2 Införa kontinuitet för informationssäkerhet |
| Nuläge | docs/operations/backup-and-restore.md finns. Kravet är BÖR. |
| Gap | Ingen kontinuitetsplan eller återstartsplan kopplad till SLA. |
| Lösning | docs/operations/DISASTER_RECOVERY.md med RPO, RTO och återstartsordning. |
| Kodevidens | docs/operations/backup-and-restore.md |
| Verifiering | Ingen. |
| Status | PARTIAL |

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

