# Kommunsign Vercel minimal domains hotfix

## Resultat

- Publik webb kopieras till `build/vercel/index.html`.
- Vercels genererade `*.vercel.app`-adress fungerar utan Host-rewrite.
- Endast tre webbdomäner krävs i Vercel:
  - `kommunsign.se`
  - `app.kommunsign.se`
  - `admin.kommunsign.se`
- `www.kommunsign.se` är en valfri redirect.
- Publika flöden använder paths:
  - `/ansok/`
  - `/signera/`
  - `/verifiera/`
- `api.kommunsign.se` används senare av backend och webhooks.
- `notify.kommunsign.se` används endast som e-postdomän.

## Verifierat

- `npm run build:vercel` passerar.
- `npm run verify:repository` passerar.
- `npm run verify:migrations` passerar.
- `vercel.json` och `infrastructure/vercel/projects.json` är giltig JSON.
- Statisk HTTP-kontroll gav 200 för `/`, `/ansok/`, `/signera/` och `/verifiera/`.

Full TypeScript-verifiering kunde inte köras i leveransmiljön eftersom den interna npm-spegeln saknar `postgres@3.4.7`. Användarens lokala `npm run build` hade redan passerat före denna hotfix.
