# Konton och organisationsanslutning

## Princip

Ansökningsformuläret skapar aldrig ett användarkonto. Det samlar endast in organisations- och kontaktuppgifter för granskning. Kontoåtkomst skapas separat av en superadministratör efter godkänd ansökan och skapad organisationsmiljö.

## Första superadministratören

1. Skapa Supabase Auth-projektet i godkänd region.
2. Stäng av publik registrering.
3. Lägg in exakta tillåtna redirect-URL:er:
   - `https://auth.kommunsign.se/aktivera/`
   - `https://auth.kommunsign.se/aterstall/`
4. Fyll Auth SMTP- och Management API-variablerna och kör `npm run auth:configure-production` följt av `npm run verify:auth-config`.
5. Sätt servervariablerna `SUPABASE_AUTH_PROJECT_URL`, `SUPABASE_AUTH_ANON_KEY`, `SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPERADMIN_EMAIL`, `SUPERADMIN_DISPLAY_NAME` och `SUPERADMIN_INVITE_REDIRECT_URL`.
6. Kontrollera att e-postadressen inte redan tillhör en annan Auth-identitet. Om en granskad befintlig identitet avsiktligt ska upphöjas, sätt `SUPERADMIN_ALLOW_EXISTING_USER=true` endast under bootstrapkörningen.
7. Kör:

```bash
npm run auth:bootstrap-superadmin
```

8. Öppna e-postinbjudan, välj lösenord och logga in på `https://admin.kommunsign.se`.
9. Kontrollera att sessionen är hostbunden, att CSRF-token skapas och att plattformsrollen visas.
10. Sätt därefter `SUPERADMIN_BOOTSTRAPPED=true` i målmiljön.

Bootstrap-kommandot är idempotent. Service-role-nyckeln används endast server-side och får aldrig exponeras i Vercel-portaler eller webbläsarbundles.

## Organisationens första konto

1. Ansökan skickas via `apply.kommunsign.se`.
2. Superadministratören granskar och godkänner ansökan.
3. Provisioneringen skapar organisation, domän, roller och policyer men ingen personanvändare.
4. I plattformsadmin öppnas organisationen och avsnittet **Organisationskonton**.
5. Superadministratören anger namn, e-post och rollen **Organisationsadministratör**.
6. API:t skapar eller kopplar Supabase Auth-identiteten, krypterar e-post i kontrollplanet, skapar medlemskap och skickar inbjudan.
7. Mottagaren öppnar token-hashlänken på `auth.kommunsign.se/aktivera/`. Token verifieras först när lösenordet skickas in, vilket skyddar länken mot automatisk förhandsöppning. Därefter skapas en hostbunden session för organisationens verifierade domän.
8. Inbjudan markeras `active` först när identiteten och medlemskapet har verifierats.

## Roller i gränssnittet

| Intern rollnyckel | Visat namn |
|---|---|
| `tenant_admin` | Organisationsadministratör |
| `tenant_security_admin` | Säkerhetsadministratör |
| `tenant_integration_admin` | Integrationsadministratör |
| `tenant_archive_admin` | Arkivadministratör |
| `department_admin` | Avdelningsadministratör |
| `document_creator` | Dokumentskapare |
| `document_sender` | Dokumentsändare |
| `approver` | Godkännare |
| `auditor` | Revisor |
| `readonly` | Läsbehörighet |

De interna nycklarna behålls för kompatibilitet med RLS, API och befintliga migrationer. De visas inte som produktterminologi för slutanvändaren.

## Glömt lösenord

1. Användaren väljer **Glömt lösenord** på inloggningssidan.
2. API:t gör serverbaserad rate limiting och skickar en återställningsbegäran till Supabase Auth.
3. Samma neutrala svar visas oavsett om e-postadressen finns.
4. Custom SMTP skickar länken till `https://auth.kommunsign.se/aterstall/`.
5. Token-hashen tas bort ur webbläsarens URL direkt efter att sidan har läst den och verifieras först när formuläret skickas.
6. Lösenordet måste vara 12–128 tecken och innehålla gemen, versal, siffra och specialtecken.
7. Efter lösenordsbytet skapas en ny hostbunden Kommunsign-session.

## Avstängning

Avstängning sker i Kommunsigns medlemskap och inbjudningsregister och alla aktiva Kommunsign-sessioner återkallas omedelbart. Supabase-identiteten behålls eftersom samma identitet kan ha separat behörighet i en annan organisation; borttagning eller spärr hos identitetsleverantören får endast göras efter kontroll att ingen annan giltig åtkomst finns. Historiska auditposter behålls.
