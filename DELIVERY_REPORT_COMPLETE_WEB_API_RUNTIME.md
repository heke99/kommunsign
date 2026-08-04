# Leveransrapport — komplett webb-, domän- och API-runtimekorrigering

## Mål

Rätta den senaste repositoryversionen så att:

- `kommunsign.se` har en verklig Vercel-root,
- `app.kommunsign.se` och `admin.kommunsign.se` aldrig ser inloggade ut utan verifierad session,
- Auth- och public-flow-routes fungerar på djupa URL:er,
- ett separat produktionsprojekt kan köra `api.kommunsign.se`, workers och dokumenttjänster,
- Railway-ingress ger korrekt originalhost och klient-IP,
- Dockerbilderna faktiskt kan köra kompilerad ESM-kod med produktionsberoenden,
- konfigurationen kan verifieras maskinellt före och efter deployment.

## Implementerat

### Vercel/webb

- Publik webbplats kopieras till `build/vercel/index.html`.
- Apex/www-redirect har tagits bort ur `vercel.json`; redirecten ska endast ägas av Vercel Domains.
- Ordnad host-routing för `app.kommunsign.se` och `admin.kommunsign.se`.
- Fail-closed auth-gates för verksamhets- och administrationsportalerna.
- Absoluta assetvägar för ansökan, signering och verifiering.
- Fallbacks för djupa public-flow-routes.
- Portal-/deploymentheaders för livefelsökning.

### API/runtime

- Separat Railwaytopologi för `api`, `workers`, `validation-service`, `clamav`, `gotenberg` och `verapdf`.
- Config-as-Code-filer per GitHub-service.
- Railway project-level ENV-underlag med kända Kommunsign-domäner och superadmin `hekmat.h@div3rsa.com`.
- Railway trusted-proxy-stöd med `X-Real-IP`, forwarded host/proto och Railway edge/request headers.
- Stöd för privata `*.railway.internal`-adresser i validation-client.
- EU West regionidentifierare korrigerad till `europe-west4-drams3a`.
- API- och worker-Dockerbilder kopierar `package.json`, `node_modules` och kompilerad kod till slutimagen.
- `.dockerignore` tillagd.

### Verifiering

- `verify:deployment-config` bygger och kontrollerar Vercel-output, auth-gates, Dockerbilder och Railwaymanifest.
- `verify:deployment:live` upptäcker redirect-loopar, fel portalinnehåll, oskyddade portaler och API-readinessfel.
- Railway proxy-test tillagt.
- Repositoryverifieringen utökad med runtime-/deploymentkraven.

## Externa åtgärder

1. I Vercel ska `kommunsign.se` vara Production domain utan redirect.
2. Endast `www.kommunsign.se` får eventuellt redirecta till apex.
3. Railwayprojektet `kommunsign-runtime` och tjänsterna måste skapas i användarens konto.
4. Supabase-, Resend- och senare TIC-hemligheter måste fyllas i.
5. `api.kommunsign.se` ska kopplas till Railway API-service med både CNAME och TXT.
6. Containerhälsa och liveacceptans måste köras i målmiljön.

## Rekommenderad deployordning

1. Synka denna changed-only-leverans.
2. Kör `npm ci` och `npm run verify` lokalt/CI.
3. Pusha och låt Vercel deploya webben.
4. Rätta Vercel Domains enligt `RAILWAY_API_RUNTIME_SETUP.md`.
5. Kör `VERIFY_API=false npm run verify:deployment:live`.
6. Skapa Railwayprojektet och de sex runtime-tjänsterna.
7. Lägg in shared/service ENV.
8. Kör databasmigrationer och verifieringar.
9. Deploya interna tjänster, sedan API, sedan workers.
10. Koppla `api.kommunsign.se` och kör full `npm run verify:deployment:live`.
