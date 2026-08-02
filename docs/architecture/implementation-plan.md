# Implementationsplan

## Fas 0 – levererad grund

Källinventering, licensgrind, ADR, hotmodell, verifieringsmatris och clean-room-beslut.

## Fas 1 – levererad grund

Monorepo, control/data plane-schema, tenantkontext, RBAC, RLS, white-label-skal, audit/outbox och CI.

## Fas 2 – delvis implementerad

Dokumenttabeller, statusmaskin, karantän-/scan-/canonicaliseringsjobb och fältmodell finns. Full PDF-editor, ClamAV/Gotenberg-adapter och S3-repository återstår.

## Fas 3 – delvis implementerad

TIC startadapter, hashbunden payload och HMAC/timestampkontroll finns. Exakta collect/status/cancel-kontrakt kräver godkänd TIC-dokumentation och tenant.

## Fas 4–6 – säker boundary levererad

Java-tjänster, JWS-verifieringskärna och kontrakt finns. Officiell Freja-klient, Sweden Connect, HSM/CA/TSA och DSS måste pinas och integreras före produktion.

## Fas 7–8

OpenAPI och webhook/idempotensmodell finns. Offline verifier-CLI och connector-kontrakt finns. Full e-arkivadapter, belastningstest, penetrationstest, DPIA, restore test och pilotdrift återstår.
