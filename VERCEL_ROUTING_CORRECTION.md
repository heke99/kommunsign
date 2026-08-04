# Vercel routing correction

## Root cause

The previous unified build copied the public site to `build/vercel/index.html`.
Vercel resolves an existing filesystem object before applying `rewrites`, so the
root index won for `app.kommunsign.se/` and `admin.kommunsign.se/`. The hostname
rules therefore never selected the tenant or admin portal at `/`.

## Correct invariant

All seven portal outputs are stored only under `build/vercel/__portals/*`.
There is no `build/vercel/index.html`. `vercel.json` then selects:

- `kommunsign.se/*` -> public portal, with explicit public-flow paths.
- `app.kommunsign.se/login/*`, `/aktivera/*`, `/aterstall/*` -> auth portal.
- all other `app.kommunsign.se/*` -> organization portal.
- all `admin.kommunsign.se/*` -> platform administration.

The final public catch-all also lets the generated `*.vercel.app` URL show the
public website without requiring a root file.

## Environment

No Vercel environment-variable change is needed for this correction. The
minimal-domain production values remain correct:

- `PUBLIC_WEBSITE_URL=https://kommunsign.se`
- `TENANT_DISCOVERY_URL=https://app.kommunsign.se`
- `AUTH_BROKER_URL=https://app.kommunsign.se/login/`
- `PLATFORM_ADMIN_URL=https://admin.kommunsign.se`
