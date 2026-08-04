# Deploymenttopologi

## Beslut

Den första produktionsarkitekturen består av två deployenheter:

1. **`kommunsign-web`** – ett Vercel-projekt för alla statiska webbportaler.
2. **`kommunsign-runtime`** – en containerbaserad backenddeployment för API, webhooks, workers, ClamAV, Gotenberg, veraPDF och den isolerade valideringstjänsten.

Supabase, TIC och Resend är hanterade externa tjänster.

## Webbdomäner

- `kommunsign.se` – webbplats, ansökan, signering och verifiering via paths
- `app.kommunsign.se` – inloggning och organisationsportal
- `admin.kommunsign.se` – superadmin
- `www.kommunsign.se` – valfri redirect

## Runtime och e-post

- `api.kommunsign.se` – API och providerwebhooks
- `notify.kommunsign.se` – e-postavsändardomän

## Varför app och admin är separata

Kommunsign använder hostbundna sessioner och `__Host-`-cookies. En separat adminhost minskar risken att organisationssessioner och plattformsadministration blandas ihop eller skriver över varandras cookies.

## Miljövariabler

- Lokalt används en enda `.env.local`.
- Vercel behöver endast publika URL:er och byggkonfiguration.
- Runtime får databas-, Supabase service-role-, krypterings-, TIC-, Resend- och workerhemligheter.
