# Runbook: document processor failure

1. Identify failed stage: ClamAV, qpdf/policy, Gotenberg, veraPDF or storage.
2. Distinguish permanent document rejection from retryable infrastructure failure.
3. Inspect machine-readable reports and safe engine/version metadata; never copy document bytes to logs/tickets.
4. Verify service health, resource limits, network isolation and pinned image version.
5. Retry only the same immutable source object and idempotency key.
6. Quarantine suspected malware; do not move it to canonical storage.
7. If canonical bytes were written but transaction completion failed, reconcile by hash before retry.
8. Never calculate or accept the signing hash before final PDF/A validation.
