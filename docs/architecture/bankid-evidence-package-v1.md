# BankID evidence package v1

## Legal/technical description

BankID-based advanced electronic signature with a standalone cryptographic evidence package, where TIC's BankID signature is bound to a canonical manifest over the PDF/A documents reviewed by the signer.

## Signed payload

`kommunsign.bankid-evidence.v2` includes tenant, case, intent, signer, binding mode, policy ID/version, deterministic document snapshots, nonce, issue time and expiry. Canonical JSON bytes and SHA-256 are stored before TIC start.

## Per-signer files

- `manifest.json` (package envelope manifest)
- `visible-data.txt`
- `non-visible-data.json`
- `tic-collect-response.json`
- `tic-signature.xml`
- `tic-ocsp-response.der`
- `verification-report.json`
- `audit-events.json`
- `checksums.sha256`

## Case package

- canonical documents in deterministic ordinal order;
- each signer's evidence directory;
- PDF/A reports;
- case audit export;
- a separate signing receipt;
- root manifest and checksums.

The receipt is not the signed original document.

## Determinism and immutability

ZIP entries are sorted, stored without engine-dependent compression and assigned fixed timestamps. Every content file appears in the manifest and checksum file. The ZIP bytes are hashed and package records/files are append-only.

The public verification portal reveals organization, case reference, document names/hashes, signer count, completion time, verifier engine/policy and package hash—never personal numbers.
