# Återstående genomförandeplan

## Fas 1 – produktionssätt onboardinggrunden

1. Implementera `createProductionDependencies` med PostgreSQLrepositories för hela onboardingkontraktet och transaktionell idempotens.
2. Lägg RLS/GRANT-modell eller separat control-plane service role med minsta privilegium och databasintegrationstester för applicant A/B och intern data.
3. Implementera magic-linkleverans, HttpOnly-session, CSRF, rate limits och revoke.
4. Implementera S3/MinIO-bilagor med quarantine, checksum completion, ClamAV och Gotenberg.
5. Implementera durable provisioningworker med step leases, retry, compensation policy och resursverifiering.
6. Implementera aktiva readinessadaptrar och atomisk tvåpersonsgodkänd aktivering.

**Exit:** onboarding-E2E körs mot riktig PostgreSQL/storage/mail och tenant skapas endast i `onboarding`.

## Fas 2 – identity och portaler

1. Plattform: OIDC + WebAuthn/FIDO2, korta sessioner, rotation och revoke.
2. Tenant: Entra OIDC discovery/JWK/PKCE/state/nonce, SAML-signaturkontroll, JIT och gruppmappning.
3. SCIM Users/Groups/membership/deactivation med hashade tenanttokens.
4. Färdigställ platform admin, tenantportal och onboardingportal mot produktionsauth och API.
5. Persist branding och custom-domainworkflow med DNS/TLS-provideradapter.

**Exit:** server-side RBAC och isolation är bevisade för alla portalroller.

## Fas 3 – dokumentpipeline och signerportal

1. Durable upload grants och immutable document versions.
2. PDF-säkerhetskontroller, bombgränser, sandbox och canonical PDF/PDF-A.
3. PDF.js-viewer och tillgänglig fältbyggare med normaliserade koordinater.
4. Signerinbjudningar, accesskontroll och serverstyrd sekventiell/parallell ordning.
5. Durable notifieringar, reminders, bounce/complaint och locale/versionerade mallar.

**Exit:** inget dokument kan skickas innan scan/canonicalisering och signerstatus styrs endast av backend.

## Fas 4 – eID, PAdES och validation

1. TIC testtenant, collect/webhooks och oberoende XML-DSig/certifikat/OCSP-verifiering.
2. Frejas officiella Java-klient, mTLS, dynamisk QR och JWS-nyckelrotation.
3. Sweden Connect SignService, CA/TSP credentials, RFC 3161 och PKCS#11/HSM.
4. PAdES B/T/LT/LTA med inkrementella multipla signaturer.
5. EU DSS, LOTL/TSL, OCSP/CRL/timestamps och ETSI reports.
6. Komplett evidence package och verifierbar signed/timestamped manifest.

**Exit:** live test-E2E är grönt utan mocks och externa artefakter är bevarade.

## Fas 5 – integration, governance och drift

1. Durable webhooks med HMAC, rotation, DNS rebinding-skydd, DLQ och replay.
2. Connector SDK och e-arkivexport med kvitto/checksum.
3. Retention, legal hold, deletion certificate, data export och tenantoffboarding.
4. OpenTelemetry, certifikatlarm, quotas och operativa dashboards.
5. Backup/restore med tenantisolerat återläsningsbevis.
6. SAST, dependency/container/license scans, SBOM, signering och provenance i release.

## Fas 6 – oberoende verifiering

- Penetrationstest utan blockerande fynd.
- Lasttest med p50/p95/p99, error rate, queue lag och DB saturation.
- WCAG 2.2 AA med axe, tangentbord, skärmläsare, zoom, mobil och PDF-fältlista.
- Disaster recovery och restoreövning.
- Produktionstillstånd först efter godkänd readinessrapport.

## Stop-the-line

- Ingen aktiv tenant direkt från ansökan eller godkännandebeslut.
- Ingen in-memory-, testprovider- eller mjuk testnyckel i produktion.
- Ingen providercompletion utan servercollect och kryptografisk verifiering.
- Ingen `completed` utan validatorresultat och evidence.
- Ingen donor-kod utan verifierad permission evidence.
