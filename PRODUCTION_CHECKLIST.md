# Kommunsign produktionschecklista

Markera endast en kontroll som genomförd när målmiljön har ett sparat testbevis. Hemligheter och personuppgifter ska inte läggas i Git.

## Build and database

- [ ] `npm ci` succeeds against the approved npm registry.
- [ ] `npm run verify` passes from a clean checkout.
- [ ] `npm run verify:evidence-fixtures` passes and a modified package is rejected.
- [ ] `npm run verify:container-health` passes from the production worker network.
- [ ] Control migrations run in numeric order and `tests/sql/onboarding-control.sql` passes.
- [ ] Data migrations run in numeric order, including `0013_bankid_production_foundation.sql` och `0014_managed_organization_accounts.sql`, and `migrations/data/verify.sql` passes.
- [ ] Empty-database and upgrade-database rehearsals both pass.
- [ ] Generated SDK/OpenAPI contract version is `2026-08-03.2`.

## Konton och inloggning

- [ ] Publik registrering är avstängd i Supabase Auth och `AUTH_PUBLIC_SIGNUP_ENABLED=false`.
- [ ] Site URL är `https://app.kommunsign.se/login/`.
- [ ] Endast exakta redirect-URL:er för `/aktivera/` och `/aterstall/` är tillåtna i produktion.
- [ ] `npm run auth:configure-production` och `npm run verify:auth-config` passerar mot Supabase-projektet.
- [ ] Custom SMTP via `smtp.resend.com:465`, SPF, DKIM och DMARC är verifierade.
- [ ] Mallarna **Bjud in användare** och **Återställ lösenord** är testade med token-hashflödet och klickspårning avstängd.
- [ ] En e-postsäkerhetsskanner kan öppna länken utan att förbruka aktiveringen; token verifieras först när lösenordet skickas.
- [ ] `npm run auth:bootstrap-superadmin` har körts och första superadministratören kan logga in.
- [ ] Ansökan skapar ingen personanvändare eller inloggning.
- [ ] Superadministratören kan skapa organisationens första administratör och mottagaren kan aktivera kontot.
- [ ] Superadministratören kan stänga av och återaktivera ett konto; avstängning återkallar aktiva Kommunsign-sessioner.
- [ ] Glömt lösenord skickar e-post men avslöjar inte om adressen finns.
- [ ] Hostbunden session, CSRF, logout, rate limiting och utgången/återanvänd länk har verifierats.
- [ ] Migration `0014_managed_organization_accounts.sql` har stängt gamla automatiska ansökningsidentiteter.

## Domains and ingress

- [ ] `kommunsign.se` and every system subdomain resolve to the intended Vercel/ingress projects.
- [ ] `*.kommunsign.se` wildcard and automatic TLS are verified.
- [ ] `www` redirects to the root.
- [ ] Unknown Host headers are rejected.
- [ ] Forwarded host/IP is accepted only from the configured trusted proxy.
- [ ] Callback/redirect allowlists use fixed verified URLs.
- [ ] `notify` and all system names are reserved tenant slugs.

## Data protection and storage

- [ ] Encryption and blind-index keys are generated, backed up and rotation-tested.
- [ ] Service-role keys and provider keys exist only in the approved secret manager.
- [ ] All document/evidence buckets are private.
- [ ] Signed URL TTL is at most five minutes and download responses are `private, no-store`.
- [ ] RLS is enabled and forced on every tenant table.
- [ ] Tenant-composite foreign keys and tenant-isolation tests pass.
- [ ] Person numbers, tokens and provider payloads are absent from logs and fixtures.

## Document pipeline

- [ ] ClamAV 1.5.3 health and signature database freshness are verified.
- [ ] qpdf exists in the worker runtime and its version is recorded.
- [ ] Gotenberg 8.34.0 health, no-JavaScript mode and outbound-network block are verified.
- [ ] Approved veraPDF image/service version and digest are recorded; PDF/A-2b pass/fail fixtures work.
- [ ] Malware, JavaScript, Launch/OpenAction, embedded executable, XFA, encryption and limit fixtures fail closed.
- [ ] Final canonical SHA-256 is computed after PDF/A validation and remains immutable.

## TIC BankID

- [ ] TIC account has production signing enabled.
- [ ] API key and webhook secret are resolved into runtime only.
- [ ] Exact callback and webhook URLs are approved and verified.
- [ ] `TIC_BANKID_ENABLED=false` remains default until smoke testing.
- [ ] Internal tenant and test subject allowlist are configured.
- [ ] QR and same-device flows pass with harmless production-test documents.
- [ ] Poll cadence, rate-limit handling, one-time extension and idempotent cancel are observed.
- [ ] Raw-body webhook HMAC, timestamp window, state/session binding and duplicate handling pass.
- [ ] XML-DSig, payload, document hashes, identity and OCSP validation pass independently.
- [ ] A modified PDF, wrong person number and missing OCSP all fail.

## Email

- [ ] `notify.kommunsign.se` sender DNS is verified.
- [ ] Resend API/webhook secrets are configured through secret references.
- [ ] Svix raw-body verification and duplicate events pass.
- [ ] Bounce and complaint suppress future reminders.
- [ ] Messages contain no attachments or personal numbers; tracking is disabled.
- [ ] `EMAIL_DATA_RESIDENCY_APPROVED=true` only after written approval, or another adapter is selected.

## Workers and evidence

- [ ] All phase-1 durable job handlers are installed and consumers are healthy.
- [ ] Lease heartbeat, retry, permanent dead-letter and replay recovery are verified.
- [ ] No UI/API path can set `signed` or `completed` manually.
- [ ] Per-signer and case evidence packages are deterministic, append-only and offline-verifiable.
- [ ] Public verification shows no personal number.
- [ ] Audit chain verification passes before activation.

## Operations and acceptance

- [ ] TIC, webhook, document processor and email runbooks are rehearsed.
- [ ] Secret rotation runbooks are rehearsed.
- [ ] Backup/restore and evidence retention decisions are approved.
- [ ] Accessibility tests target WCAG 2.2 AA.
- [ ] Production acceptance record in `docs/verification/bankid-production-acceptance.md` is completed.
- [ ] Organisationer aktiveras först när samtliga tillämpliga kontroller har dokumenterade testbevis.
