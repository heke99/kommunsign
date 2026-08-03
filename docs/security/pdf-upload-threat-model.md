# PDF upload threat model

## Assets

Canonical documents, signer confidentiality, worker availability, validation integrity, tenant isolation and evidence hash continuity.

## Main threats and controls

- MIME/extension spoofing: compare filename, declared MIME and `%PDF-` magic bytes.
- Malware: ClamAV INSTREAM plus separate PDF-policy inspection.
- Parser exploitation: qpdf checks, process time/memory/output limits and isolated non-root containers.
- Active content: reject JavaScript, Launch, executable OpenAction, XFA and forbidden embedded files.
- SSRF: Gotenberg receives uploaded bytes only, has no free URL-fetch path and no outbound network.
- Zip/object bombs: hard byte/page/document/object limits and timeouts.
- TOCTOU: server-side upload confirmation, exact checksum, immutable object keys and version locks.
- Tenant escape: forced RLS, tenant-composite foreign keys and tenant-prefixed storage keys.
- Post-sign mutation: canonical hash after PDF/A validation and immutable guard after intent start.
- Sensitive logging: stable codes and IDs/hashes only.

## Residual risk

Antivirus cannot guarantee absence of malicious content. Therefore both structural policy inspection and sandboxing remain mandatory. Newly disclosed parser vulnerabilities require image rebuild, acceptance fixtures and rollout through the kill switch.
