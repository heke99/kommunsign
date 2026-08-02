# KommunSign – verifierat nuläge 2026-08-02

## Metod

Repositoryt har granskats fil för fil inom den levererade zip-arkivroten. Ingen Git-historik följde med arkivet, så remote, branch och working-tree-status kunde inte verifieras i sandlådan. Källkod, migrationer, byggskript, Java-källor, OpenAPI, portalytor, Docker, Kubernetes, Terraformgrund, tester och proveniensfiler har däremot inspekterats och byggts lokalt med Node 22.16.0, TypeScript 5.8.3 och Java 21.0.10.

## Verifierat implementerat i denna leverans

- Gemensam strikt TypeScript-build och statisk portalbuild.
- Rootkommandon för varje portal, API, workers, databas och testkategori.
- Serverhärledd `TenantContext` och transaktionswrapper som sätter `tenant_id`, `actor_kind`, `actor_id` och `request_id`.
- Sexton runtimeoperationer i OpenAPI och API-router: cases, dokument, signerare, send/cancel/remind, tre artefaktnedladdningar, uploads, webhook endpoints, events och templates.
- Utvecklingsruntime för API med tenantisolerad in-memory-data, idempotens och explicit produktionsspärr.
- Fail-closed resultat för signerad PDF, DSS-rapport och evidence package när externa tjänster saknas.
- Säkerhetsmoduler för OIDC PKCE/state/nonce, branding/kontrast, custom-domainstatus, engångsinbjudningar, uploadmetadata/magic bytes och webhook-SSRF.
- Additiva control-plane- och data-plane-migrationer för federation, SCIM, break-glass, domänjobb, upload grants, notifieringsretry och invitation consumption.
- Funktionell tenantportal mot utvecklings-API samt operativa admin-, signer- och verifieringsytor som inte fabricerar positiv signeringsstatus.
- Docker Compose med separata control/data PostgreSQL, Redis, MinIO, ClamAV, Gotenberg, Mailpit, API, workers och tre Java-tjänster.
- Unit-, integrations- och säkerhetstester utan externa credentials.
- TypeScript-, Java- och C#-SDK-källor versionsbundna till OpenAPI; TypeScript och Java kompileras i verifieringskedjan.

## Verifierat befintligt och bevarat

- Publik Vercelwebb under `apps/public-website` och isolerad `web:build` till `build/public-site`.
- RLS med `FORCE ROW LEVEL SECURITY`, composite tenant-FK och databasguards.
- Audit-hashkedja, durable-job leases, digital approval evidence och completion guards.
- TIC BankID start/poll/collect/cancel-adapter, webhook-HMAC och canonical evidence payload.
- Freja JWS-kryptografisk verifieringskärna i Java.
- Evidence manifest och offlineverifierings-CLI.
- Proveniensgrind med noll importerade donor-rader.

## Delvis implementerat

- Portalytorna är nu exekverbara, men full auth, all konfiguration och samtliga verksamhetsvyer kräver fortsatt backendarbete.
- API-kontrakt och lokal runtime finns för alla sexton kärnoperationer; produktionsadapter mot PostgreSQL/objektlagring är inte färdigkopplad.
- Dokumentpipeline har datamodell, upload grants och klientflöde, men saknar produktionsadapter för presigned upload, ClamAV, Gotenberg och PDF-sandbox.
- Custom-domainmodell och durable jobs finns, men ingen DNS/TLS-provideradapter är inkopplad.
- Notification- och webhookmodeller finns, men produktionsworkers saknar provideradapters och nätverksresolver med rebindingkontroll.

## Externa blockerare

- TIC BankID-testtenant, API-nyckel och verkliga callbacks.
- Freja RP-avtal, mTLS-certifikat, truststore och officiell klientartefakt.
- Sweden Connect SignService/CA-konfiguration, HSM/PKCS#11 och signing credential.
- RFC 3161 TSA och policy-OID.
- EU DSS-dependencies, LOTL/TSL-konfiguration och testvektorer.
- DNS/TLS-providerkonto.
- E-postdomän med DKIM/SPF/DMARC.
- E-arkivmål och leverantörsspecifika avtal.

## Juridiska blockerare

Filerna under `upstream/permissions/*` är endast placeholders. Ingen permission evidence som medger faktisk kodimport har verifierats. `reused_loc` ska därför förbli noll tills dokument, rättighetshavare, omfattning och SHA-256 är verifierade.

## Kvarvarande högriskområden

- Produktions-PostgreSQLrepository och OAuth2/JWK/mTLS-bootstrap.
- Oberoende BankID XML-DSig/OCSP-verifiering.
- Riktig PAdES B/T/LT/LTA och flera inkrementella signaturer.
- DSS-validering och trust-list snapshots.
- Säker dokumentprocessning av fientliga PDF-filer.
- Backup/restore, pentest, lasttest och WCAG-audit i riktig miljö.
- C#-SDK-kompilering i en .NET-miljö.
