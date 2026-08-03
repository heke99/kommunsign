# TIC secret rotation

- Create a new TIC credential in the provider account.
- Store it as a new secret version and deploy to canary workers/API.
- Validate start, poll, collect and cancellation with the internal tenant.
- Rotate webhook secret in a coordinated window. If TIC supports overlapping secrets, verify against current then previous for a short bounded interval; otherwise pause starts and switch atomically.
- Confirm old-secret webhooks fail after the cutover window.
- Revoke the old credential at TIC.
- Record actor, time, secret reference versions and smoke-test IDs in the control audit system—never the secret value.

Emergency compromise: activate the TIC kill switch, rotate both API and webhook credentials, review provider events and identity transactions, and notify the security owner.
