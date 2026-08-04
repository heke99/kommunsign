# Vercelprojekt och domäner

Kommunsign använder ett enda Vercel-projekt för samtliga statiska portaler:

```text
kommunsign-web
```

Projektet byggs från repositoryroten med `npm run build:vercel`. Rootens `vercel.json` väljer rätt portal utifrån Host-headern.

## Domäner i Vercelprojektet

- `kommunsign.se`
- `www.kommunsign.se`
- `apply.kommunsign.se`
- `admin.kommunsign.se`
- `auth.kommunsign.se`
- `app.kommunsign.se`
- `sign.kommunsign.se`
- `verify.kommunsign.se`
- `*.kommunsign.se`

`api.kommunsign.se` och `hooks.kommunsign.se` ska peka på den separata runtime-deploymenten. Explicit DNS för dessa två värdar ska överstyra wildcardposten.

## Custom domains

Verifierade kunddomäner kopplas till samma Vercelprojekt. Den statiska portalen är inte en säkerhetsgräns; API:t måste fortfarande verifiera domänen mot control-databasen innan organisationskontext skapas.

`VercelDomainProvider` använder backend-token och `VERCEL_WEB_PROJECT_ID`. Providerresultatet får inte ensamt markera domänen verifierad. DNS, TLS och organisationsbindning ska också passera.
