# KommunSign – verifierat nuläge 2026-08-02

## Verifieringsgräns

Den levererade zippen har granskats som en fristående källkodssnapshot. Arkivet innehöll ingen `.git`-katalog. Git-rot, remote, branch, tidigare commits och lokala hemligheter kunde därför inte verifieras eller ändras i sandlådan. Efter synk måste detta göras i `/Users/hekmath/Projects/kommunsign` innan commit.

Källkod, migrationer, OpenAPI, portaler, Dockerfiler, CI, TypeScript och Java har inspekterats. Den tillgängliga npm-spegeln kunde inte hämta den redan låsta TypeScript 5.8.3-tarballen. Bygg och tester har därför körts med den globalt installerade, exakt matchande TypeScript 5.8.3 via en tillfällig lokal länk. Länken och `node_modules` ingår inte i leveransen.

## Verifierat implementerat i denna leverans

### Ansökningsstyrd onboarding

- Separat `apps/onboarding-portal` samt publik landningssida `/ansok` som leder till `kommunsign.se/ansok/`.
- Publika ansökningsendpoints, sökandeauktorisering, plattformsendpoints, provisioning-, readiness- och aktiveringsendpoints.
- Särskilda säkerhetskontexter för sökande, plattform och tenant. Publik ansökan passerar inte tenantroutern och kan inte välja tenant.
- Strikt servervaliderad ansökningsstatusmaskin och `409 INVALID_APPLICATION_STATE_TRANSITION`.
- 256-bitars e-post- och åtkomsttokenkärna, hashning, normalisering och replay-/expiry-fält i datamodellen.
- Atomiskt mänskligt ansökningsnummer `ONB-ÅÅÅÅ-NNNNNN` genom PostgreSQL-sekvens.
- Immutable ansökningsversioner, externa meddelanden, interna anteckningar, kompletteringskrav och svar.
- Kommersiell, juridisk, säkerhetsmässig och teknisk reviewmodell.
- Additiv control-plane-migration `0006_onboarding_and_activation.sql` med onboarding-, provisioning-, readiness- och aktiveringstabeller.
- Databasguard som blockerar samma person från att initiera och godkänna en aktivering.
- Idempotent utvecklingssaga som skapar tenant först efter beslut och lämnar den i `onboarding`, aldrig `active`.
- Central readinessmotor som returnerar blockerande, varnande och genomförda kontroller och stoppar aktivering fail-closed.
- Platform admin-kö och ärendedetalj för review, komplettering, beslut, provisioning och audit.
- OpenAPI 3.1-kontrakt och synkroniserad SDK-version `2026-08-02.3`.

### Produktionsgränser

- `apps/api/src/production-runtime.ts` kräver riktiga control/data-databasadaptrar, objektlagring, kö och plattforms-/tenantauth. Den faller aldrig tillbaka till in-memory.
- `apps/workers/src/production-runner.ts` kräver en durable produktionsadapter och kan inte starta utvecklingsrunnern i produktion.
- API- och worker-Dockerbilder startar produktionsentrypoints. Docker Compose överskriver workerkommandot explicit endast i lokal utvecklingsprofil.
- CORS stöder `PATCH`, applicant bearer-token och separata plattformshuvuden för de lokala portalflödena.

### Bevarad bas

- Strict TypeScript, Node 22 och Java 21.
- Separata control- och data-plane-migrationer.
- `TenantContext`, transaktionswrapper, RLS, composite tenant-FK och audit-hashkedja.
- Sexton befintliga signerings-API-operationer, idempotens, upload-/webhookskydd och fail-closed artefaktnedladdningar.
- TIC-adaptergrund, Freja JWS-kärna, evidence manifest och offlineverifierings-CLI.
- Publik Vercelwebb och statiska portalbyggen.

## Verifierat med automatiserade kommandon

- `npm run build`
- `node tests/run.mjs`
- `node tests/integration.mjs`
- `node tests/security.mjs`
- `npm run verify:sdk`

Den fulla `npm run verify` och databasverifieringen ska köras igen efter dokument- och paketeringssteget. Resultatet dokumenteras i `VERIFICATION_RESULTS.txt`.

## Delvis implementerat

- Onboarding fungerar end-to-end i utvecklingsruntime och har produktionsschema/kontrakt, men riktig PostgreSQLrepository, objektlagring, e-postleverans och sessionscookie-adapter saknas.
- Sökandeportalen använder ett utvecklingsflöde med bearer-token i `sessionStorage`; produktion ska använda kortlivad HttpOnly-cookie/session och riktig magic-linkleverans.
- Provisioningdomänen och stegtabellerna finns, men verklig resursprovisionering av databas, storage, queue, KMS, domän och initial admin kräver produktionsadaptrar.
- Readinessmotorn och fail-closed aktiveringsgrind finns, men aktiva kontrolladaptrar för DNS/TLS/provider/e-arkiv/e-post saknas.
- Signerings-, dokument-, identity-, archive- och notificationdelarna är fortfarande delvis implementerade enligt kravspårningen.

## Inte verifierat eller inte färdigt

- Live PostgreSQL-körning av migration `0006` i denna sandlåda, om lokal Docker/PostgreSQL inte är tillgänglig.
- Produktions-OIDC/WebAuthn/SAML/SCIM.
- Säkra presigned uploads, ClamAV- och Gotenbergworkers.
- TIC live/test-E2E, BankID XML-DSig och OCSP.
- Freja officiell klient och mTLS.
- Sweden Connect SignService, PAdES B/T/LT/LTA, TSA, CA och HSM.
- EU DSS, trusted lists och ETSI-rapporter.
- E-arkiv/connectors, notifieringsprovider, retentionjobb och restore.
- Full last-, penetration- och WCAG 2.2 AA-verifiering.

## Externa blockerare

`TIC_TEST_CREDENTIALS_MISSING`, `FREJA_TEST_CERTIFICATE_MISSING`, `TSA_TEST_ACCOUNT_MISSING`, `HSM_NOT_AVAILABLE`, `TRUST_SERVICE_CONTRACT_MISSING`, `VERCEL_DOMAIN_PROVIDER_NOT_CONFIGURED`, `ARCHIVE_TEST_ENDPOINT_MISSING`, e-postdomän/provider och målmiljö för backup/restore.

## Juridisk blockerare

Permissionfilerna under `upstream/permissions` är fortfarande placeholders. Ingen donor-kod har lagts till. Proveniensgrinden ska fortsätta kräva verifierad rättighetshavare, tillståndsomfattning och SHA-256 innan återanvänd kod förs in.
