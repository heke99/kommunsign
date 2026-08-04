# Deploy av KommunSigns publika webbplats till Vercel

Den publika webbplatsen finns under:

```text
apps/public-website/public
```

Vercel bygger endast webbplatsen genom `npm run web:build` och publicerar resultatet från `build/public-site`. API, databasmigrationer och Java-tjänster deployas inte i samma Vercel-projekt.

## Lokal kontroll

```bash
npm ci
npm run web:dev
```

Öppna `http://localhost:3000`.

Produktionslik förhandsvisning:

```bash
npm run web:preview
```

## Första deploy med Vercel CLI

```bash
npm install -g vercel
vercel login
cd /sökväg/till/kommunsign
vercel link
vercel deploy
```

Kontrollera preview-adressen. Publicera därefter:

```bash
vercel deploy --prod
```

`vercel.json` definierar:

- `npm ci --ignore-scripts` som installation,
- `npm run web:build` som buildkommando,
- `build/public-site` som output directory,
- HTTPS- och webbläsarsäkerhetsheaders,
- clean URLs och trailing slash.

## Deploy via GitHub

1. Pusha repositoryt till GitHub.
2. Skapa ett nytt Vercel-projekt och importera repositoryt.
3. Låt **Root Directory** vara repositoryts rot.
4. Vercel läser `vercel.json`; skriv inte över Build Command eller Output Directory i dashboarden.
5. Deploya en preview och verifiera sidorna `/`, `/ansok/`, `/sakerhet/`, `/integritet/`, `/tillganglighet/` och `/kontakt/`.

Varje push till en branch skapar därefter en preview. Produktion bör kopplas till `main`.

## Domän

Lägg först till:

```text
kommunsign.se
www.kommunsign.se
```

Välj `kommunsign.se` som primär domän och redirecta `www` till apex-domänen. Följ de DNS-poster Vercel visar för den aktuella domänen. Vercel provisionerar TLS efter att DNS verifierats.

## Verifiering efter deploy

```bash
vercel curl / --deployment <deployment-url>
vercel logs --environment production --level error --since 5m
```

Kontrollera även i webbläsaren:

- mobilnavigation,
- samtliga interna länkar,
- 404-sida,
- sidtitlar och beskrivningar,
- security headers,
- `robots.txt`,
- `sitemap.xml`,
- Open Graph-bild.

## Viktiga avgränsningar

Denna Vercel-deploy gäller endast marknadswebbplatsen. Följande ska ligga i separata driftprojekt:

- onboardingportal (`kommunsign.se/ansok/`),
- tenantportal,
- signeringsportal,
- plattformsadmin,
- API,
- workers,
- Java SignService,
- valideringstjänst,
- PostgreSQL, köer och objektlagring.

E-postadresserna `kontakt@kommunsign.se`, `sakerhet@kommunsign.se`, `integritet@kommunsign.se` och `tillganglighet@kommunsign.se` måste skapas hos e-postleverantören innan publik lansering.
