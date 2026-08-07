# Externa blockerare — Kungälvs kommun, Dnr KS2026/1005

<!-- GENERERAD FIL. Redigera inte för hand.
     Kör `node scripts/build-requirement-matrix.mjs`. -->

Bedömningsdatum: 2026-08-07

36 av 138 krav kan inte avgöras i kodbasen.
De kräver avtal, credentials, certifiering, leverantörsevidens eller
organisatoriska åtgärder. Kraven markeras medvetet inte som uppfyllda.

| Krav | Typ | Vad som saknas | Vad som redan är implementerat |
| --- | --- | --- | --- |
| 2026 | SKA | Organisatorisk rutin och kontoregister hos leverantören. | control.platform_subjects och platform_role_assignments ger personliga plattformskonton med roller. |
| 2027 | SKA | Utpekad roll hos Kungälv och avtalad samrådsrutin. | Ingen dokumenterad incidenthanteringsprocess finns i repot utöver THREAT_MODEL.md. |
| 2029 | SKA | Leverantörsevidens för databehandlingsregion per underbiträde. | Hosting sker hos Supabase, Railway och Vercel. Ingen verifierad förteckning över regioner finns i repot. |
| 2030 | SKA | Kommunens godkännande av varje underbiträde. | Ingen underbiträdesförteckning finns i repot. |
| 2031 | SKA | Avtalad process med kommunen. | Ingen process för byte av underleverantör finns. |
| 2032 | SKA | Två referenskunder i drift. Kundnamn ska inte läggas i repot. | Kan inte uppfyllas med kod. |
| 2037 | SKA | Leverantörsevidens och genomförd restore-övning. | docs/operations/backup-and-restore.md finns. |
| 2039 | SKA | Avtalsvillkor. | Avtalsfråga. |
| 2042 | SKA | Prisbilaga. | Prisfråga. |
| 2043 | SKA | Avtalad förvaltningsprocess. | Avtals- och förvaltningsfråga. |
| 2048 | SKA | Införandeplan tas fram i projektet. | Projektfråga. |
| 2051 | SKA | Samarbete i införandeprojektet. | Projektfråga. |
| 2054 | SKA | Utbildningstillfälle genomförs av leverantören. | Ingen utbildning planerad. |
| 3501 | SKA | Etablerat och tillämpat LIS hos leverantören. | Inget LIS finns dokumenterat. |
| 3503 | SKA | Upprättade myndighetskontakter. | Organisatoriskt krav. |
| 3504 | SKA | Antagen och tillämpad policy. | Ingen distansarbetspolicy finns. |
| 3505 | SKA | Genomförda bakgrundskontroller. | Organisatoriskt krav. |
| 3506 | SKA | Tecknade avtal med anställda och underleverantörer. | Organisatoriskt krav. |
| 3507 | SKA | Genomförd utbildning. | Organisatoriskt krav. |
| 3508 | SKA | Fastställd process. | Organisatoriskt krav. |
| 3509 | SKA | Undertecknade ansvarsförbindelser. | Organisatoriskt krav. |
| 3510 | SKA | Antagen policy och kontrollrutin. | AGENTS.md innehåller icke förhandlingsbara regler för utveckling. |
| 3512 | SKA | Genomförd riskbedömning. | THREAT_MODEL.md finns men ingen återkommande riskbedömningsprocess. |
| 3520 | SKA | Fastställda regler. | Organisatoriskt krav. |
| 3522 | BÖR | Kommunens IdP-konfiguration. | Inloggning sker via kommunens IdP där MFA hanteras. Kravet är BÖR. |
| 3525 | SKA | Escrow-avtal med tredje part. | Källkoden ligger i git med FILE_MANIFEST.sha256 och PROVENANCE_REPORT.txt. Branch protection och deposition är inte verifierade. |
| 3527 | SKA | Leverantörsevidens för datahallens fysiska skyddsnivå. | Drift sker hos molnleverantörer. |
| 3528 | SKA | Leverantörsevidens för fysisk tillträdeskontroll. | Fysisk åtkomst hanteras av hostingleverantören. |
| 3533 | SKA | Leverantörsevidens och genomförd restore-övning. | Samma som 2037. |
| 3536 | SKA | Leverantörsevidens för tidssynkroniseringskälla. | Systemet använder UTC internt. |
| 3548 | SKA | Underbiträdesförteckning och kommunens godkännande. | Samma som 2030. |
| 3550 | SKA | Utpekad roll hos Kungälv. | Samma som 2027. |
| 3554 | SKA | Avtalad förvaltningsprocess. | Avtals- och förvaltningsfråga. |
| 3555 | SKA | Tecknat personuppgiftsbiträdesavtal och sekretessförbindelse. | Bilaga 4 är personuppgiftsbiträdesavtalet. DATA_PROCESSING.md beskriver behandlingen. |
| 3556 | SKA | Avtalad revisionsrätt och genomförd revision. | Ingen revisionsprocess avtalad. |
| 3557 | SKA | Antagen policy. | Organisatoriskt krav. |

