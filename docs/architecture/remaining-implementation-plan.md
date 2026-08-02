# Återstående genomförandeplan

## Prioritet 1 – produktionsdata och autentisering

1. Implementera låst PostgreSQL-driveradapter bakom `SqlDatabase` och repositories för samtliga sexton API-operationer.
2. Kör migrationer på tom och realistisk fler-tenantdatabas; bevisa RLS med en icke-superuserroll.
3. Implementera OAuth2 client credentials med JWK/JWT, scopes, rotation och valfritt mTLS.
4. Implementera plattforms-WebAuthn och tenantunik Entra OIDC/SAML med signerad metadata, PKCE, state/nonce och gruppmappning.
5. Implementera SCIM users/groups/memberships/deactivation mot tenantdataplanet.

## Prioritet 2 – dokument och signerflöde

1. Koppla S3/MinIO-adapter till `upload_grants` med single-use completion callback.
2. Bygg workers för ClamAV, magic bytes, PDF actions, bombgränser, Gotenberg och immutable document versions.
3. Färdigställ PDF.js-viewer och normaliserad fältbyggare med tangentbordsalternativ.
4. Implementera signer invitation/session API och serverstyrd sekventiell/parallell ordning.
5. Implementera durable notifieringar och reminders med provider events.

## Prioritet 3 – eID, PAdES och validation

1. Kör TIC-adaptern mot testtenant och bygg oberoende XML-DSig/OCSP-verifiering.
2. Integrera Frejas officiella Java-klient, mTLS, dynamisk QR och nyckelrotation.
3. Skapa Mavenprojekt med explicit låsta Sweden Connect-, CA- och EU DSS-versioner efter dependency/proveniensgranskning.
4. Implementera PAdES B/T/LT/LTA, RFC 3161 och PKCS#11/HSM; blockera mjuk nyckel i produktion.
5. Implementera DSS simple/detailed/diagnostic/ETSI reports och completion guard mot verifierat resultat.

## Prioritet 4 – integration, retention och drift

1. Durable outgoing webhooks med DNS-resolution vid varje försök, privata IP-blockeringar, rotation och DLQ.
2. Connector SDK, Generic REST/webhook/SFTP/M365 och e-arkivexport med kvitto.
3. Retention, legal hold, dry-run, deletion certificate och tenantoffboarding.
4. OpenTelemetry, dashboards, certifikatlarm, backup och tenant-only restore.
5. Full CI för live DB, containers, SAST, dependency/license/container scan, SDK generation, E2E, last och WCAG.

## Stop-the-line-regler

- Ingen providerstatus får översättas till `signed` utan servercollect och kryptografisk verifiering.
- Ingen e-signaturcase får bli `completed` utan accepterad DSS-validering.
- Ingen donor-kod får importeras innan permission evidence och reuse-map är verifierade.
- Ingen testadapter, mjuk nyckel eller testprovider får starta i produktion.
