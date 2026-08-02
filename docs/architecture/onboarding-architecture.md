# Ansökningsstyrd onboarding – arkitektur och säkerhetsmodell

## Gränser

Onboarding är en control-plane-domän och existerar innan tenant finns. `apps/api/src/onboarding-router.ts` klassificerar `/v1/onboarding/*` och `/v1/platform/*` före tenantroutern. Därmed kan en ansökan inte skapa eller välja en tenant via requestdata.

Tre kontexter hålls isär:

1. **ApplicantContext**: ansöknings-ID och verifierad, hashmatchad åtkomsttoken/session.
2. **PlatformContext**: plattformsanvändare och plattformsroller/permissions.
3. **TenantContext**: aktiverad eller onboardingtenant med verifierat medlemskap.

## Tillståndsmaskin

Tillåtna tillstånd definieras både i TypeScript och PostgreSQL. API:t returnerar `409 INVALID_APPLICATION_STATE_TRANSITION` vid otillåten övergång. Inskickade data ändras inte på plats; nya versionsposter, kompletteringssvar och meddelanden används.

Huvudkedjan är:

```text
draft/email_verification_pending -> email_verified -> submitted
-> under_initial_review -> additional_information_requested -> resubmitted
-> commercial_review -> legal_review -> security_review -> technical_review
-> approved|rejected|withdrawn
-> provisioning -> onboarding -> ready_for_acceptance_test
-> acceptance_test_failed|ready_for_activation -> active|archived
```

Den exakta övergångsmatrisen är implementerad i `packages/onboarding/src/index.ts` och `control.onboarding_transition_allowed`.

## Tokens och sökandesession

Tokenkärnan genererar minst 32 kryptografiska bytes och lagrar SHA-256, aldrig klartext, i produktionsmodellen. Token binds till ansökan och e-post, har expiry, revoke-/consumed-fält och stöd för replayblockering. Utvecklingsruntime returnerar verifieringstoken uttryckligen endast för lokal testning; produktionsadaptern får inte göra det.

Produktionsmålet är magic link -> servervalidering -> kortlivad HttpOnly, Secure, SameSite-cookie med CSRF-skydd. Den statiska utvecklingsportalen är därför inte ett bevis på färdig produktionsauth.

## Datamodell

Migration `migrations/control/0006_onboarding_and_activation.sql` är additiv och skapar:

- ansökan, immutable versioner, kontakter och bilagor,
- e-postverifiering och access tokens,
- reviews, assignments, kompletteringskrav/svar,
- beslut, interna anteckningar, externa meddelanden och riskbedömningar,
- checklistor, tasks och dependencies,
- provisioning requests/steps/attempts,
- activation requests/approvals,
- readiness checks/results och idempotens.

Referensnummer skapas med PostgreSQL-sekvens och ersätter aldrig UUID. `status_version` används för optimistic concurrency. Databastrigger skyddar statusövergångar och immutable versionshistorik.

## Review, beslut och tvåpersonsprincip

Platform permissions kontrolleras server-side. Ett högriskbeslut kräver en separat andra beslutsfattare i utvecklingsdomänen. Produktionsdatabasen blockerar alltid att aktiveringsinitiatorn också blir approver. Slutlig produktionsimplementation ska dessutom kräva minst två giltiga approvals där policy anger detta och låsa race atomiskt.

## Provisioning saga

Provisioning startar endast från `approved` och använder en application-bound idempotency key. Steg och attempts lagras separat för retry och återupptagning. En tenantidentitet får bara knytas en gång till ansökan. Framgång avslutas i `onboarding`; aldrig `active`.

Produktionsadaptern ska implementera steg för database, migrations, object storage, queue/cache, KMS, policyer, roller, moduler, audit chain, branding, domän, testmiljö och admininbjudan. Varje steg ska ha deterministic idempotency identity och verifierbart resultat.

## Readiness och aktivering

`packages/readiness` grupperar kontroller som blocking, warning och completed. Konfigurationsnärvaro räcker inte när en aktiv kontroll kan utföras. Aktiveringsbegäran avvisas före lagring när readiness inte är grön. Efter grön readiness krävs acceptanstest, giltiga certifikat och en distinkt approver innan status kan bli `active`.

## Bilagor

API:t accepterar endast metadata för PDF i den implementerade vertikala slicen och placerar dokument i quarantine-status. Riktig upload måste gå via kortlivad, ansökningsbunden presigned URL följd av checksum completion, ClamAV, PDF-sandbox och canonicalisering. Ansökan får inte behandla en bilaga som säker innan dessa steg är verifierade.

## Audit och sekretess

Alla muterande operationer ska bära request ID, idempotency key, canonical payload hash och actor. Applicantrepresentationen får inte innehålla intern review, riskpoäng, interna beslutstrådar eller providerhemligheter. Platform admin får information enligt granular permission, inte enbart genom att UI-element döljs.
