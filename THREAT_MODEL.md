# Threat model — Kommunsign BankID production phase

## Trust boundaries

Browser ↔ public/tenant portals ↔ API ingress ↔ control/data PostgreSQL ↔ private storage ↔ durable workers ↔ isolated document/validation services ↔ TIC/Resend.

## Critical assets

Canonical PDF/A bytes and hashes, signed payload bytes, signer identity, TIC XML/OCSP, evidence manifests/packages, audit chain, tenant boundaries and provider secrets.

## Principal threats and controls

| Threat | Required controls |
|---|---|
| Cross-tenant access | Verified tenant context, forced RLS, tenant composite FK, prefixed storage keys and negative tests. |
| Forged/modified document | Server-side upload checksum, PDF/A conversion, final SHA-256, intent lock and evidence re-hash. |
| Malicious PDF | Magic/MIME checks, ClamAV, qpdf policy, active-content rejection, isolation and limits. |
| Identity substitution | Strict prebinding by default, encrypted expected value and independent verified identity match. |
| Unauthorized exception | Tenant policy + explicit permission + reason + audit + risk warning. |
| Forged provider callback | Fixed URLs, raw-body HMAC/Svix verification, freshness, state/session binding and idempotency. |
| XML signature wrapping/XXE | External entities disabled, unique IDs, expected internal reference and cryptographic XML-DSig validation. |
| Manual completion/fake evidence | Transactional status functions and evidence/package guards; webhook/provider status alone is insufficient. |
| Secret leakage | Secret manager references, server-only adapters, redacted errors and repository secret scan. |
| Replay/race | Opaque hashed tokens, nonce/state, idempotency keys, advisory locks, version/If-Match and immutable intents. |
| SSRF/conversion escape | No free URL fetch, internal services, blocked egress, non-root/read-only containers and resource limits. |
| Email abuse/data leakage | Provider-neutral outbox, no attachments/person number, bounce suppression and compliance gate. |

## Residual/external risks

Provider availability, certificate trust evolution, long-term validation, municipality retention decisions and Resend transfer approval remain operational/legal dependencies. PAdES-LT/LTA and qualified signatures are explicitly outside phase 1.
