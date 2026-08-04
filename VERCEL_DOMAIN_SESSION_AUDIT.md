# Vercel, domän och sessionsgranskning

## Fynd

- Den publika webbplatsen finns i `build/vercel/index.html`. Om `kommunsign.se` inte svarar är det därför ett Vercel-domän- eller DNS-problem, inte en saknad rootfil i repositoryt.
- `app.kommunsign.se` och `admin.kommunsign.se` är skyddade portaler men deras HTML visades tidigare innan `/v1/auth/session` var verifierad.
- Om `api.kommunsign.se` saknades eller var otillgängligt såg användaren hela portalen trots att ingen session hade godkänts.
- Portalerna är nu fail-closed: innehållet har `hidden` tills API:t verifierat en hostbunden session.
- Vid 401/403 skickas användaren till `app.kommunsign.se/login/`.
- Vid nätverks-/API-fel visas endast en säker anslutningsruta och portalen förblir dold.

## Livekontroll

Kör efter deployment:

```bash
npm run verify:web:live
```

Kontrollen verifierar publik DNS, HTTP-status, sidtitlar och att skyddade portaler levereras med auth-gate och dolt innehåll.

## Kontroll av rootdomänen i Vercel

```bash
npx vercel domains inspect kommunsign.se
npx vercel domains inspect app.kommunsign.se
npx vercel domains inspect admin.kommunsign.se
```

`kommunsign.se` måste vara kopplad till samma Vercel-projekt som den aktuella Production-deploymenten och visa `Valid Configuration`. Den får inte vara konfigurerad som redirect till `app.kommunsign.se`.
