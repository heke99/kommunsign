# TIC BankID production

## Scope

Kommunsign uses TIC's backend REST API for a BankID-based advanced electronic signature. The signed object is the canonical `kommunsign.bankid-evidence.v2` JSON payload that binds a signer, signing intent, policy version and one or more immutable PDF/A-2b document versions.

This phase is not PAdES, PAdES-LT/LTA or a qualified electronic signature.

## Runtime configuration

Required production values are listed in `.env.example`. `TIC_API_KEY_SECRET_REF` and `TIC_WEBHOOK_SECRET_REF` must be resolved by the approved secret manager into process-local `TIC_API_KEY` and `TIC_WEBHOOK_SECRET`. They must never be exposed to a browser or stored as ordinary database values.

`TIC_BANKID_ENABLED` defaults to `false`. Activation also requires `app.tenant_signing_settings.tic_bankid_rollout_enabled=true` for the tenant. The global kill switch must block new starts without mutating already collected evidence.

## Start contract

The API calls `POST /auth/bankid/sign` with:

- trusted `endUserIp` and current `userAgent`;
- immutable `userVisibleData` in `simpleMarkdownV1`;
- canonical JSON v2 as `userNonVisibleData`;
- `personalNumber` only for `STRICT_PREBOUND`;
- configured callback and webhook URLs;
- a cryptographically random server-bound `state`.

The payload hash is stored before the provider call. A session never reuses a payload, nonce or state.

## Session lifecycle

Poll no more frequently than every two seconds. Respect `Retry-After`. A completed provider status only queues collect and verification; it never marks a signer signed. Cancel is idempotent. Extend may be used once.

## Completion invariant

A signer becomes `signed` only after XML-DSig validation, canonical payload match, document hash match, identity policy match, OCSP preservation, verification report persistence and audit creation. See `docs/architecture/bankid-evidence-package-v1.md`.

## Production references

- TIC BankID direct API documentation: `https://docs.tic.io/`
- Runtime implementation: `packages/provider-adapters/src/tic-bankid.ts`
- Public orchestration: `apps/api/src/production-adapters/postgres/public-signing-repository.ts`
