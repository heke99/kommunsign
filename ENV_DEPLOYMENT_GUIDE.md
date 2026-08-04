# ENV och deployment för Kommunsign

## Hur många deploymentprojekt?

- **Ett Vercel-projekt:** `kommunsign-web`, för alla webportaler och alla portal-/wildcarddomäner.
- **En runtime-deployment:** `kommunsign-runtime`, för API, webhooks, workers och dokumenttjänster.
- Supabase, TIC och Resend är externa tjänster och behöver inte egna Kommunsign-repositorydeployments.

Det ska alltså inte skapas ett Vercel-projekt per portal.

## Lokalt

Använd en enda fil:

```bash
npm run env:local:init
npm run dev
```

Filen `.env.local` läses av alla lokala rootkommandon. Lägg inte produktionshemligheter i den.

## Vercel

Vercelprojektet bygger statiska filer. Det behöver normalt inga databas-, Supabase service-role-, TIC-, Resend- eller krypteringshemligheter. Lägg endast publika byggvärden där om de används:

```text
NEXT_PUBLIC_PRODUCT_NAME
NEXT_PUBLIC_SITE_URL
NEXT_PUBLIC_API_PATH
NEXT_PUBLIC_AUTH_URL
NEXT_PUBLIC_VERIFY_URL
```

Alla domäner kopplas till samma projekt. Rootens `vercel.json` sköter host-routing.

## Runtime

Runtime-deploymenten får serverhemligheter och driftkonfiguration från `.env.production.template`, bland annat:

- `CONTROL_DATABASE_URL` och `DATA_DATABASE_URL`
- Supabase Auth/Storage service-role
- krypterings- och blind-indexnycklar
- CSRF/gateway/proxyhemligheter
- TIC API- och webhookhemligheter
- Resend API- och webhookhemligheter
- worker- och dokumenttjänstkonfiguration

## Tillfälliga setupvariabler

Följande används endast vid setup/bootstrap och ska därefter tas bort från vanlig runtime:

- `SUPABASE_MANAGEMENT_ACCESS_TOKEN`
- `AUTH_SMTP_PASSWORD`
- `SUPERADMIN_EMAIL`
- `SUPERADMIN_DISPLAY_NAME`
- `SUPERADMIN_ALLOW_EXISTING_USER`
- `VERCEL_API_TOKEN`

## Kontoordning

```bash
npm run verify:env:account-bootstrap
npm run auth:configure-production
npm run verify:auth-config
npm run auth:bootstrap-superadmin
```

När aktiveringsmejlet har kommit fram och superadmin kan logga in sätts `SUPERADMIN_BOOTSTRAPPED=true` i runtime-miljön.
