# BankID production acceptance

## Preconditions

All readiness blockers are green: databases/migrations, private buckets, encryption keys, wildcard TLS, trusted proxy, ClamAV/qpdf/Gotenberg/veraPDF, validation service, workers, TIC credentials/URLs, email provider and audit chain.

## Positive test

1. Internal tenant creates a two-document electronic-signature case.
2. Both PDFs pass malware/policy checks and become validated PDF/A-2b.
3. Strictly bound signer is added with a valid personal number.
4. Invitation is sent through the provider-neutral email path.
5. Signer opens the portal, reviews exact canonical documents and visible BankID text.
6. QR and same-device starts are each tested in separate cases.
7. TIC returns complete and collect evidence.
8. Validation confirms XML-DSig, signed text/payload, document hashes, identity and parsable OCSP.
9. Per-signer and case packages build deterministically and verify offline.
10. Case completes only after package readiness.
11. Tenant B receives 404/denial for every Tenant A identifier.

## Negative tests

Wrong personal number, invalid/revoked/expired invitation, duplicate webhooks, modified canonical byte, bad TIC HMAC, missing OCSP, JavaScript PDF, malware fixture, Resend bounce and unauthorized identifier exception must all fail closed.

## Evidence record

Record release commit/hash, migration versions, image tags/digests, test IDs, timestamps, participants' consent reference and PASS/FAIL. Never commit personal numbers, tokens, provider responses or secrets.
