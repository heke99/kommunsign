# Runbook: email delivery failure

- Check provider health, secret references, sender-domain DNS and webhook verification.
- Retry temporary 429/5xx/network errors with queue backoff.
- Do not retry permanent invalid recipient, hard bounce or complaint.
- Suppress future reminders for bounced/complained signers.
- Rotate invitation tokens only through the resend operation; old token becomes revoked.
- Do not attach documents or reveal personal numbers in support messages.
- Provider switching uses `EmailProvider` adapter wiring and configuration, not case-domain changes.
