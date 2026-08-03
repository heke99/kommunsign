# Resend email provider

## Boundary

The domain depends on `EmailProvider`, not Resend types. Implementations are:

- `ResendEmailProvider` for production;
- `DevelopmentEmailProvider` for logical/local tests;
- `SmtpEmailProvider` over the generic `SmtpTransport` boundary.

Changing provider must only change adapter wiring, secrets and configuration.

## Delivery

Email state and outbox/job creation occur in the same tenant transaction. The worker sends with a stable idempotency key and persists the provider message ID. Normalized states are `accepted`, `delivered`, `delayed`, `bounced`, `complained`, and `failed`.

Hard bounce and complaint suppress future reminders. Permanent recipient errors are not retried. Temporary failures use exponential retry with jitter through the durable queue.

## Webhook

The Resend webhook endpoint reads raw body bytes and verifies the Svix signature using `svix-id`, `svix-timestamp` and `svix-signature`. Provider event IDs are unique and duplicates are harmless.

## Privacy and compliance gate

Messages contain no personal number and no attached PDF/evidence package. Links are opaque, expiring and revocable. Open and click tracking are disabled by default.

`EMAIL_DATA_RESIDENCY_APPROVED=false` is a blocking procurement/readiness decision. Resend may be technically configured, but Kommunsign must not claim full Kungälv EU/EES public-sector compliance until the municipality approves the arrangement in writing or another provider is selected.
