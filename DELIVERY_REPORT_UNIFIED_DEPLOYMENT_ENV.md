# Leveransrapport — gemensam Verceldeployment och lokal ENV

## Utgångspunkt

Arbetet är gjort mot den senast uppladdade `kommunsign-main (1).zip`. Den versionen innehöll BankID-/produktionsgrunden men saknade konto-/Auth-leveransen. Konto-/Auth-filerna och SQL-hotfixen har därför sammanfogats med den senaste versionen innan deployment- och ENV-ändringarna gjordes.

## Beslutad topologi

### Ett Vercelprojekt

`kommunsign-web` bygger och publicerar följande portaler i samma deployment:

- publik webb,
- ansökan,
- superadmin,
- auth/aktivering/glömt lösenord,
- organisationsportal,
- signerportal,
- verifieringsportal.

Rootens `vercel.json` använder host-baserade rewrites. Det ska inte skapas ett separat Vercelprojekt per portal.

### En separat runtime-deployment

`kommunsign-runtime` kör:

- API,
- inkommande webhooks,
- durable workers,
- ClamAV,
- qpdf,
- Gotenberg,
- veraPDF,
- isolerad XML-/evidensvalidering.

Detta är en enda containerstack/release, men består av flera processer och containrar. Supabase, TIC och Resend är externa hanterade tjänster.

## ENV

- `.env.local.example` är ny och är den enda lokala mallen.
- `npm run env:local:init` skapar `.env.local` utan att skriva över en befintlig fil.
- `.env.local` läses automatiskt av `npm run dev`, konto-/Auth-scripts och databasverifiering.
- `.env.example` och `.env.production.template` är fortsatt ett gemensamt produktionskontrakt.
- `VERCEL_TENANT_GATEWAY_PROJECT_ID` har ersatts med `VERCEL_WEB_PROJECT_ID`.
- `npm run verify:env:account-bootstrap` verifierar endast variablerna som krävs för Supabase Auth och första superadmin.
- `npm run verify:env` är den fullständiga slutkontrollen och ska köras när BankID, PDF, workers, DNS/TLS och evidensmiljö har verifierats.

## Lokalt

```bash
npm ci
npm run env:local:init
npm run db:up
npm run db:migrate
npm run db:verify
npm run dev
```

Gotenbergs hostport har flyttats från `3005` till `3007` för att inte krocka med onboardingportalen på `3005`.

## Första superadmin

Fyll de tomma Auth-/SMTP-/superadminvärdena i `.env.local` eller i en tillfällig säker setupmiljö och kör:

```bash
npm run verify:env:account-bootstrap
npm run auth:configure-production
npm run verify:auth-config
npm run auth:bootstrap-superadmin
```

Efter att aktiveringsmejlet har kommit fram, lösenordet satts och inloggning på `admin.kommunsign.se` fungerar sätts `SUPERADMIN_BOOTSTRAPPED=true` i runtime-miljön.

## Vercel

```bash
npm ci
npm run build:vercel
npx vercel project add
npx vercel link --yes --project kommunsign-web
npx vercel deploy --prod
```

Lägg portal- och wildcarddomänerna i samma Vercelprojekt. `api.kommunsign.se` ska peka på runtime-deploymenten och överstyra wildcard-DNS.

## Verifiering

Följande passerade efter slutändringarna:

- TypeScript 5.8.3,
- sex portalbyggen,
- gemensamt Vercelbygge med sju portaler,
- 33 enhetstester,
- integrationstester,
- säkerhetstester,
- repository verification,
- SQL migration verification,
- ENV-kontrakt med 184 variabler,
- SDK-synk,
- secret scan,
- Java self-test.

`npm ci` kunde inte köras i leveransmiljön eftersom dess interna npm-spegel saknade den låsta artefakten `postgres@3.4.7`. Samma kod verifierades med den installerade Node 22.16.0- och TypeScript 5.8.3-toolchainen. Kör ett rent `npm ci && npm run verify` i er normala lokala miljö eller CI.
