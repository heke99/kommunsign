# Backup och återställning

- PostgreSQL: krypterad PITR och daglig fullbackup.
- Objektlagring: versionering, checksumma, retention/object lock enligt policy.
- KMS/HSM: dokumenterad backup/escrow och tvåpersonskontroll.
- Varje restore märks med tenant, backup-ID, region och encryption-key reference.
- Restore till staging får endast använda syntetisk data.
- Efter restore verifieras tenantantal, objektmanifest, audit chain heads, outbox reconciliation och att inga tenant-ID blandats.

RPO/RTO fastställs i kundavtal; teknisk basrekommendation inför pilot är RPO ≤ 15 minuter och RTO ≤ 4 timmar, men detta är inte ett löfte förrän miljön har testats.
