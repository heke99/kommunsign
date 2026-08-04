# Kommunsign – korrigering av ogiltig återställningslänk

## Grundorsak

På `https://app.kommunsign.se/aterstall/` finns inget fält för organisationsadress. Frontendfunktionen `destinationInput()` skickade ändå:

```json
{
  "destinationHostname": "app.kommunsign.se",
  "organizationSlug": ""
}
```

API-routen `/v1/auth/password/complete` tillåter inte en tom `organizationSlug` och svarade därför med `VALIDATION_ERROR` innan Supabase-tokenen verifierades. Portalen översatte sedan alla fel till texten att länken var ogiltig, vilket dolde den verkliga orsaken.

## Korrigering

- Tom eller saknad organisationsadress utelämnas nu helt från payloaden.
- För en verifierad användare på `app.kommunsign.se` väljer backend därefter destination utifrån användarens aktiva plattforms- eller tenantbehörighet.
- Lösenordssidan visar nu separata fel för ogiltig token, saknad behörighet, ogiltig destination, rate limit, providerfel och API-fel.
- Supabase `429` döljs inte längre som ett accepterat återställningsförsök. Endast uttryckliga användar-saknas-koder neutraliseras för att motverka kontouppräkning.

## Ändrade filer

- `apps/auth-portal/public/app.js`
- `packages/provider-adapters/src/supabase-auth.ts`
- `tests/run.mjs`

## Verifiering

Genomfört i leveransmiljön:

- JavaScript-syntaxkontroll av auth-portalen: OK
- JavaScript-syntaxkontroll av testsuiten: OK
- TypeScript-kompilering av Supabase Auth-adaptern: OK
- Simulerad återställningssida utan organisationsfält skickar endast `destinationHostname`: OK
- Simulerat Supabase-svar `429` mappas till `AUTH_RATE_LIMITED`: OK

Full `npm test` kunde inte köras i leveransmiljön eftersom dess interna npm-proxy saknade paketarkivet för `postgres@3.4.7`. Kör därför projektets fulla verifiering lokalt efter `npm ci`.

## Produktion

Efter merge/deploy behöver både Vercel och Railway byggas om eftersom ändringen berör frontend och API-adapter.

```bash
npm ci
npm test
npm run verify

git add apps/auth-portal/public/app.js \
  packages/provider-adapters/src/supabase-auth.ts \
  tests/run.mjs \
  PASSWORD_RECOVERY_INVALID_LINK_FIX.md \
  CHANGED_FILES_PASSWORD_RECOVERY_INVALID_LINK.txt

git commit -m "fix(auth): complete password recovery without empty organization slug"
git push
```

När deploymenten är klar ska en enda ny återställningslänk begäras. Varje ny Supabase recovery-begäran ersätter föregående engångstoken, så endast det senaste mejlet ska användas.
