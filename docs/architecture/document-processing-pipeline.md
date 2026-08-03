# Document processing pipeline

## State flow

`uploaded → quarantined → scanning → canonicalizing → ready → locked`

`rejected` is terminal for a version. Only `ready` versions can enter a signing intent.

## Upload

`POST /v1/uploads` validates PDF filename, MIME, byte count and client checksum and returns a single-use, short-lived grant to a private quarantine bucket. `POST /v1/uploads/{uploadId}/complete` performs a server-side object HEAD/checksum comparison before queuing `DOCUMENT_SCAN`.

Object keys always begin with tenant ID and immutable resource IDs. User filenames are display metadata only.

## Malware and PDF policy

The worker streams bytes to ClamAV `clamd` with INSTREAM, records engine/database version and stores a machine-readable report. It then runs qpdf structural checks and rejects encryption, JavaScript, executable OpenAction/Launch, forbidden embedded files, XFA and resource-limit abuse.

No document content is logged. Policy failures are permanent and use stable error codes.

## Canonicalization

Clean PDF bytes are sent to an internal Gotenberg service with outbound network access blocked. The result is converted to PDF/A-2b, page-count consistency is checked, and veraPDF validates profile conformance. Full validation reports are stored privately.

SHA-256 is calculated only over final canonical bytes. The canonical object is append-only. No bytes may change after a signing intent starts.

## Runtime dependencies

- ClamAV 1.5.3 Debian slim;
- qpdf installed in the worker runtime;
- Gotenberg 8.34.0;
- an approved pinned veraPDF REST image/service;
- private Supabase Storage buckets.

Production must pin image digests after registry verification and record them in `THIRD_PARTY_NOTICES.md` and deployment evidence. A missing veraPDF digest is a release blocker, not permission to use `latest`.
