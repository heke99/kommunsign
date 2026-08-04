# Kommunsign – förenklad Vercel-domänmodell

Kommunsign använder ett Vercel-projekt och endast tre webbdomäner:

- `kommunsign.se` – webbplats, `/ansok/`, `/signera/`, `/verifiera/`
- `app.kommunsign.se` – inloggning under `/login/` samt organisationsportal
- `admin.kommunsign.se` – plattformsadministration

`www.kommunsign.se` är endast en redirect och är valfri.

Tekniska adresser som läggs till senare:

- `api.kommunsign.se` – API och webhooks
- `notify.kommunsign.se` – e-postdomän, ingen webbportal

Buildscriptet kopierar den publika webbplatsen till `build/vercel/index.html`, vilket gör att även Vercels genererade `*.vercel.app`-adress fungerar utan Host-rewrite.
