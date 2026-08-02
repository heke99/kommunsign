# TIC/BankID

Standardbas: `https://id.tic.io/api/v1`. Startpath är `/auth/bankid/sign`. API-nyckel skickas som `X-Api-Key` endast från backend.

Den synliga texten anger organisation, dokument, ärende, version och avsikt. Dold data är canonical JSON med full SHA-256, policyversion, signerare, nonce och giltighetstid.

Collect/status/cancel paths är avsiktligt obligatoriska tenantinställningar tills TIC:s avtalsbundna dokumentation har verifierats. Browsercallback får endast navigera användaren; backend måste collecta och verifiera slutresultatet.

Webhook verifieras med raw body, timestamp, HMAC-SHA256, state, session, tenant och idempotens. Rå provider-evidence bevaras immutable och XML-DSig/OCSP ska verifieras separat innan identity status blir verified.
