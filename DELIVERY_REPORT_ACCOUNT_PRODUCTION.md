# Leveransrapport – konton, onboarding och produktionsmiljö

## Mål

Göra Kommunsigns konto- och inloggningsflöde slutet och produktionsmässigt:

- ansökan ska inte skapa konto,
- första plattformsadministratören skapas kontrollerat,
- endast superadministratör skapar organisationskonton,
- aktivering och glömt lösenord skickas via e-post,
- konton kan stängas av och återaktiveras,
- tekniska interna begrepp ska inte visas som produktterminologi,
- samtliga miljövariabler ska vara deklarerade och maskinellt verifierbara.

## Implementerat

### Kontoflöde

- Publik registrering är borttagen och blockeras i konfigurationen.
- Ansökningsflödet skapar ingen Auth-identitet, användare eller medlemskap.
- Provisionering skapar organisation, verifierad domänmodell, roller, policyer och en uppgift om att skapa första administratören.
- Superadmin kan lista, bjuda in, stänga av och återaktivera organisationskonton.
- Avstängning återkallar aktiva Kommunsign-sessioner.
- Samma Supabase-identitet kan behållas om personen har separat behörighet i en annan organisation.
- Förlorad aktiveringslänk kan skickas på nytt utan dubblettidentitet.

### Första superadmin

- `scripts/bootstrap-superadmin.mjs` skapar eller granskat återanvänder Auth-identiteten.
- Befintlig icke-superadminidentitet kräver explicit engångsgodkännande.
- Plattformssubjekt, roll och kontrollplansaudit skapas atomiskt.
- Kommandot är idempotent och maskerar e-post i terminalutskrift.

### Inloggning och lösenord

- Stängd inloggningsportal utan registreringslänk.
- E-post/lösenord via Supabase Auth.
- Glömt lösenord med neutralt svar och serverbaserad rate limiting.
- Lösenordskrav: 12–128 tecken, gemen, versal, siffra och specialtecken.
- Hostbunden säker cookie, CSRF-token och sessionsåterkallelse.
- Aktiverings- och återställningslänkar använder token-hash och verifieras först vid formulärsubmit för skydd mot automatisk länkförhandsgranskning.

### E-post och Auth-konfiguration

- Versionerade svenska mallar för inbjudan och lösenordsåterställning.
- Automatiserad konfiguration av Supabase Auth via Management API.
- Maskinell verifiering av stängd registrering, Site URL, redirect-lista, SMTP, avsändare, ämnen och mallinnehåll.
- Custom SMTP-kontrakt för Resend med separat Auth-credential.

### Databas

- Additiv control-migration för inbjudningar, CSRF-sessioner och Auth-rate-limits.
- Additiv data-migration som sanerar äldre automatiska `pending-invite`-identiteter och säkerställer full rollkatalog.
- Forced RLS och befintlig organisationsisolering bevaras.
- Verifierings-SQL körs separat och inte som en migration.

### Produktgränssnitt

- Produkttexter använder organisation, organisationskonto och organisationsadministratör.
- Synliga texter om pilot, demo, blocker/readiness eller att tjänsten inte är redo har tagits bort.
- Interna fältnamn som `tenant_id` och äldre rollnycklar behålls endast för databas-, RLS-, API- och migrationskompatibilitet.

### Miljö och drift

- `.env.example` och `.env.production.template` innehåller samma 184 deklarerade variabler.
- Alla 26 direkta runtime-referenser finns i kontraktet.
- `scripts/check-production-env.mjs` validerar hemligheter, HTTPS-URL:er, nyckellängder, säkra flaggor, redirect-allowlist och genomförda produktionskontroller.
- Varje portal har Vercel-konfiguration med säkerhetsheaders.
- Exakt projekt- och domänmappning finns i `infrastructure/vercel/projects.json`.

## Migrationer

Control, i nummerordning:

```text
migrations/control/0011_managed_accounts_and_password_sessions.sql
```

Data, i nummerordning:

```text
migrations/data/0014_managed_organization_accounts.sql
```

Verifiering:

```text
migrations/control/verify_accounts.sql
migrations/data/verify.sql
tests/sql/tenant-isolation.sql
```

## Säkerhetsbeslut

- Ingen publik registrering.
- Service-role och Management API-token är endast server-/deploymenthemligheter.
- Ingen kontoexistens läcker från glömt lösenord.
- Inbjudningar och lösenordsåterställning använder exakta redirect-URL:er.
- Engångslänkar verifieras inte vid GET/förhandsöppning.
- Cookies är host-only, Secure och HttpOnly; mutationer kräver CSRF.
- Avstängning återkallar aktiva applikationssessioner.
- E-post, provider subject och auditdata hanteras utan råa hemligheter i loggar.

## Verifiering

Följande passerade i leveransmiljön:

- TypeScript 5.8.3-kompilering.
- Bygg av sex portaler.
- 33 enhetstester.
- Integrationstester för organisationsscope och onboarding/provisionering.
- Säkerhetstester.
- SQL-migrationskontroll.
- Provenancekontroll.
- SDK-synk `2026-08-03.2`.
- Secret scan.
- ENV-kontrakt: 184 variabler och 26 runtime-referenser.
- Repository verifiering.
- Java boundary/self-test.
- Deterministisk evidence fixture.
- Syntetiskt fullständigt produktions-ENV passerade `verify:env` utan att någon riktig hemlighet sparades.

## Åtgärder i den verkliga målmiljön

Följande kan endast slutföras med era konton, DNS och hemligheter:

- installera beroenden från ett npm-register som innehåller låsta `postgres@3.4.7`,
- skapa och migrera riktiga control- och data-databaser,
- konfigurera och liveverifiera Supabase Auth,
- verifiera `notify.kommunsign.se`, SPF, DKIM och DMARC,
- köra första superadmininbjudan,
- verifiera Verceldomäner, wildcard-TLS och proxyhemlighet,
- verifiera TIC callback/webhook och utföra godkänt produktionssmoke-test,
- köra ClamAV, qpdf, Gotenberg, veraPDF och valideringstjänsten i avsedd containerplattform,
- köra browser-E2E och WCAG-test,
- dokumentera retention, DPA och e-postleverantörens datahanteringsbeslut.

Dessa kontroller är fail-closed: de kan inte markeras som genomförda av repositoryt utan faktisk evidens.

## Exakt driftsättningsordning

1. Synka changed-only-zip.
2. Kör `npm ci` och `npm run verify` i en nätmiljö med korrekt npm-register.
3. Skapa/fyll produktionsvariabler från `.env.production.template` i secrets manager.
4. Skapa databaser och privata storage-buckets.
5. Kör `npm run auth:configure-production` och `npm run verify:auth-config`.
6. Kör `npm run db:migrate` och `npm run db:verify`.
7. Deploya statiska portaler och koppla domäner/TLS.
8. Deploya API, workers, PDF-tjänster och valideringstjänst.
9. Kör `npm run auth:bootstrap-superadmin`.
10. Logga in och verifiera superadminflödet.
11. Skicka en intern organisationsansökan, provisionera den och bjud in första organisationsadministratören.
12. Testa glömt lösenord, avstängning/återaktivering och e-postförhandsgranskning.
13. Verifiera TIC, dokumentpipeline och evidensflöde.
14. Sätt endast bevisade verifieringsflaggor till `true`.
15. Kör `npm run verify:auth-config`, `npm run db:verify`, `npm run verify:container-health`, `npm run verify:evidence-fixtures` och `npm run verify:env`.
