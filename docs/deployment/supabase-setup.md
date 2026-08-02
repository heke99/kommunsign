# Supabase-setup

Skapa separata projekt för control och shared data. Kör kontrollmigrationerna endast mot control och datamigrationerna endast mot data. Registrera därefter dataplanen i `control.data_planes` med secret references, inte råa anslutningssträngar.

Rekommenderad ordning:

1. Kör `migrations/control/0001` till `0010` på control.
2. Kör `migrations/data/0001` till `0012` på data.
3. Kör respektive verifieringsskript.
4. Konfigurera server-side Supabase Storage-adaptern; den skapar/verifierar privata bucketar vid start och kräver service role endast i backend.
5. Registrera en `ready` shared_saas-dataplan för rätt region.
6. Starta API/workers först efter att secret references kan lösas. Aktivera inte andra workerflöden än `TENANT_PROVISION` förrän deras produktionshandlers är implementerade.

Livekörning gjordes inte i denna leverans eftersom databas- och Supabase-hemligheter inte fanns i den uppladdade koden.
