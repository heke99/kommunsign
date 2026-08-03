# Data processing — Kommunsign BankID phase

## Data categories

- Tenant/users: identifiers, roles, organization and audit metadata.
- Signers: name, email, encrypted expected/verified personal number, blind index, invitation/session state.
- Documents: original quarantine bytes, canonical PDF/A-2b bytes, hashes, names, page/size metadata and validation reports.
- TIC: session metadata, collect response, XML signature, X.509 identity and OCSP response.
- Email: recipient, template/message metadata, provider IDs and delivery events.
- Evidence: immutable manifests, checksums, reports and audit exports.

## Purpose and minimization

Data is processed to prepare, review, sign, verify, deliver and retain public-sector electronic-signature evidence. Person numbers are strict-binding data by default and are encrypted, purpose-bound and masked. Exception reasons are encrypted and excluded from TIC payloads and ordinary audit records.

Emails contain no person number or document attachment. Public verification exposes only organization, case reference, document names/hashes, signer count, time, verifier versions and package hash.

## Storage and transfers

Documents and evidence use private tenant-prefixed storage. TIC and email providers receive only data necessary for their function. Resend processing/data-residency must remain a documented compliance gate until the municipality approves it or another provider is used.

## Retention and deletion

Retention is policy/version bound per tenant and case. Cryptographic evidence is append-only during its retention period. Test evidence requires explicit consent and a test-retention decision. Deletion must preserve auditability of the deletion action without retaining the deleted sensitive payload.

## Access

Forced RLS, tenant transaction context, tenant-composite foreign keys and minimum-privilege grants apply. Decryption is server-side only and requires a purpose string. Support and logs use IDs, hashes and masked values.
