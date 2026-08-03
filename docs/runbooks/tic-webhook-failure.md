# Runbook: TIC webhook failure

- Check raw-body preservation, header names, clock synchronization and configured secret reference.
- Compare stored payload hashes and provider session IDs; never log raw signed identity payloads.
- If signature failures increase, keep rejecting them and poll known sessions through normal rate limits.
- A valid duplicate is acknowledged with 2xx and not reprocessed.
- Requeue collect only through the durable idempotency key `tic-collect:{identityTransactionId}`.
- Do not bypass state/session binding and do not accept a webhook as completion evidence.
- Rotate the webhook secret when compromise is suspected.
