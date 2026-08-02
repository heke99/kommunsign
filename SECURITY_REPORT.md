# Säkerhetsrapport – KommunSign 2026-08-02

## Verifierade kontroller

- Tenant hämtas från verifierad kontext och binds till alla utvecklingsruntimeposter.
- Databastransaktioner sätter tenant, aktörstyp, aktör, request-ID och använder lokal transaktionsscope.
- RLS-migrationer använder `FORCE ROW LEVEL SECURITY`; composite tenant-FK och immutable/completion-guards bevaras.
- API:t auktoriserar operationer server-side, begränsar body size, validerar JSON och returnerar stabila fel utan interna exceptionmeddelanden.
- Muterande caseoperationer använder tenantbunden idempotens och canonical payload hash.
- Inbjudningstoken använder 256 bitars entropi, hashad lagring, expiry, revoke och single-use.
- OIDC-transaktion använder PKCE S256, state, nonce, HTTPS-redirectkontroll och constant-time-jämförelse.
- Webhook-endpoints blockeras vid loopback, privata, link-local och osäkra mål; DNS-adresser kan verifieras före leverans.
- Uploadmetadata kontrollerar filnamn, MIME, storlek, SHA-256 och PDF magic bytes.
- Branding saneras; script/HTML/javascript-URL blockeras och kontrast kontrolleras.
- Dev API/workers kan inte startas med produktionsmiljö.
- Signerad PDF, DSS-rapport och evidence package returneras inte utan verklig konfigurerad tjänst.
- Secret scan och förbjudna certifikat-/nyckelfiltyper ingår i verifieringsgrinden.

## Testresultat

- 19 kärntester: gröna.
- Integrationstest för tenant A/B och API-flöde: grönt.
- Säkerhetstest för XSS, SSRF, domain takeover-baskontroller, uploads, invitation replay och OIDC: grönt.
- Java Freja JWS self-test: grönt.
- SQL tenant-escape-test finns men kunde inte köras lokalt utan PostgreSQL; det körs i CI med en NOBYPASSRLS-roll.

## Öppna säkerhetsrisker före pilot

- Ingen live OAuth2/JWK/mTLS- eller Entra/SAML/SCIM-verifiering.
- Ingen komplett PDF-sandbox, antivirus- eller bombtestning.
- Ingen oberoende BankID XML-DSig/OCSP-kedjeverifiering.
- Ingen riktig PAdES/DSS/TSA/CA/HSM-runtime.
- Webhook delivery-worker, faktisk DNS-rebindingkontroll per retry och secret rotation återstår.
- Penetrationstest, SAST/dependency/container scan i full leveranskedja, lasttest och restore-test återstår.
- Produktions-CSP, CSRF/sessioncookies och WAF måste verifieras på de verkliga dynamiska portalerna.

## Beslut

**NO-GO för produktionssignering.**

**GO som utvecklingsbas/lokal demo** under förutsättning att inga riktiga personuppgifter eller skarpa eID-credentials används.
