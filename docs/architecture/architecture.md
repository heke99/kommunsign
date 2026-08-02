# Systemarkitektur

## Control plane

Hanterar tenantstatus, domäner, deployment target, feature flags, kvoter, releaseversion och secret references. Den får inte lagra dokument eller signaturbevis.

## Data plane

Hanterar användare, dokument, signerare, identitet, signatur, validering, audit, notifieringar, bevispaket och arkiv. Samma domänmodell används i shared SaaS, dedicated data plane och customer-hosted.

## Flöde

1. Dokument laddas till tenantbunden karantän.
2. MIME/magic bytes, antivirus och PDF-säkerhet kontrolleras.
3. Canonical PDF/PDF-A och SHA-256 skapas före signering.
4. Policy snapshot och dokumentversion låses.
5. TIC/Freja verifierar identitet och avsikt med hashbunden evidence payload.
6. SignService skapar kryptografisk PDF-signatur med engångscertifikat.
7. DSS validerar, sparar trust snapshot och rapport.
8. Affärstransaktionen skapar audit och outbox atomiskt.
9. Evidence package och e-arkivexport byggs från immutable artefakter.

Ingen konvertering får ske efter signering.
