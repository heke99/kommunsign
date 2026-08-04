# TIC BankID webhooks

Endpoint: `POST https://api.kommunsign.se/v1/provider-webhooks/tic/bankid`

## Verification

1. Read the exact raw request bytes before parsing JSON.
2. Require `X-Ormeo-Signature`, `X-Ormeo-Timestamp` and `X-Ormeo-Event`.
3. Reject timestamps outside `TIC_WEBHOOK_MAX_AGE_SECONDS` (default 300).
4. Verify HMAC-SHA256 over the raw body bytes. The timestamp is freshness metadata and is not prepended to the HMAC material.
5. Use constant-time comparison.
6. Accept only allowlisted events; phase 1 supports `sign.completed`.
7. Bind provider session ID and signed `state` to the internal identity transaction.
8. Store provider event ID and raw payload hash idempotently.
9. Return 2xx after durable persistence and queue collect/verification asynchronously.

A duplicate returns 2xx and creates no second job. A webhook cannot directly set `signed` or `completed`.

## Failure handling

- Invalid signature: `TIC_WEBHOOK_SIGNATURE_INVALID`, no persistence.
- Stale timestamp: `TIC_WEBHOOK_REPLAYED`, no persistence.
- Unknown event: `TIC_WEBHOOK_EVENT_UNSUPPORTED`.
- Unknown session/state: `TIC_WEBHOOK_TRANSACTION_NOT_FOUND` or binding failure.

Fixtures in `tests/run.mjs` prove raw-body HMAC and timestamp rejection.
