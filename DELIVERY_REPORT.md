# Leveransrapport

## IMPLEMENTERAT

- Greenfield-monorepo och tydliga servicegränser.
- Tenantkontext, RBAC, versionerad policy engine och serverstyrda statusmaskiner.
- Canonical JSON, SHA-256, HMAC, nonce/state och evidence payload.
- TIC BankID startadapter, collect/status/cancel som explicit konfigurerbara kontrakt samt webhookverifiering.
- Databasschema för control plane, data plane, identitet, signatur, validering, audit, outbox, webhook, arkiv och usage.
- PostgreSQL RLS och composite tenant foreign keys.
- OpenAPI 3.1, idempotensmodell, signerade webhookkontrakt och offline verifier-CLI.
- Java boundary services som vägrar påstå kryptografisk signering/validering utan konfiguration.
- White-label design tokens och tillgängliga portalgrundsidor.
- CI, säkerhetsgrindar, IaC-bas, monitoringregler, runbooks och proveniensgrind.

## VERIFIERAT LOKALT

- TypeScript strict build.
- Kärntester för canonical JSON, hash, statusmaskin, policy, tenantkontext, HMAC och evidence package.
- Repositorystruktur och förbjudna hemlighetsfiltyper.
- Proveniensgräns: 0 importerade donor-LOC och blockerad import utan tillstånd/pin.
- Java 21-kompilering av boundary services.

## KRÄVER EXTERNT AVTAL

- TIC produktions-/testtenant och fullständigt godkända endpointkontrakt.
- Freja Integrator RP och Integrated RP per kund.
- TSA, CA/trust service provider, e-post och e-arkiv.

## KRÄVER PRODUKTIONSCERTIFIKAT

- Freja mTLS/JWS trust.
- Sweden Connect SignService/CA/HSM.
- TLS/custom domains och providerwebhooks.

## KRÄVER JURIDISKT BESLUT

- Donortillstånd och licensmodell.
- Signaturpolicy per handlingstyp.
- Retention, legal hold, informationsklassning och underbiträden.

## KVARVARANDE RISK

- PAdES/DSS är arkitekturellt avgränsat men inte produktionsintegrerat i denna lokala leverans.
- Portalgränssnitten är grundskal och inte kompletta verksamhetsvyer.
- Infrastruktur måste bindas till vald svensk/EU-driftleverantör och genomgå penetrationstest, återställningstest och DPIA innan pilot.
