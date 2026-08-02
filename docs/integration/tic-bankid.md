# TIC/BankID

## Verifierat API-kontrakt

KommunSign använder som standard TIC:s backend-API under:

```text
https://id.tic.io/api/v1
```

API-nyckeln skickas endast från backend med `X-Api-Key`.

Den nuvarande adaptern använder följande HTTP-semantik:

```text
POST   /auth/bankid/sign
POST   /auth/{sessionId}/poll
GET    /auth/{sessionId}/collect
DELETE /auth/{sessionId}
```

Path-prefixet `/api/v1` ingår i bas-URL:en och får inte dupliceras i tenantkonfigurationen. Bas-URL måste använda HTTPS.

## Hash- och avsiktsbindning

Den synliga texten anger organisation, dokument, ärende, dokumentversion och uttrycklig avsikt. Dold data är canonical JSON med full SHA-256, policyversion, signerare, tenant, nonce och giltighetstid.

Exakta canonical JSON-bytes Base64-kodas innan de skickas som `userNonVisibleData`. Samma canonical bytes ska bevaras och verifieras efter `collect`.

## Sessionshantering

KommunSign sparar minst:

- TIC session-id,
- order reference när den finns,
- `qrStartSecret` när den finns,
- `subscriptionToken` när den finns,
- `sessionExpiresAt`,
- tenant, signerare och dokumentversion,
- state och nonce,
- providerstatus och avslutsorsak.

Browsercallback får endast navigera användaren. Den är aldrig bevis för en slutförd signering. Backend måste hämta slutresultatet med `collect`, kontrollera sessionsbindning och därefter verifiera identitetsbeviset.

## Webhooks

Webhook verifieras över exakt raw body med:

- `X-Ormeo-Signature`,
- `X-Ormeo-Timestamp`,
- tenantunik secret,
- HMAC-SHA256,
- konstanttidsjämförelse,
- högst fem minuters accepterad tidsavvikelse,
- session-, state- och tenantbindning,
- idempotens/replayskydd.

Rå provider-evidence sparas immutable. XML-DSig och OCSP måste verifieras oberoende innan identitetsstatus blir `identity_verified` eller används som underlag till kryptografisk PDF-signering.

## Driftgräns

TIC-nycklar ska hämtas från secret manager/KMS och får aldrig lagras i klartext i databasen, frontend, loggar eller Docker-images. Test- och produktionskonfiguration ska vara helt separerade.
