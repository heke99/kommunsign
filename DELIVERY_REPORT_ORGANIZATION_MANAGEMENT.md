# Leveransrapport – organisationer, inbjudan och kundportal

Datum: 2026-08-04

## Resultat

Kommunsign har nu ett sammanhängande och fail-closed flöde från superadmin till kundens första skickade avtal:

1. `platform_super_admin` skapar en organisation direkt i superadminportalen eller provisionerar en godkänd ansökan.
2. API:t skapar en spårbar onboardingpost, skyddar mot dubbletter och lägger tenantprovisioneringen i den befintliga beständiga kön.
3. Provisioneringsarbetaren skapar tenant, miljö, primär domän, lagringsnamnrymder, standardpolicyer, standardroller, branding, auth-utkast och kontohantering.
4. Superadmin ser organisationens status, aktuellt steg, eventuell blockeringskod, tenantstatus och primär domän i en separat organisationsvy.
5. Inbjudan låses upp först när tenantens provisionering är slutförd eller tenanten är aktiv och primär domän är verifierad med aktiv TLS.
6. Superadmin bjuder in huvudadministratören eller ytterligare användare med en vald tenantroll.
7. Kunden får en personlig Supabase Auth-länk, väljer sitt eget lösenord och får en hostbunden session till rätt organisation.
8. Kundportalen hämtar tenantens verkliga aktiva signeringspolicyer och kan skapa ärende, ladda upp PDF, lägga till signerare, kontrollera underlaget och skicka avtalet.

## Superadminportal

Tillagt:

- separat organisationslista och filter,
- formulär för direkt skapande av organisation,
- dubblettskydd på organisationsnummer,
- visning av provisioneringsstatus, blockeringskod, tenantstatus och domän,
- val och hantering av organisation,
- direktknapp för att bjuda in huvudadministratör,
- lista över inbjudna och aktiva konton,
- avstängning och återaktivering av konton,
- tydlig spärr när tenant, roller eller domän inte är redo.

Direkt organisationsskapande är medvetet begränsat till `platform_super_admin`, eftersom vägen går förbi den vanliga ansökningsgranskningen. Drift-, onboarding- och provisioneringsroller kan inte använda denna bypass.

## API och datalager

Nya API-operationer:

- `GET /v1/platform/organizations`
- `POST /v1/platform/organizations`
- `GET /v1/signature-policies`

Befintliga kontooperationer används för kundinbjudan:

- `GET /v1/platform/organizations/{organizationId}/users`
- `POST /v1/platform/organizations/{organizationId}/users`
- `PATCH /v1/platform/organizations/{organizationId}/users/{accountId}`

Implementation:

- organisationsskapandet är idempotent,
- organisationsnummer normaliseras och kontrolleras mot både onboarding och befintliga tenants,
- huvudadministratörens e-post krypteras och blindindexeras,
- provisionering sker i befintlig kö med separata steg,
- kontrollplanshändelser loggas,
- tenantens signeringspolicyer hämtas organisationsisolerat,
- fel policy eller fel beslutsform avvisas server-side,
- OpenAPI-kontrakt och SDK-synkkontroll är uppdaterade.

## Kritisk rättning i kundportalen

Den tidigare portalen använde ett hårdkodat policy-ID. Ett sådant ID är inte giltigt för varje ny tenant och kunde därför stoppa kunden från att skapa sitt första avtal. Portalen laddar nu de aktiva policyerna via `GET /v1/signature-policies`, filtrerar dem efter vald beslutsform och skickar rätt tenantbunden policy till API:t.

## Kontoaktivering och dashboard

Det befintliga säkra kontoflödet är nu anslutet till organisationsvyn:

- inbjudan skapas endast server-side,
- publik självregistrering förblir avstängd,
- användaren sätter lösenord först efter verifierad e-postlänk,
- medlemskap och roll skapas i tenantens data-plane,
- destinationen härleds från aktivt medlemskap och aktiv primär domän,
- sessionen binds till organisationens hostname,
- fel tenant eller inaktiv domän ger ingen åtkomst.

## Produktionskrav före verkligt utskick

Kodleveransen ändrar inte den anslutna Supabase-miljön automatiskt. Följande måste vara satta och verifierade i målmiljön:

- Supabase Auth project URL, anon key och serverhemlig key,
- `AUTH_PUBLIC_SIGNUP_ENABLED=false`,
- Site URL `https://app.kommunsign.se`,
- tillåtna redirect-URL:er för `/aktivera/` och `/aterstall/`,
- anpassad SMTP/Resend för verklig leverans,
- verifierad `notify.kommunsign.se`,
- körande API och worker med produktionsadaptrar,
- aktuella control- och data-migrationer,
- verifierad wildcard-DNS/TLS eller motsvarande primär domän,
- `WORKER_CONSUMERS_READY=true` först efter verifierat jobbflöde.

## Installation och verifiering

```bash
npm ci
cp .env.production.template .env.production
# Fyll endast hemligheter i .env.production eller plattformens secrets.
npm run verify:env-contract
npm run db:migrate
npm run db:verify
npm run auth:configure-production
npm run verify:auth-config
npm run verify
```

Efter deployment:

```bash
npm run verify:deployment:live
```

## Synka patchen till ett befintligt projekt

Packa upp patchzippen och kör från katalogen som innehåller patchens projektstruktur:

```bash
rsync -av --delete-excluded \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'build/' \
  ./ /sökväg/till/kommunsign/
```

Använd inte `--delete` när endast patchzippen synkas.
