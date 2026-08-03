# Runbook: TIC outage

1. Confirm scope from health checks and TIC status without exposing credentials.
2. Set the TIC start kill switch; leave completed evidence untouched.
3. Stop retries for definitive BankID errors; retain exponential retry for temporary network/5xx/429 errors.
4. Identify sessions by internal IDs and safe status only.
5. Continue collect for sessions that TIC reports complete when service recovers.
6. Never mark signers signed manually.
7. Communicate a generic delay to tenants and signers; do not forward provider stack traces.
8. After recovery, run the internal smoke test and reconcile all pending identity transactions.
9. Document timeline, provider response and evidence integrity impact.
