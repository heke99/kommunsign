# Kommunsign – ny länk vid återinbjudan

## Orsak

`inviteOrFindUser()` klassar en befintlig e-postbekräftad Supabase-identitet som `active`.
Repository-koden skickade tidigare en ny recovery-/lösenordslänk endast när identiteten var `pending`.
Ett nytt manuellt klick kunde därför returnera ett lyckat konto utan att något nytt mejl skickades.

## Ändring

- En ny Supabase-invite skickas fortfarande för helt nya identiteter.
- För alla redan existerande identiteter (`pending` eller `active`) verifieras lokal användare, medlemskap och roll först.
- Därefter anropas password recovery för att skapa och skicka en ny giltig lösenordslänk.
- Samma idempotensnyckel dedupliceras fortfarande, medan ett nytt manuellt klick använder en ny idempotensnyckel och skickar en ny länk.
- Superadmin visar nu korrekt att en ny aktiverings- eller lösenordslänk har skickats.

## Ingen databasändring

Patchen innehåller ingen ny migration.

## Verifierat

- TypeScript-build
- 6 portalbyggen
- 47 tester
- integrationstester
- säkerhetstester
- migrationskontroll
- repositorykontroll
