# Produktionschecklista – KommunSign

En punkt får endast markeras klar när ett sparat verifieringsbevis finns.

## Repository och leverans

- [x] TypeScript strict build grön.
- [x] Java 21 build och self-test grön.
- [x] Repository/migrations/proveniens/secret/SDK-grind grön.
- [x] Publik webb och portalbyggen gröna.
- [ ] Git-remote, branch och clean working tree verifierade i `/Users/hekmath/Projects/kommunsign`.
- [ ] C#-SDK kompilerad och kontraktstestad.
- [ ] SAST, dependency-, container- och licensscan utan blockerande fynd.

## Databas och tenantisolering

- [ ] Migrationer körda på tom live PostgreSQL.
- [ ] Migrationer körda på realistisk fler-tenantkopia.
- [ ] RLS/tenant-escape-test grönt med NOBYPASSRLS-roll.
- [ ] Produktionsrepositories använder alltid `withTenantTransaction`.
- [ ] Shared, dedicated och customer-hosted data plane verifierade.

## Identitet och eID

- [ ] Platform WebAuthn/MFA/session revoke verifierat.
- [ ] Entra OIDC och SAML verifierat per tenant.
- [ ] SCIM users/groups/deactivation verifierat.
- [ ] TIC start/QR/same-device/webhook/collect/cancel/expiry verifierat i testtenant.
- [ ] BankID XML-DSig, certifikatkedja och OCSP verifierat oberoende.
- [ ] Freja officiell klient, mTLS, JWS och rotation verifierat.

## Dokument och signering

- [ ] Presigned single-use upload mot objektlagring.
- [ ] ClamAV, magic bytes, PDF actions, embedded files och bombgränser verifierade.
- [ ] Canonical PDF/PDF-A och immutable versioner verifierade.
- [ ] PDF.js-fältbyggare och tangentbordsalternativ godkända.
- [ ] Sekventiell och parallell signering verifierad.
- [ ] PAdES B/T/LT/LTA och flera inkrementella signaturer verifierade.
- [ ] Mjuk testnyckel spärrad i produktion; HSM/PKCS#11 verifierat.

## Validering och evidence

- [ ] EU DSS med LOTL/TSL, OCSP, CRL och timestamps verifierat.
- [ ] Completion kräver accepterat DSS-resultat.
- [ ] Evidence package innehåller alla artefakter och signerat/tidsstämplat manifest.
- [ ] Offline verifier upptäcker tillagd, borttagen och ändrad fil.
- [ ] Publik verifieringsportal kör isolerat och raderar filer automatiskt.

## Integration och drift

- [ ] OAuth2 client credentials, scopes, JWK rotation och mTLS verifierat.
- [ ] Durable HMAC-webhooks med retry, DLQ, replay och DNS-rebindingkontroll.
- [ ] E-post med DKIM/SPF/DMARC, bounce och complaint events.
- [ ] E-arkivexport med checksumma och delivery receipt.
- [ ] Retention/legal hold/deletion certificate/tenantoffboarding verifierat.
- [ ] OpenTelemetry, dashboards och certifikatlarm aktiva.
- [ ] Backup, tenant-only restore, rollback och region/provider-runbooks testade.
- [ ] Penetrationstest utan blockerande fynd.
- [ ] Belastningsmål verifierade.
- [ ] WCAG 2.2 AA verifierat.

## Produktionsbeslut

- [ ] Säkerhetsansvarig har godkänt.
- [ ] Juridik/DPIA/biträdesavtal/underbiträden har godkänts.
- [ ] Produktägare har godkänt signatur- och retentionpolicy.
- [ ] Drift har godkänt RPO/RTO/SLA/SLO och incidentprocess.
