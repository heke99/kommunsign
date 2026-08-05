# Kommunsign – förenklad domänmodell

Kommunsign använder tre ordinarie webbdomäner:

- `kommunsign.se` – webbplats, `/ansok/`, `/signera/`, `/verifiera/`
- `app.kommunsign.se` – gemensam inloggning och organisationsportal
- `admin.kommunsign.se` – plattformsadministration

`www.kommunsign.se` är endast en valfri redirect.

Tekniska adresser:

- `api.kommunsign.se` – API och webhooks
- `notify.kommunsign.se` – e-postdomän, ingen webbportal

## Organisationernas inloggning

Alla organisationer kan använda `app.kommunsign.se`. Tenant väljs från den verifierade användarens medlemskap och lagras i den hostbundna sessionen. En kommun behöver därför inte ange, köpa eller verifiera en egen domän för att huvudadministratören ska kunna bjudas in.

Kommunsign kan dessutom skapa ett plattformshanterat underdomännamn, exempelvis `kungalv.kommunsign.se`, eller ansluta en kundägd adress som `signering.kungalv.se`. Dessa adresser är valfria och får inte blockera ett vanligt `shared_saas`-införande.

`PLATFORM_WILDCARD_VERIFIED=true` får endast sättas när `*.kommunsign.se` faktiskt är verifierad och har aktiv TLS hos domänleverantören. Om den är `false` fortsätter ett vanligt `shared_saas`-införande via `app.kommunsign.se`; dedikerad drift kan fortfarande kräva separat domänkontroll.

Buildscriptet kopierar den publika webbplatsen till `build/vercel/index.html`, vilket gör att även Vercels genererade `*.vercel.app`-adress fungerar utan Host-rewrite.
