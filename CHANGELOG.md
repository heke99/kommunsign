# Changelog

Krav 2060: ändringsdokumentation och releasenotes produceras löpande i samband
med leverans. Format enligt Keep a Changelog, versionering enligt semver.

## [Ej släppt] — remediation 2026-08-07

Fullständig remediationkampanj mot Kungälvs kravbild (Dnr KS2026/1005).

### Tillagt

- **Signeringsmotor.** Providerneutral gräns (`SigningEngine`,
  `SignatureValidator`, `TimestampProvider`, `CertificateProvider`) och ordnad
  signeringspipeline som binder signaturen till exakt den låsta
  dokumentversionen. Fail-closed som standard.
- **Freja-adapter.** Freja eID, Freja eID Plus och Freja OrgID med
  bindningskontroll av JWS-svar, replayskydd och organisationsidentitet.
- **Workforce-federation.** Protokollneutral SAML 2.0 och OIDC med
  deny-by-default rollmappning och single logout.
- **SCIM 2.0-provisionering.** Users och Groups ovanpå befintlig
  användarmodell, idempotent på `externalId`.
- **Arkivexport.** FGS-paket enligt RA-FS 2009:2, deterministiskt och
  verifierbart offline.
- **Gallringsexekvering.** Kö, plan, godkännande, körning, verifiering och
  rapport med omprövning av beslutet före radering.
- **GDPR-exekvering.** Livscykel för rättighetsbegäran med identitetsverifiering
  och frist räknad från mottagandet.
- **Skyddade personuppgifter.** Maskeringspolicy per utflödeskanal.
- **Signeringsflöde.** Sekventiell och parallell ordning, flera dokument,
  bilagor och påminnelser.
- **Nyckelrotation.** Staged rotation med dual read och verifierad
  återkryptering, samt separat rotation av blind index.
- **Tillgänglighetsgrind.** WCAG 2.2 AA-kontroll i `npm run verify`.
- **Systemdokumentation** och **behörighetsmodell** på svenska.

### Ändrat

- Beroendepolicyn ersätter det generella förbudet med en
  antagningsgrind (ADR 0003). Egen kryptografi skrivs inte.
- `control.tenant_identity_providers` accepterar generiska protokollnycklar, så
  annan IdP än Entra kan konfigureras.

### Åtgärdat

- Sex WCAG-brister i portalerna: saknad minsta klickyta, odeklarerat färgschema
  och saknad `autocomplete`.
- Dubbletter i gallringsutfall passerade verifieringen.
- Nyckelringskontrollen omöjliggjorde rotation bort från en komprometterad
  nyckel.

### Säkerhet

- Rotationsstöd för de nycklar som exponerats i Git-historik. Den operativa
  rotationen kvarstår som åtgärd.

## [0.2.0] — 2026-08-06

Föregående leverans. Se `docs/audits/production-remediation/FINAL_REMEDIATION_REPORT.md`.
