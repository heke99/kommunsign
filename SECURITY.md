# Säkerhetspolicy

Rapportera säkerhetsproblem privat till produktens utsedda säkerhetskontakt. Lägg aldrig verkliga dokument, personnummer, API-nycklar, certifikat eller privata nycklar i en issue.

## Säkerhetsprinciper

- default deny,
- least privilege,
- tenantisolering i databas och applikation,
- krypterade identifierare med blind index för sökning,
- separata test- och produktionsmiljöer,
- append-only audit och tamper evidence,
- explicit validering före slutförande,
- inga hemligheter i Git eller containerimages.

Se `THREAT_MODEL.md` och `docs/security/security-controls.md`.
