# Leveransrapport – KommunSign

Statusdatum: 2026-08-02.

## Samlad status

Den levererade repositorykärnan har byggts vidare till en sammanhängande och verifierbar utvecklingsplattform. Leveransen är **inte en färdig produktionsklar e-signaturtjänst**: extern eID-verifiering, PAdES, EU DSS, CA/HSM/TSA, produktionsauth, objektlagring och live driftprov är fortfarande blockerade eller återstår. Inga sådana resultat har fabricerats.

## IMPLEMENTERAT

- Riktig npm-workspacegrund och samlade rootkommandon för webb, portaler, API, workers, databaser och testkategorier.
- Gemensam strikt TypeScript-build samt separata byggen för fyra portalytor och den befintliga publika Vercelwebben.
- Tenanttransaktionswrapper som alltid sätter `tenant_id`, `actor_kind`, `actor_id` och `request_id` innan domänfrågor.
- Sexton kärnoperationer i OpenAPI och API-router: cases, dokument, signerare, send/cancel/remind, uploads, templates, events, webhooks och tre skyddade artefaktnedladdningar.
- Tenantisolerad utvecklingsruntime med idempotens, canonical payload hash, versionskontroll och explicit produktionsspärr.
- Strukturerade fail-closed-fel för signerad PDF, valideringsrapport och evidence package när signer-/DSS-tjänster saknas.
- Säkerhetsmoduler för OIDC PKCE/state/nonce, 256-bitars engångsinbjudningar, uploadmetadata/PDF magic bytes, branding/XSS/kontrast, custom domains och webhook-SSRF.
- Additiva control-plane-migrationer för OIDC/SAML-konfiguration, SCIM-token, sessionsspårning, break-glass och domänprovisioneringsjobb.
- Additiv data-plane-migration för upload grants, invitation consumption/revocation, notifieringsretry/bounce/complaint och idempotensresponse-hash.
- Funktionell tenantportal för lokalt case-, dokument-, signerare-, send-, reminder- och eventflöde.
- Operativa platform-admin-, signer- och verifieringsportaler som visar readiness och aldrig avgör kryptografiskt resultat i frontend.
- Docker Compose för separata control/data PostgreSQL, Redis, MinIO, ClamAV, Gotenberg, Mailpit, API, workers och Java-tjänster.
- TypeScript-, Java- och C#-SDK-källor versionsbundna till OpenAPI `2026-08-02.2`; TypeScript och Java kompileras/verifieras i leveransen.
- CI-jobb för kodverifiering och live PostgreSQL-migration/RLS/tenant-escape-test.

## VERIFIERAT I DENNA KÖRMILJÖ

- Node.js 22.16.0, TypeScript 5.8.3 och Java 21.0.10.
- Strikt TypeScript-kompilering inklusive TypeScript-SDK.
- Fyra portalbyggen.
- Repository-, migrations-, proveniens-, SDK-synk- och hemlighetsgrindar.
- Java 21-kompilering för tre servicegränser och Java-SDK.
- Freja JWS self-test.
- 19 kärntester.
- Tenantisolerat API-integrationsflöde inklusive cross-tenant 404 och fail-closed artefaktförsök.
- Säkerhetstester för branding/XSS/kontrast, webhook-SSRF, custom domains, uploads, invitations och OIDC.
- Publik webbbuild med sex HTML-sidor.
- API-smoke: readiness och skapande av tenantbundet case i utvecklingsruntime.

## INTE VERIFIERAT LOKALT

- `npm ci` mot den isolerade körmiljöns interna npm-spegel; spegeln saknade arkivet för TypeScript 5.8.3. Exakt global TypeScript 5.8.3 användes för verifiering. `package-lock.json` är fortsatt låst och CI använder normalt `npm ci`.
- Live PostgreSQL eftersom Docker och `psql` saknades i sandlådan. Migrationerna och det icke-superuserbaserade RLS/tenant-escape-testet finns i CI och ska köras efter synk.
- C#-kompilering eftersom .NET SDK saknades; C#-SDK-källan versionssynkades men ska kompileras i .NET-CI innan publicering.
- E2E, last, penetrationstest, backup/restore och full WCAG 2.2 AA-audit.

## EXTERNA BLOCKERARE

- TIC BankID-testtenant, API-nyckel, webhook secret och verifierbara testtransaktioner.
- Freja RP-avtal, officiell klientartefakt, mTLS-certifikat, truststore och verifieringsnycklar.
- Sweden Connect SignService/CA, signing credential, HSM/PKCS#11 och key ceremony.
- RFC 3161 TSA och policy-OID.
- EU DSS, LOTL/TSL/trusted-list-konfiguration och officiella valideringsvektorer.
- DNS/TLS-providerkonto, objektlagring, e-postdomän och e-arkivmål.

## JURIDISKA BLOCKERARE

- `upstream/permissions` innehåller inga verifierade signerade tillstånd. Därför har ingen donor-kod importerats och `reused_loc` är fortsatt noll.
- Signaturpolicy, retention, informationsklassning, driftregion, underbiträden och arkivkrav måste beslutas per kund/handlingstyp.

## KVARVARANDE HÖGRISKARBETE

- Produktionsrepositories mot PostgreSQL och objektlagring för samtliga API-operationer.
- OAuth2/JWK/mTLS, Entra OIDC, SAML, SCIM och WebAuthn i riktig runtime.
- Fientlig PDF-processning, antivirus, canonicalisering och tillgänglig PDF-fältbyggare.
- Oberoende BankID XML-DSig/OCSP-verifiering och Freja live/mTLS.
- Riktig PAdES B/T/LT/LTA, flera inkrementella signaturer, DSS-validering och signerad/tidsstämplad evidence package.
- Durable webhook-/notification-/archive-workers, retention/legal hold och tenantoffboarding.
- OTel, referensdeployment, backup/restore, penetrationstest, belastningstest och WCAG-bevis.

## SLUTBEDÖMNING

Leveransen förbättrar repositoryt utan att bryta den publika webbplatsen eller skriva om tidigare migrationer. Den är lämplig som verifierad nästa utvecklingsbas och lokal demo, men får inte markeras som produktionsklar förrän återstående krav i `docs/verification/requirements-traceability.md` är verifierade.
