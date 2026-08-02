# Säkerhetsrapport – KommunSign 2026-08-02

## Verifierade kontroller

- Applicant-, platform- och tenanttrafik klassificeras i separata routegrupper och använder olika kontexttyper.
- Applicant kan inte välja tenant och fel applicanttoken ger 403.
- Tenant hämtas från verifierad kontext; cross-tenant caseuppslag ger 404 i integrationstest.
- Databastransaktioner sätter tenant, aktör och request-ID. RLS/composite tenant-FK/immutable guards är bevarade.
- Onboardingstatus valideras i TypeScript och PostgreSQL. Otillåten direktövergång till `active` blockeras.
- E-post-/access-/invitationstokens bygger på minst 256 bitars entropi och hashad lagringsmodell.
- Ansökningsversioner är append-only och interna uppgifter har separata tabeller/permissionsmodell.
- Databasen blockerar samma aktör från att initiera och godkänna en tenantaktivering.
- Aktivering blockeras när readiness inte är grön.
- API:t begränsar body size, validerar JSON/allowlists och returnerar stabila fel utan exceptionläckage.
- Muterande operationer använder idempotency key, canonical payload hash och versionskontroll där relevant.
- OIDC-kärnan använder PKCE S256, state, nonce, HTTPS-redirectkontroll och constant-time-jämförelse.
- Webhookmål blockeras för loopback, privata och link-local mål; uploadmetadata/PDF magic bytes kontrolleras.
- Branding saneras och kontrast kontrolleras.
- Produktions-API och workers saknar devfallback och stoppar utan explicit produktionsadapter.
- Signerad PDF, DSS-rapport och evidence package returneras inte utan verklig konfigurerad tjänst.
- Secret scan och förbjudna certifikat-/nyckelfiltyper ingår i verifieringsgrinden.

## Testresultat

- 22 core/unit tests: gröna.
- Tenant- och onboardingintegration: gröna för den implementerade utvecklingsslicen.
- Readiness/activation fail-closed: grönt.
- Säkerhetstest för XSS, SSRF, domain guards, uploads, invitation replay och OIDC: grönt.
- HTTP CORS/preflight för applicant/platform och PATCH: grönt.
- Java Freja JWS self-test: grönt.
- SQL tenant/application escape och race tests kunde inte köras lokalt utan PostgreSQL/Docker.

## Öppna säkerhetsrisker före pilot

- Applicantportalen använder dev bearer-token i `sessionStorage`; produktion kräver HttpOnly-cookie, CSRF, rate limit och riktig magic link.
- Produktionsrepositories och DB-behörigheter är inte implementerade eller liveverifierade.
- Ingen komplett bilage-/PDF-sandbox, antivirus- eller bombtestning.
- Ingen live OAuth2/JWK/mTLS eller Entra/SAML/SCIM.
- Ingen oberoende BankID XML-DSig/OCSP-kedjeverifiering.
- Ingen riktig PAdES/DSS/TSA/CA/HSM-runtime.
- Durable webhook/notifierings/archive workers och DNS-rebindingkontroll per retry återstår.
- Penetrationstest, full SAST/dependency/container scan, lasttest och restore-test återstår.
- WCAG 2.2 AA måste verifieras med riktiga browser- och hjälpmedelstester.

## Beslut

**NO-GO för skarp ansökningshantering med personuppgifter och NO-GO för produktionssignering.**

**GO som lokal utvecklingsbas** under förutsättning att endast syntetiska testuppgifter och inga skarpa eID-hemligheter används.
