# TIC production rollout

1. Keep `TIC_BANKID_ENABLED=false` globally.
2. Configure secrets through the approved manager and verify no browser bundle contains them.
3. Register exact callback and webhook URLs with TIC.
4. Verify trusted proxy/IP forwarding and unknown-host rejection.
5. Activate only the internal production tenant and allowlisted test subjects.
6. Run harmless documents labelled production verification with explicit participant consent.
7. Confirm QR and same-device flows, collect, XML/OCSP persistence, strict personal-number match, package build and offline verification.
8. Record test IDs without personal data in source control.
9. Approve retention/deletion for test evidence.
10. Enable tenant rollout one tenant at a time.

Rollback: set the global/tenant start switch off. Do not delete or rewrite completed evidence. Continue collect/verification for sessions that already completed. Escalate stuck sessions through the TIC outage runbook.
