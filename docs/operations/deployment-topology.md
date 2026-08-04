# Deploymenttopologi

## Beslut

Kommunsign använder inte ett separat Vercel-projekt per portal.

Den första produktionsarkitekturen består av två deployenheter:

1. **`kommunsign-web`** — ett Vercel-projekt för publik webb, ansökan, superadmin, auth, organisationsportal, signerportal och verifieringsportal. Alla domäner pekar på samma Vercel-projekt och `vercel.json` väljer portal efter verifierad host.
2. **`kommunsign-runtime`** — en containerbaserad backenddeployment för API, webhooks, workers, ClamAV, Gotenberg, veraPDF och den isolerade valideringstjänsten.

Supabase, TIC och Resend är hanterade externa tjänster och är inte egna Kommunsign-deployments.

## Varför inte endast Vercel?

Vercel passar de statiska portalerna och korta HTTP-anropen. Kommunsigns dokumentflöde behöver däremot långlivade kökonsumenter, qpdf/ClamAV, isolerad PDF/A-konvertering och intern XML-validering. Dessa komponenter ska köras i en container-runtime med privat nät, resursgränser och beständig workerprocess.

## Domäner

### Vercelprojektet

- `kommunsign.se`
- `www.kommunsign.se`
- `apply.kommunsign.se`
- `admin.kommunsign.se`
- `auth.kommunsign.se`
- `app.kommunsign.se`
- `sign.kommunsign.se`
- `verify.kommunsign.se`
- `*.kommunsign.se`

### Runtime

- `api.kommunsign.se`
- `hooks.kommunsign.se`

Explicit DNS för `api` och `hooks` ska överstyra wildcardposten.

## Miljövariabler

- Lokalt används en enda `.env.local` för hela repositoryt.
- Vercel behöver endast publika URL:er och byggkonfiguration; portalerna har inga serverhemligheter.
- Runtime-deploymenten får databas-, Supabase service-role-, krypterings-, TIC-, Resend- och workerhemligheter.
- Deploymenttokens som `SUPABASE_MANAGEMENT_ACCESS_TOKEN` används endast vid konfiguration och tas bort från vanlig runtime.
