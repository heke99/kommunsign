# Leveransrapport – KommunSign ansökningsstyrd onboarding

Statusdatum: 2026-08-02.

## Mål

Målet för denna leverans var att ta den befintliga repositorysnapshoten från statiska portalgränser och utvecklingsruntime till en sammanhängande, säker onboardinggrund:

```text
ansökan -> e-postverifiering -> submit -> review/komplettering -> beslut
-> provisioning -> tenant:onboarding -> readiness -> blockerad aktivering tills alla krav är gröna
```

Den fulla masterpromptens hela produktionsprodukt är större än vad som sanningsenligt kan färdigställas utan produktionsadaptrar, providers, certifikat, HSM och testmiljö. Leveransen markerar därför varje återstående del utan att fabricera gröna resultat.

## Implementerat

### Control plane och onboarding

- `apps/onboarding-portal` med skapa, verifiera, redigera, skicka in, återkalla, meddelanden och kompletteringar.
- Publik `/ansok`-sida som leder till separat applicantdomän.
- Applicant-/platform-/tenantrouting med separata säkerhetskontexter.
- Strikt statusmaskin med stabilt `409 INVALID_APPLICATION_STATE_TRANSITION`.
- 256-bitars tokenkärna, hashning, normalisering, expiry/revoke/consume-modell.
- Atomiska `ONB-ÅÅÅÅ-NNNNNN`-nummer via PostgreSQL-sekvens.
- Immutable ansökningsversioner, contacts, documents, reviews, assignments, info requests/responses, decisions, notes, messages, risk, checklistor och tasks.
- Platform admin-kö och ärendedetalj för review, komplettering, beslut, provisioning och audit.
- Utökad plattforms-RBAC för onboardingroller.

### Provisioning, readiness och aktivering

- Provisioning requests, steps och attempts i additiv migration.
- Idempotent utvecklingssaga som inte skapar tenant före godkännande och aldrig aktiverar automatiskt.
- Tenant lämnas i status `onboarding`.
- Readiness engine med blocking/warning/completed.
- Fail-closed aktiveringsbegäran när obligatoriska kontroller saknas.
- Activation requests/approvals och databasguard mot självgodkännande.

### Produktionsgränser och synkronisering

- Produktions-API kräver explicit adaptermodul, control/data database, object storage och queue; ingen in-memoryfallback.
- Produktionsworker kräver durable adapter och kan inte starta dev runner.
- API-/worker-Dockerbilder använder produktionsentrypoints.
- Lokal Docker Compose överskriver devworker explicit och blandar inte entrypoints oavsiktligt.
- CORS, API-port `8787`, platform admin och onboardingportal är synkroniserade.
- OpenAPI och SDK-version uppdaterad till `2026-08-02.3`.
- Kravspårning, målarkitektur, onboardingarkitektur och production-readinessrapport skapade.

## Verifierat

- `npm run verify`: grönt.
- TypeScript strict build: grönt.
- Fem portalbyggen: gröna.
- Repository-, SQL migration static-, proveniens-, SDK-, secret- och Java-grindar: gröna.
- 22 unit/core tests: gröna.
- Tenant-API-integration och cross-tenant 404: grönt.
- Onboardingintegration från create till provisioning samt fail-closed activation: grönt.
- Säkerhetstester för branding, SSRF, domains, uploads, invitations och OIDC: gröna.
- OpenAPI YAML parse: 3.1.0, 40 paths.
- Publik webbbuild: sju HTML-sidor inklusive `/ansok`.
- HTTP-smoke: readiness, CORS preflight med PATCH/applicantheaders och ansökningsskapande: grönt.
- Produktions-API och worker stoppar korrekt utan produktionsadapter: verifierat.

## Miljöbegränsningar

- Zippen saknade `.git`; branch/remote/working tree kunde inte verifieras.
- `npm ci` kunde inte hämta TypeScript 5.8.3 från sandlådans interna registry. Exakt global TypeScript 5.8.3 användes via en temporär lokal länk som inte ingår i paketen.
- Docker och `psql` saknades; live PostgreSQL-migration/RLS/race-test kunde inte köras här.
- .NET SDK saknades; C#-SDK versionssynkades men kompilerades inte.

## Inte färdigt

- Riktig PostgreSQLimplementation av `createProductionDependencies`.
- Applicant magic-linkmail, HttpOnly-session, CSRF och rate limiting.
- Verklig storage/quarantine/ClamAV/Gotenberg för ansökningsbilagor och signeringsdokument.
- Durable provisioning av databas, storage, queue, KMS, domän och initial admin.
- OIDC/WebAuthn/SAML/SCIM runtime.
- TIC/Freja live-E2E och oberoende certifikat/OCSP-verifiering.
- Sweden Connect, PAdES, TSA, CA/HSM och EU DSS.
- Durable notifieringar/webhooks, connectors/e-arkiv, retentionjobs och restore.
- Penetrationstest, lasttest och full WCAG 2.2 AA.

## Externa och juridiska blockerare

Se `docs/verification/requirements-traceability.md` och `docs/verification/production-readiness.md`. Ingen donor-kod har importerats; verifierad permission evidence saknas fortfarande.

## Slutbedömning

**GO som granskad utvecklingsbas och för fortsatt implementation.**

**NO-GO för skarp onboarding med personuppgifter och NO-GO för produktionssignering** tills produktionsadaptrar, live databasbevis och alla blockerande providers/säkerhetstester är färdiga.
