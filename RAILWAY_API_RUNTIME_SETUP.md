# Kommunsign API/runtime på Railway

## Målbild

Kommunsign använder två deploymentmål:

1. **Vercelprojektet `kommunsign-web`** för statiska webbportaler.
2. **Railwayprojektet `kommunsign-runtime`** för API, workers och interna dokument-/valideringstjänster.

Endast API-tjänsten exponeras publikt från Railway. Workers, ClamAV, Gotenberg, veraPDF och validation-service ska endast nås via Railways privata nät.

## A. Återställ `kommunsign.se` i Vercel

I Vercelprojektets **Settings → Domains** ska domänerna vara konfigurerade så här:

| Domän | Inställning |
|---|---|
| `kommunsign.se` | Production domain, **ingen Redirect to** |
| `www.kommunsign.se` | Valfri redirect till `kommunsign.se` |
| `app.kommunsign.se` | Production domain, ingen redirect |
| `admin.kommunsign.se` | Production domain, ingen redirect |

Ta bort en eventuell redirect från `kommunsign.se` till `www.kommunsign.se` om `www` samtidigt redirectar tillbaka. Repositoryt innehåller inte längre en programmatisk apex/www-redirect; endast Vercels domäninställning ska äga den redirecten.

Efter push och ny deployment:

```bash
VERIFY_API=false npm run verify:deployment:live
```

Om kommandot rapporterar `REDIRECT_LOOP` ligger felet i Vercels Domains-inställningar eller DNS, inte i ENV.

## B. Skapa Railwayprojektet

1. Skapa ett tomt Railwayprojekt med namnet `kommunsign-runtime`.
2. Välj Production environment.
3. Välj region **EU West / Amsterdam** för samtliga runtime-tjänster.
4. Koppla samma GitHub-repository som Vercel använder.

## C. Skapa tjänsterna

### 1. API

Skapa en GitHub-service med namnet `api`.

I serviceinställningarna:

```text
Config file path: /infrastructure/railway/api.railway.json
```

Den bygger `infrastructure/docker/api.Dockerfile`, lyssnar på port `8787` och använder `/health/ready` som healthcheck.

### 2. Workers

Skapa en till GitHub-service från samma repository med namnet `workers`.

```text
Config file path: /infrastructure/railway/workers.railway.json
```

Workers ska inte ha Public Networking.

### 3. Validation service

Skapa en tredje GitHub-service med namnet `validation-service`.

```text
Config file path: /infrastructure/railway/validation-service.railway.json
```

Tjänsten lyssnar på port `8082` och ska inte ha Public Networking.

### 4. ClamAV

Skapa en service från Docker image:

```text
clamav/clamav:1.5.3-debian13-slim
```

Namnge tjänsten exakt `clamav`. Exponera inte tjänsten publikt. Intern port är `3310`.

### 5. Gotenberg

Skapa en service från Docker image:

```text
gotenberg/gotenberg:8.34.0
```

Namnge den exakt `gotenberg`. Startkommando:

```text
gotenberg --api-disable-health-check-logging=true --chromium-disable-javascript=true --api-timeout=120s
```

Ingen Public Networking. Intern port `3000`.

### 6. veraPDF

Skapa en service från Docker image:

```text
verapdf/rest:v1.30.2
```

Namnge den exakt `verapdf`. Ingen Public Networking. Intern port `8080`.

## D. Lägg in Railway-variabler

Använd:

```text
infrastructure/railway/shared.runtime.env.example
```

som underlag för Railway Project Settings → Shared Variables. Dela variablerna med `api` och `workers`.

Fyll först:

- `CONTROL_DATABASE_URL`
- `DATA_DATABASE_URL`
- `SUPABASE_DATA_PROJECT_URL`
- `SUPABASE_DATA_SERVICE_ROLE_KEY`
- `SUPABASE_AUTH_PROJECT_URL`
- `SUPABASE_AUTH_PROJECT_REF`
- `SUPABASE_AUTH_ANON_KEY`
- `SUPABASE_AUTH_SERVICE_ROLE_KEY`
- samtliga kryptonycklar
- `VALIDATION_SERVICE_TOKEN`
- Resend-uppgifter

Railway injicerar `RAILWAY_ENVIRONMENT_ID` automatiskt. Skapa inte den manuellt.

API-tjänstens egna variabler finns i:

```text
infrastructure/railway/api.env.example
```

Worker-tjänstens egna variabler finns i:

```text
infrastructure/railway/workers.env.example
```

Validation-service ska få samma `VALIDATION_SERVICE_TOKEN` som API/workers använder.

## E. Databas och storage

Kör migrationerna från lokal dator eller CI med produktionsdatabasernas anslutningssträngar:

```bash
npm run db:migrate
npm run db:verify
```

Skapa/verifiera privata Supabase Storage-buckets innan API aktiveras.

## F. Deploymentordning

1. `clamav`
2. `gotenberg`
3. `verapdf`
4. `validation-service`
5. kör `npm run verify:container-health` mot privata tjänster
6. kör databasmigrationer och verifiering
7. `api`
8. kontrollera Railway-domänen med `/health/live` och `/health/ready`
9. `workers`
10. sätt `WORKER_CONSUMERS_READY=true` först när workers faktiskt hämtar jobb

## G. Koppla `api.kommunsign.se`

`api.kommunsign.se` får inte ligga som domän på Vercels webbprojekt.

I Railway:

```text
api service → Settings → Networking → Public Networking → Custom Domain
```

Ange:

```text
api.kommunsign.se
```

Målport:

```text
8787
```

Railway visar en CNAME-post och en TXT-verifieringspost. Lägg in **båda** hos DNS-leverantören. Om DNS hanteras av Vercel lägger du posterna i Vercels DNS-zon för `kommunsign.se`.

Ta bort tidigare `api`-poster som pekar på Vercels webbprojekt. En host får inte samtidigt peka mot både Vercel och Railway.

Kontrollera:

```bash
curl -sS https://api.kommunsign.se/health/live
curl -sS https://api.kommunsign.se/health/ready
```

Förväntat:

```json
{"status":"UP"}
```

## H. Slutverifiering

```bash
npm run build:vercel
npm run verify:deployment-config
npm run verify:repository
npm run verify:migrations
npm run verify:env-contract
npm run verify:deployment:live
```

`app.kommunsign.se` och `admin.kommunsign.se` ska visa en verifieringsruta tills API:t har godkänt sessionen. Skyddat innehåll får aldrig visas före sessionkontrollen.
