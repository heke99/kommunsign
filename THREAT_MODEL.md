# Hotmodell – KommunSign

## Skyddsvärden

Dokument, dokumenthashar, identitetsbevis, signaturartefakter, privata nycklar, providerhemligheter, auditkedjor, valideringsrapporter och tenantkonfiguration.

## Viktigaste hot och kontroller

| Hot | Primära kontroller |
|---|---|
| Tenant escape | RLS, composite keys, serverhärledd tenantkontext, negativa tester |
| Dokumentbyte efter start | immutable version, SHA-256, policy snapshot, låst version |
| Falsk signerare | verifierat providerbevis, expected-subject policy, nonce/state |
| Webhookspoofing/replay | raw-body HMAC/JWS, timestampfönster, idempotens, payloadhash |
| QR-kapning | dynamisk/kortlivad QR, state/nonce, INFERRED blockeras för känsliga flöden |
| PDF wrapping/spoofing | sandbox, canonicalisering före signering, DSS-validering och spoofingkontroller |
| Skadlig PDF | karantän, magic-byte-kontroll, ClamAV, aktivt innehåll blockeras |
| Förfalskad valideringsrapport | hash, auditreferens, manifest och signering/tidsstämpling |
| Insider/supportåtkomst | ingen generell impersonation, break-glass med dubbel attest |
| Supply chain | pinning, SBOM, SAST, dependency/container/license scanning |
| Backup till fel tenant | tenantmärkning, separat nyckel, restore-verifiering och reconciliation |

## Trust boundaries

1. Publik webbläsare ↔ API/WAF.
2. API ↔ data plane.
3. API/workers ↔ TIC/Freja.
4. API/workers ↔ SignService/CA/TSA.
5. SignService ↔ HSM/KMS.
6. Validation service ↔ trust lists/OCSP/CRL.
7. Control plane ↔ tenant deployment registry.

Se `docs/security/security-controls.md` för verifieringskrav.
