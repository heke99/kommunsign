# Leveransrapport – KommunSign

Statusdatum: 2026-08-02.

## IMPLEMENTERAT

- Härdad gemensam TypeScript-/Java-kodbas med control plane och tenant data plane.
- Tenantkontext, RBAC, versionerad policy engine, RLS-modell och composite tenant foreign keys.
- Databasskydd mot cross-case-kopplingar och ändring av låsta dokument/policies/identitetsbindningar.
- Separat immutable evidence för `DIGITAL_APPROVAL`.
- Krav på kryptografisk signaturartefakt och accepterad validation för `ELECTRONIC_SIGNATURE`.
- Canonical JSON, SHA-256, Base64, HMAC, nonce/state och evidence payload.
- TIC BankID-adapter med POST poll, GET collect, DELETE cancel, HTTPS/timeoutskydd och Base64-kodad dold data.
- TIC webhook-HMAC, timestamp-, session- och statebindning.
- Freja JWS-verifieringskärna med RS256/ES256 och fail-closed headerkontroller.
- Hållbar worker lease recovery och konsekvent attempt-räkning.
- Audit-hash som täcker tenant, sequence, kategori, actor, resource, payload och tid.
- API-runtime med auktorisering, strikt JSON, body limits, säkra fel och idempotens för create/send/cancel.
- OpenAPI 3.1 med implementationsstatus per operation.
- Java boundaries som vägrar påstå PAdES/validation utan riktig konfiguration.
- Offline verifier-CLI, evidence manifest, CI, SBOM-generator, hemlighetsskanning och migrationskontroll.
- Exakta pins för åtta donorprojekt och verklig 85-procents-/permission-evidence-grind.
- Publik, responsiv och Vercel-förberedd KommunSign-webbplats med säkerhetsheaders, SEO-filer och separata informationssidor.

## VERIFIERAT LOKALT

- TypeScript 5.8.3 strict build.
- Repository- och migrationsstruktur.
- Proveniensgrind: 0 donor-LOC, åtta pins, 0 mapped imports.
- Java 21-kompilering och Freja JWS self-test.
- 19 kärntester för crypto, tenant, policy/evidence, TIC, API, audit, worker, databasregler, publik webb och proveniens.
- Publik webbbuild: 6 HTML-sidor, intern länkkontroll och strikt CSP-kompatibilitet.
- Lokal HTTP-kontroll av samtliga publika sidor, statiska resurser och 404.
- API shell: liveness 200 och readiness 503 tills riktiga dependencies har konfigurerats.

## KRÄVER EXTERNT AVTAL

- TIC test-/produktionstenant och provider-E2E.
- Freja Integrator RP/Integrated RP.
- TSA, CA/trust service provider, e-post, objektlagring och e-arkiv.

## KRÄVER PRODUKTIONSCERTIFIKAT

- Freja mTLS/JWS trust och rotationskedja.
- Sweden Connect SignService/CA/HSM.
- TLS/custom domains och providerwebhooks.

## KRÄVER JURIDISKT BESLUT

- Verifiering och arkivering av de uppgivna donortillstånden.
- Signaturpolicy per handlingstyp.
- Retention, legal hold, informationsklassning, driftregion och underbiträden.

## KVARVARANDE RISK

- SQL-migrationerna kunde inte integrationstestas mot live PostgreSQL i denna körmiljö.
- PAdES/DSS/Sweden Connect är ännu inte verkliga integrationer.
- Bara create/list/get/send/cancel är runtimeimplementerade API-operationer.
- Marknadswebbplatsen är färdig för Vercel-preview, men portalerna är grundskal och inte kompletta verksamhetsgränssnitt.
- Entra ID/SCIM, custom-domain-provisionering, notifieringar, e-arkiv och connectors återstår.
- Penetrationstest, lasttest, återställningstest, WCAG-audit och DPIA krävs före pilot.

## DONORIMPORT

Ingen donor-kod importerades. Tillståndsdokumenten var inte del av uppladdningen och kunde därför inte verifieras eller checksummas. Detta är ett medvetet fail-closed-beslut, inte ett tekniskt hinder i proveniensverktyget.
