# Kommunsign samlad webb- och API-korrigering

## Rättade fel

- Publik root återfinns alltid i `build/vercel/index.html`.
- Apex/www-redirect har tagits bort ur kodkonfigurationen för att undvika dubbelägda redirect-loopar.
- `app` och `admin` är fail-closed och visar inte skyddat innehåll före verifierad serversession.
- Auth-routes och publika djupa routes har deterministiska assetvägar och Vercel-fallbacks.
- API- och worker-images innehåller `package.json`, produktionsberoenden och kompilerad ESM-kod.
- Railway stöds som betrodd proxy med Railway-headerbindning och verklig klient-IP.
- Validation-service kan nås över Railways privata `railway.internal`-nät.
- Separata Railway Config-as-Code-filer och ENV-underlag finns för API, workers och validation-service.
- Liveverifiering upptäcker redirect-loopar, portalblandning, oskyddade portalskal och API-readinessfel.

## Externa åtgärder som återstår

- Vercel Domains måste ha `kommunsign.se` utan redirect och endast en enkelriktad `www`-redirect om `www` används.
- Railwayprojektet och dess sex tjänster måste skapas i användarens konto.
- Supabase-, Resend- och senare TIC-hemligheter måste fyllas i.
- Railway måste verifiera både CNAME och TXT för `api.kommunsign.se`.
- Live- och containerkontroller måste köras med riktiga produktionsuppgifter.
