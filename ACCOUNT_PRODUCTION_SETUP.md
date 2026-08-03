# Kommunsign – konto- och produktionssättning

## Slutet kontoflöde

Kommunsign har ingen publik kontoregistrering.

1. En organisation skickar en ansökan på `https://apply.kommunsign.se`.
2. Ansökan skapar **inte** någon användare eller inloggning.
3. Superadministratören granskar och godkänner ansökan.
4. Provisioneringen skapar organisationens miljö, domänkoppling, roller och policyer.
5. Superadministratören öppnar **Organisationskonton** och bjuder in organisationens första administratör.
6. Mottagaren får en personlig aktiveringslänk, väljer lösenord och loggar in på organisationens verifierade domän.

Interna databasnycklar som `tenant_id` och befintliga rollnycklar behålls för RLS, foreign keys och migrationskompatibilitet. De visas inte som produktterminologi i gränssnittet.

## 1. Installera och verifiera koden

```bash
cd /Users/hekmath/Projects/kommunsign
npm ci
npm run verify
```

Node.js 22 och den låsta TypeScript-versionen krävs.

## 2. Skapa produktionsmiljön

Använd `.env.production.template` som variabelkontrakt. Lägg verkliga hemligheter i Vercel, Supabase, er containerplattform eller annan godkänd secrets manager. Checka aldrig in en ifylld miljöfil.

```bash
cp .env.production.template .env.production.local
```

Fyll minst följande grupper:

- control- och data-plane PostgreSQL,
- Supabase Storage och privata buckets,
- Supabase Auth-projekt, service-role och Management API-token,
- Auth SMTP för `konto@notify.kommunsign.se`,
- kryptering, blind index, CSRF, gateway och trusted proxy,
- Vercelprojekt, domäner och wildcard-TLS,
- TIC BankID-produktion,
- Resend API och webhook,
- dokumenttjänster, valideringstjänst och workers,
- retention, DPA och verifieringsflaggor efter genomförda kontroller.

Verifiera att mallarna är synkroniserade:

```bash
npm run verify:env-contract
```

## 3. Konfigurera Supabase Auth

Publik registrering ska vara avstängd. Site URL och redirect-listan ska vara exakt:

```text
https://auth.kommunsign.se
https://auth.kommunsign.se/aktivera/
https://auth.kommunsign.se/aterstall/
```

Sätt deployment-variablerna, inklusive:

```text
SUPABASE_MANAGEMENT_ACCESS_TOKEN
SUPABASE_AUTH_PROJECT_REF
AUTH_SMTP_PASSWORD
```

Kör sedan:

```bash
npm run auth:configure-production
npm run verify:auth-config
```

Ta bort den upplösta Management API-token och `AUTH_SMTP_PASSWORD` från applikationens runtime efter konfigurationen. Behåll endast hemlighetsreferenser där plattformen stödjer det.

## 4. Kör databaserna i rätt ordning

```bash
export CONTROL_DATABASE_URL='postgresql://...'
export DATA_DATABASE_URL='postgresql://...'

npm run db:migrate
npm run db:verify
```

Ordningen är:

1. alla numrerade `migrations/control/` i stigande ordning,
2. alla numrerade `migrations/data/` i stigande ordning,
3. control-verifiering,
4. data-verifiering och organisationsisolering.

Verifierings-SQL körs inte längre som migration.

## 5. Deploya domänerna

Följ `infrastructure/vercel/projects.json`:

- `kommunsign.se` – publik webb,
- `apply.kommunsign.se` – ansökan,
- `admin.kommunsign.se` – plattformsadministration,
- `auth.kommunsign.se` – inloggning, aktivering och lösenordsåterställning,
- `app.kommunsign.se` och `*.kommunsign.se` – organisationsportal,
- `sign.kommunsign.se` – signering,
- `verify.kommunsign.se` – verifiering,
- `api.kommunsign.se` och `hooks.kommunsign.se` – backend.

Verifiera DNS, TLS, host-allowlist och proxyhemlighet innan trafik öppnas.

## 6. Skapa första superadministratören

Sätt tillfälligt:

```text
SUPERADMIN_EMAIL=<er administratör>
SUPERADMIN_DISPLAY_NAME=<namn>
SUPERADMIN_INVITE_REDIRECT_URL=https://auth.kommunsign.se/aktivera/?destination=admin.kommunsign.se
SUPERADMIN_ALLOW_EXISTING_USER=false
```

Kör:

```bash
npm run auth:bootstrap-superadmin
```

Kommandot:

- skapar eller återanvänder en granskad Supabase Auth-identitet,
- skickar aktiveringslänk när det behövs,
- skapar plattformssubjekt och superadminroll,
- skriver kontrollplansaudit,
- är idempotent.

Om e-postadressen redan finns men inte redan är superadmin stoppas kommandot. Sätt `SUPERADMIN_ALLOW_EXISTING_USER=true` endast för den enskilda, granskade bootstrapkörningen och återställ direkt till `false`.

Efter verifierad inloggning på `https://admin.kommunsign.se` sätts:

```text
SUPERADMIN_BOOTSTRAPPED=true
```

## 7. Skapa organisationens första konto

1. Logga in på `admin.kommunsign.se`.
2. Öppna en inskickad ansökan.
3. Granska och godkänn ansökan.
4. Välj **Skapa organisation**.
5. Öppna **Organisationskonton**.
6. Ange namn, e-post och **Organisationsadministratör**.
7. Välj **Skicka kontoinbjudan**.
8. Mottagaren väljer lösenord via `auth.kommunsign.se/aktivera/`.

En ny inbjudan till samma ännu ej aktiverade e-postadress skickar en ny aktiveringslänk utan att skapa en dubblettidentitet.

## 8. Glömt lösenord

Användaren väljer **Glömt lösenord** på `auth.kommunsign.se`. API:t returnerar samma neutrala svar oavsett om adressen finns. Supabase Auth skickar återställningsmeddelandet via Custom SMTP.

Länken använder token-hash. Den verifieras först när användaren faktiskt skickar in sitt nya lösenord, så automatiska e-postskannrar förbrukar inte engångslänken när de förhandsöppnar meddelandet.

## 9. Slutlig produktionskontroll

När varje faktisk kontroll har ett sparat bevis sätter ni motsvarande verifieringsflagga till `true`, bland annat:

```text
PLATFORM_WILDCARD_VERIFIED
AUTH_EMAIL_DELIVERY_VERIFIED
SUPERADMIN_BOOTSTRAPPED
TIC_BANKID_ENABLED
TIC_CALLBACK_VERIFIED
TIC_WEBHOOK_VERIFIED
WILDCARD_TLS_VERIFIED
AUDIT_CHAIN_VERIFIED
MIGRATIONS_CURRENT
EVIDENCE_VERIFIER_VERIFIED
WORKER_CONSUMERS_READY
PDF_PIPELINE_APPROVED
PRODUCTION_ACCEPTANCE_TEST_PASSED
RETENTION_POLICY_APPROVED
DPA_ACCEPTED
EMAIL_DATA_RESIDENCY_APPROVED
```

Kör sist:

```bash
npm run verify:auth-config
npm run db:verify
npm run verify:container-health
npm run verify:evidence-fixtures
npm run verify:env
```

`npm run verify:env` stoppar driftsättningen om en obligatorisk hemlighet, säkerhetsflagga, verifierad URL eller driftskomponent saknas.
