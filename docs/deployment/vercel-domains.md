# Vercelprojekt och domäner

Kommunsign använder ett enda Vercel-projekt för samtliga statiska portaler:

```text
kommunsign-web
```

Projektet byggs från repositoryroten med `npm run build:vercel`.

## Domäner i Vercelprojektet

- `kommunsign.se` – publik webbplats samt `/ansok/`, `/signera/` och `/verifiera/`
- `app.kommunsign.se` – inloggning under `/login/` samt organisationsportal
- `admin.kommunsign.se` – plattformsadministration
- `www.kommunsign.se` – valfri redirect till roten

Det behövs ingen separat webbdomän för ansökan, Auth, signering eller verifiering.

## Tekniska domäner utanför Vercelwebben

- `api.kommunsign.se` – API och providerwebhooks
- `notify.kommunsign.se` – e-postdomän; ingen webbportal

## Custom domains

Verifierade kunddomäner kan senare kopplas till samma Vercelprojekt. Den statiska portalen är inte en säkerhetsgräns; API:t måste verifiera domänen mot control-databasen innan organisationskontext skapas.
