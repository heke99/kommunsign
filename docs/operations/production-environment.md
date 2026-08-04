# Produktionsmiljö

## Miljöfiler

- `.env.example` är det kanoniska kontraktet med samtliga variabelnamn.
- `.env.production.template` är en identisk, tom hemlighetsmall.
- Inga verkliga nycklar ska sparas i Git eller lokala zip-leveranser.
- `npm run verify:env-contract` bevisar att mallarna är synkroniserade och att direkta runtime-referenser är deklarerade.
- `npm run verify:env` validerar den faktiska målmiljön och stoppar vid saknad hemlighet, fel URL, osäker flagga eller overifierad driftskomponent.

## Ordning

1. Skapa control- och data-plane-databaser.
2. Skapa privata Supabase Storage-buckets.
3. Skapa Supabase Auth-projekt och stäng publik registrering.
4. Fyll deployment-variablerna för Supabase Management API och Auth SMTP, kör `npm run auth:configure-production` och därefter `npm run verify:auth-config`.
5. Lägg serverhemligheter i godkänd secrets manager.
6. Kör control-migrationer i nummerordning.
7. Kör data-migrationer i nummerordning.
8. Kör `npm run db:verify`.
9. Deploya ett gemensamt Vercel-projekt med `npm run build:vercel` och koppla samtliga portal- och wildcarddomäner till projektet.
10. Deploya den separata runtime-stacken med API, workers, dokumenttjänster och valideringstjänst i privat nät.
11. Kör `npm run auth:bootstrap-superadmin`.
12. Verifiera första superadmininloggningen.
13. Verifiera kontoinbjudan, glömt lösenord, e-post, TIC, PDF-pipeline och evidensfixtures.
14. Kör `npm run verify:env`.
15. Aktivera TIC per intern organisation, genomför smoke-test och öppna därefter per godkänd organisation.

## Hemlighetsgräns

Följande får endast finnas server-side:

- databas-URL:er,
- Supabase service-role-nycklar och tillfällig Management API-token,
- krypterings- och blind-indexnycklar,
- CSRF-, gateway-HMAC- och trusted-proxy-nycklar,
- TIC API-/webhookhemligheter,
- Resend API-/webhookhemligheter,
- validation service token,
- Vercel API-token.

Frontend får endast använda `NEXT_PUBLIC_*`-värden och publika URL:er.

## Generera nycklar

```bash
openssl rand -base64 32   # encryption key
openssl rand -base64 32   # blind-index key
openssl rand -hex 32      # CSRF signing key
openssl rand -hex 32      # internal gateway HMAC key
openssl rand -hex 32      # trusted proxy shared secret
openssl rand -hex 32      # validation service token
```

Varje nyckel ska genereras separat. Dokumentera referensen i secrets manager, inte själva värdet.

## Vercel

Alla statiska portaler byggs i ett gemensamt Vercel-projekt. Rootens `vercel.json` använder host-baserade rewrites för att välja rätt portal och applicerar CSP, HSTS, `nosniff`, `frame-ancestors 'none'` och `Referrer-Policy: no-referrer`. API, webhooks och dokumentworkers körs i den separata runtime-stacken. Se `docs/operations/deployment-topology.md`.

## En gemensam lokal ENV-fil

Skapa `.env.local` med:

```bash
npm run env:local:init
```

`npm run dev`, databasverifiering och konto-/Auth-scripts läser automatiskt `.env.local` när filen finns. Den riktiga filen är ignorerad av Git. `.env.local.example` är den säkra mallen.

För att kontrollera endast konfigurationen som krävs för första superadminkontot:

```bash
npm run verify:env:account-bootstrap
```

Den fullständiga `npm run verify:env` används först när hela BankID-, e-post-, PDF-, worker-, DNS- och evidensmiljön har verifierats.
