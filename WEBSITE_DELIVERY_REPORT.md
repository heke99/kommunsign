# KommunSign – publik webbplats och Vercel-leverans

Statusdatum: 2026-08-02.

## Levererat

- Responsiv svensk marknadswebb för KommunSign.
- Startsida med produktpositionering, arbetsflöde, säkerhetsmodell, användningssätt, frågor och pilot-CTA.
- Undersidor för teknisk säkerhet, integritet, tillgänglighet, kontakt och ansökningsingång.
- Mobilnavigation, skip link, tydliga fokusmarkeringar och reduced-motion-stöd.
- SVG-logotyp, favicon, Open Graph-bild, manifest, robots.txt, sitemap och 404-sida.
- Strikt Content Security Policy och övriga säkerhetsheaders i `vercel.json`.
- Isolerad webbbuild som inte ändrar TypeScript/API-bygget.
- Lokala kommandon: `web:dev`, `web:build` och `web:preview`.
- Vercel CLI- och GitHub-deployinstruktioner.

## Verifierat

- `npm run web:build`: grön, 7 HTML-sidor byggda.
- Intern länk- och resurskontroll i webbbuilden.
- Strikt CSP-kompatibilitet: inga inline scripts eller inline styles.
- Hela `npm run verify`: grön med 22 tester och fem portalbyggen.
- HTTP-kontroll: fem publika sidor och logotyp gav 200; okänd sökväg gav 404.

## Avgränsning

Vercel-projektet publicerar endast marknadswebbplatsen. Onboardingportal, API, workers, administrationsportal, tenantportal, signeringsportal och Java-tjänster ska deployas separat. `/ansok` på marknadswebben leder till `apply.kommunsign.se`.

## Före publik lansering

- Skapa e-postadresserna som visas på webbplatsen.
- Slutgranska integritets- och tillgänglighetstexterna juridiskt.
- Koppla `kommunsign.se` och `www.kommunsign.se` i Vercel.
- Testa webbplatsen i verkliga mobil- och skärmläsarmiljöer.
- Uppdatera pilotbudskapet när produktens verifierade status förändras.
