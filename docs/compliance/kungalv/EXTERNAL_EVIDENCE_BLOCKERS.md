# Externa blockerare — Kungälvs kommun, Dnr KS2026/1005

<!-- GENERERAD FIL. Redigera inte för hand.
     Kör `node scripts/build-requirement-matrix.mjs`. -->

Bedömningsdatum: 2026-08-07

42 av 138 krav kan inte avgöras i kodbasen.
De kräver avtal, credentials, certifiering, leverantörsevidens eller
organisatoriska åtgärder. Kraven markeras medvetet inte som uppfyllda.

| Krav | Typ | Vad som saknas | Vad som redan är implementerat |
| --- | --- | --- | --- |
| F001 | SKA | CA-utfärdat signeringscertifikat för organisationen, HSM eller fjärr-QSCD för nyckelskydd, samt TSA-avtal för RFC 3161-tidsstämplar. Ingen av dessa kan tillhandahållas av kod. När de finns aktiveras backend via SigningEngineFactory och verifieras med samma pipelinetester mot skarp evidens. | Signeringskedjan är nu komplett som teknisk pipeline. packages/signing-engine definierar den providerneutrala gränsen (SigningEngine, SignatureValidator, TimestampProvider, CertificateProvider) och den ordnade pipelinen dokumentlåsning → policy → identitet → signatur → tidsstämpel → validering → PAdES-antagning. Pipelinen binder signaturen till exakt den låsta dokumentversionens hash, avvisar identitetsbevis från annan intent/case/tenant, kräver att tidsstämpeln täcker den signerade revisionen, och samlar PAdES-evidens enbart från vad providers faktiskt returnerat. assertSigningRuntimeUsable spärrar produktion när backend, TSA eller validator inte är produktionsklar, och kräver HSM/QSCD för LTA. NotConfiguredSigningEngine och BlockedSigningEngine är default: en okonfigurerad installation vägrar signera i stället för att producera ett artefaktliknande svar. |
| F002 | SKA | Freja produktionscredentials: relying party-avtal med Freja eID AB, mTLS-klientcertifikat, samt organisationsregistrering för OrgID. Utan dessa kan ingen skarp Freja-transaktion initieras. När de finns sätts productionReady=true i identity-registry och samma bindningstester körs mot skarp evidens. | Freja-adaptern är implementerad i packages/provider-adapters/src/freja.ts som en adapter för alla tre metoderna (Freja eID, Freja eID Plus, Freja OrgID) bakom ElectronicIdentityProvider. verifyFrejaSignatureClaims genomför hela bindningskontrollen på ett JWS-verifierat svar: algoritm-allowlist, issuer, audience, status, transaktionsreferens, signRef mot signeringsintent, signerad datahash, nonce med engångsförbrukning mot replay, egen åldersgräns utöver svarets expiry, registreringsnivå och subjekttyp. För OrgID krävs dessutom att organisationsidentiteten finns och tillhör rätt organisation. RejectingFrejaSignatureVerifier är default så att en okonfigurerad installation vägrar i stället för att acceptera ett overifierat svar. frejaAssuranceLevel normaliserar BASIC/EXTENDED/PLUS till LOW/SUBSTANTIAL/HIGH så att Freja-vokabulär inte läcker ut i kärnan. |
| F003 | SKA | TIC produktionscredentials för BankID och Freja relying party-avtal. Båda är avtals- och credentialfrågor utanför kodbasen. | BankID via TIC är implementerat och productionReady i identity-registry. Freja+ delar nu den fullt implementerade Freja-adaptern med JWS-bindningskontroll, replayskydd och assurance-normalisering, och kräver bara credentials för att aktiveras. Båda metoderna erbjuds via identity-registry utan att kärnan namnger en provider. |
| F004 | SKA | Kungälvs IdP-metadata (EntityID, SSO-endpoint, signeringscertifikat) samt registrering av Kommunsign som service provider hos MobilityGuard. Ren konfigurationsleverans från kommunen; koden är på plats och verifieras med samma tester när metadatan finns. | packages/federation implementerar en protokollneutral workforce-federation för både SAML 2.0 och OIDC. Ingen kod namnger MobilityGuard, Entra eller någon annan IdP: kravet är förmågan, och att ansluta en annan IdP är en konfigurationsrad. verifyWorkforceAssertion normaliserar båda protokollen till en assertion och avgör sedan i ett enda beslut om den får logga in någon: signaturverifiering, aktiverad provider, issuer, audience, destination, InResponseTo/state mot en inloggning vi själva startat (IdP-initierade flöden avvisas), notBefore/notOnOrAfter, egen maxålder på IdP-sessionen, engångsförbrukad assertion-ID mot replay, samt krävd authentication context. Tenant hämtas alltid ur den bundna konfigurationen och aldrig ur meddelandet (AGENTS.md regel 1). mapWorkforceIdentity mappar IdP-grupper till roller deny-by-default: omappad grupp ger inget, användare utan mappad grupp avvisas i stället för att få en defaultroll, och en mappning mot en roll utanför tenantens assignableRoles är ett fel i stället för en tyst tilldelning. resolveLogoutTargets avslutar exakt de sessioner IdP:n namngivit. Migration control/0017 ersätter den leverantörsspecifika provider_key-listan med generiska GENERIC_OIDC/GENERIC_SAML, och lägger till rollmappningstabell och assertion-ledger. |
| F013 | SKA | Samma som F001: CA-utfärdat signeringscertifikat, HSM eller fjärr-QSCD, och TSA-avtal. Utan dem skapas ingen signatur och därmed levereras inget signerat dokument. Verifieras med befintliga tester mot skarp evidens när backend aktiveras. | Hela kedjan fram till leverans är implementerad. Dokument kanoniseras till PDF/A-2b och profilen verifieras av validator i stället för att påstås av konverteraren; Office-dokument konverteras serverside till samma profil; arkivexporten vägrar ta emot ett dokument utan verifierad PDF/A-profil; och ADOBE_READER_COMPATIBILITY kräver att signaturen läggs till som inkrementell uppdatering så att PDF/A-strukturen och tidigare signaturer bevaras. |
| 2026 | SKA | Organisatorisk rutin och kontoregister hos leverantören. | control.platform_subjects och platform_role_assignments ger personliga plattformskonton med roller. |
| 2027 | SKA | Utpekad roll hos Kungälv och avtalad samrådsrutin. | Ingen dokumenterad incidenthanteringsprocess finns i repot utöver THREAT_MODEL.md. |
| 2029 | SKA | Leverantörsevidens för databehandlingsregion per underbiträde. | Hosting sker hos Supabase, Railway och Vercel. Ingen verifierad förteckning över regioner finns i repot. |
| 2030 | SKA | Kommunens godkännande av varje underbiträde. | Ingen underbiträdesförteckning finns i repot. |
| 2031 | SKA | Avtalad process med kommunen. | Ingen process för byte av underleverantör finns. |
| 2032 | SKA | Två referenskunder i drift. Kundnamn ska inte läggas i repot. | Kan inte uppfyllas med kod. |
| 2037 | SKA | Leverantörsevidens och genomförd restore-övning. | docs/operations/backup-and-restore.md finns. |
| 2039 | SKA | Avtalsvillkor. | Avtalsfråga. |
| 2040 | SKA | Bilagan Supportavtal för molnbaserade tjänster från Kungälvs kommun. När bilagan tillhandahålls jämförs den mot KUNGALV_SUPPORT_SLA.md och avvikande nivåer justeras; ingen kodändring väntas, det är en avtalsjämförelse. Blockerar inte teknisk go-live. | Supportorganisation, kontaktvägar, öppettider, prioritetsnivåer, svarstider och eskalering är dokumenterade i docs/operations/KUNGALV_SUPPORT_SLA.md, och incident- och eskaleringsrutinen i docs/operations/OVERVAKNING_OCH_INCIDENT.md avsnitt 3. Den tekniska förmåga supporten vilar på finns: korrelations-ID genom API, workers och loggar, readiness som skiljer databas, Redis, lagring, TIC, signeringstjänst och valideringstjänst, samt hashkedjad auditlogg. |
| 2042 | SKA | Prisbilaga. | Prisfråga. |
| 2043 | SKA | Avtalad förvaltningsprocess. | Avtals- och förvaltningsfråga. |
| 2048 | SKA | Införandeplan tas fram i projektet. | Projektfråga. |
| 2051 | SKA | Samarbete i införandeprojektet. | Projektfråga. |
| 2054 | SKA | Utbildningstillfälle genomförs av leverantören. | Ingen utbildning planerad. |
| 3501 | SKA | Etablerat och tillämpat LIS hos leverantören. | Inget LIS finns dokumenterat. |
| 3503 | SKA | Upprättade myndighetskontakter. | Organisatoriskt krav. |
| 3504 | SKA | Antagen och tillämpad policy. | Ingen distansarbetspolicy finns. |
| 3505 | SKA | Genomförda bakgrundskontroller. | Organisatoriskt krav. |
| 3506 | SKA | Tecknade avtal med anställda och underleverantörer. | Organisatoriskt krav. |
| 3507 | SKA | Genomförd utbildning. | Organisatoriskt krav. |
| 3508 | SKA | Fastställd process. | Organisatoriskt krav. |
| 3509 | SKA | Undertecknade ansvarsförbindelser. | Organisatoriskt krav. |
| 3510 | SKA | Antagen policy och kontrollrutin. | AGENTS.md innehåller icke förhandlingsbara regler för utveckling. |
| 3512 | SKA | Genomförd riskbedömning. | THREAT_MODEL.md finns men ingen återkommande riskbedömningsprocess. |
| 3520 | SKA | Fastställda regler. | Organisatoriskt krav. |
| 3522 | BÖR | Kommunens IdP-konfiguration. | Inloggning sker via kommunens IdP där MFA hanteras. Kravet är BÖR. |
| 3525 | SKA | Escrow-avtal med tredje part. | Källkoden ligger i git med FILE_MANIFEST.sha256 och PROVENANCE_REPORT.txt. Branch protection och deposition är inte verifierade. |
| 3527 | SKA | Leverantörsevidens för datahallens fysiska skyddsnivå. | Drift sker hos molnleverantörer. |
| 3528 | SKA | Leverantörsevidens för fysisk tillträdeskontroll. | Fysisk åtkomst hanteras av hostingleverantören. |
| 3533 | SKA | Leverantörsevidens och genomförd restore-övning. | Samma som 2037. |
| 3536 | SKA | Leverantörsevidens för tidssynkroniseringskälla. | Systemet använder UTC internt. |
| 3548 | SKA | Underbiträdesförteckning och kommunens godkännande. | Samma som 2030. |
| 3550 | SKA | Utpekad roll hos Kungälv. | Samma som 2027. |
| 3554 | SKA | Avtalad förvaltningsprocess. | Avtals- och förvaltningsfråga. |
| 3555 | SKA | Tecknat personuppgiftsbiträdesavtal och sekretessförbindelse. | Bilaga 4 är personuppgiftsbiträdesavtalet. DATA_PROCESSING.md beskriver behandlingen. |
| 3556 | SKA | Avtalad revisionsrätt och genomförd revision. | Ingen revisionsprocess avtalad. |
| 3557 | SKA | Antagen policy. | Organisatoriskt krav. |

