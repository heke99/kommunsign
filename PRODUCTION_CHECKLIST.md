# Produktionschecklista – KommunSign

En punkt får endast markeras klar när ett sparat verifieringsbevis finns.

## Repository och release

- [x] TypeScript strict build grön.
- [x] Java 21 build och self-test grön.
- [x] Repository/migration/proveniens/secret/SDK-grind grön.
- [x] Publik webb och fem portalbyggen gröna.
- [ ] Git-remote, branch och clean working tree verifierade i `/Users/hekmath/Projects/kommunsign`.
- [ ] `npm ci` grön mot ordinarie registry/CI.
- [ ] C#-SDK kompilerad och kontraktstestad.
- [ ] SAST, dependency-, container- och licensscan utan blockerande fynd.

## Ansökan och control plane

- [x] Statusmaskin och otillåtna övergångar testade.
- [x] Applicant-, platform- och tenantrouter separerade.
- [x] Ansökningsnummer och tokenkärna unittestade.
- [x] Review, beslut, provisioning och blockerad aktivering integrationstestade i devruntime.
- [ ] Migration `0006` körd på tom och uppgraderad live PostgreSQL.
- [ ] Parallell referensnumrering verifierad utan dubblett.
- [ ] Applicant A kan inte läsa applicant B i live databas.
- [ ] Interna notes/risk/reviews är osynliga för applicant på DB- och API-nivå.
- [ ] Magic-linkmail, HttpOnly-cookie, CSRF, revoke och rate limit verifierade.
- [ ] Bilagor går via presigned upload, quarantine, antivirus och PDF-sandbox.
- [ ] Dubblettsignal och organisationsregisterprovider verifierade.

## Provisioning, readiness och aktivering

- [x] Provisioningdatamodell och fail-closed produktionsworker finns.
- [x] Tenant skapas inte före godkännande och lämnas i `onboarding` i verifierat devflöde.
- [x] Databasguard blockerar aktiveringsinitiator som approver.
- [ ] Varje provisioningsteg är durable, idempotent och återupptagningsbart i live miljö.
- [ ] Databas, storage, queue/cache, KMS, policies, roller, domän och admininbjudan provisioneras.
- [ ] Aktiva readinesskontroller för DB/storage/DNS/TLS/providers/webhook/archive/mail är gröna.
- [ ] Acceptanstest sparat och verifierat.
- [ ] Två distinkta personer har godkänt aktivering atomiskt.
- [ ] Konfigurationssnapshot och aktiveringsrapport skapad.

## Databas och tenantisolering

- [ ] Control/data migrationer körda på tom och realistisk fler-tenantdatabas.
- [ ] RLS/tenant-escape-test grönt med NOBYPASSRLS-roll.
- [ ] Produktionsrepositories använder verifierad tenanttransaktion.
- [ ] Shared, dedicated och customer-hosted data plane verifierade.

## Identitet och eID

- [ ] Platform OIDC/WebAuthn/MFA/session revoke verifierat.
- [ ] Entra OIDC och SAML verifierat per tenant.
- [ ] SCIM users/groups/deactivation verifierat.
- [ ] TIC start/QR/same-device/webhook/collect/cancel/expiry verifierat i testtenant.
- [ ] BankID XML-DSig, certifikatkedja och OCSP verifierat oberoende.
- [ ] Freja officiell klient, mTLS, JWS och rotation verifierat.

## Dokument, signering och validation

- [ ] Presigned single-use upload mot objektlagring.
- [ ] ClamAV, magic bytes, PDF actions, embedded files och bombgränser verifierade.
- [ ] Canonical PDF/PDF-A och immutable versioner verifierade.
- [ ] PDF.js-fältbyggare och tangentbordsalternativ godkända.
- [ ] Sekventiell och parallell signering verifierad.
- [ ] PAdES B/T/LT/LTA och multipla inkrementella signaturer verifierade.
- [ ] EU DSS med LOTL/TSL, OCSP, CRL och timestamps verifierat.
- [ ] Completion kräver accepterat DSS-resultat.
- [ ] HSM/PKCS#11 verifierat och mjuk testnyckel spärrad.

## Evidence, integration och drift

- [ ] Evidence package komplett med signerat/tidsstämplat manifest.
- [ ] Offline verifier upptäcker tillagd, borttagen och ändrad fil.
- [ ] Durable HMAC-webhooks med retry, DLQ, replay och DNS-rebindingkontroll.
- [ ] E-post med DKIM/SPF/DMARC, bounce och complaint events.
- [ ] E-arkivexport med checksumma och delivery receipt.
- [ ] Retention/legal hold/deletion certificate/tenantoffboarding verifierat.
- [ ] OpenTelemetry, dashboards och certifikatlarm aktiva.
- [ ] Backup, tenant-only restore, rollback och incidentrunbooks testade.
- [ ] Penetrationstest utan blockerande fynd.
- [ ] Belastningsmål verifierade.
- [ ] WCAG 2.2 AA verifierat.

## Produktionsbeslut

- [ ] Säkerhetsansvarig har godkänt.
- [ ] Juridik/DPIA/biträdesavtal/underbiträden har godkänts.
- [ ] Produktägare har godkänt signatur- och retentionpolicy.
- [ ] Drift har godkänt RPO/RTO/SLA/SLO och incidentprocess.
- [ ] Activation approver är en annan person än initiatorn.
