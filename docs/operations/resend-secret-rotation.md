# Resend secret rotation

- Disable new email jobs only when provider overlap is unavailable; do not mutate case state.
- Create a new restricted Resend API key and webhook endpoint secret.
- Store new versions in the secret manager and deploy canary workers/webhook handlers.
- Send an internal invitation and verify accepted/delivered webhook idempotency.
- Revoke old credentials and replay no historical payloads.
- Confirm bounce/complaint suppression still works.
- Audit references and test message IDs without recipient addresses.

A data-residency approval remains a separate gate and is not satisfied by key rotation.
