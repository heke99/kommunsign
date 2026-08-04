# Kommunsign – inloggning med endast e-post och lösenord

## Resultat

Inloggningsflödet kräver inte längre organisationsadress, tenant-slug eller destinationsdomän från användaren.

- `POST /v1/auth/login` accepterar endast `email` och `password`.
- Efter godkänd autentisering i Supabase Auth slår API:t upp användarens aktiva behörighet.
- En aktiv plattformsanvändare med minst en aktiv plattformsroll skickas till `https://admin.kommunsign.se/`.
- En aktiv tenantanvändare skickas till tenantens primära, verifierade och TLS-aktiva domän.
- Om en tenantanvändare har flera aktiva medlemskap används det senast skapade medlemskapet med en aktiv primärdomän.
- Lösenordsåterställning kräver endast e-post.
- Aktivering och lösenordsbyte routas automatiskt efter att e-posttokenen verifierats.
- Tom `organizationSlug` kan inte längre göra återställningslänken ogiltig.
- Supabase `429` och providerfel döljs inte längre bakom ett falskt accepterat återställningssvar.

## Ändrade filer

- `apps/auth-portal/public/index.html`
- `apps/auth-portal/public/app.js`
- `apps/api/src/ports.ts`
- `apps/api/src/auth-router.ts`
- `apps/api/src/production-adapters/postgres/authentication-repository.ts`
- `packages/provider-adapters/src/supabase-auth.ts`
- `docs/api/openapi.yaml`
- `tests/run.mjs`

## Verifiering

Följande kontroller har passerat:

- TypeScript 5.8.3-kompilering
- 37 enhetstester
- integrationstester för tenant-API och onboarding/provisionering
- säkerhetstester
- repositoryverifiering
- SQL-migrationsverifiering
- SDK-synkronisering
- secret scan
- Vercel unified build och deploymentkonfiguration

`npm ci` kunde inte användas i leveransmiljön eftersom den interna paketproxyn saknade `postgres@3.4.7`. Testerna kördes med den redan installerade låsta TypeScript-versionen 5.8.3; inga beroenden eller `node_modules` ingår i leveransen.

## Produktion

Både Vercel och Railway måste driftsätta ändringarna:

- Vercel: auth-portalens HTML och JavaScript.
- Railway: API-kontrakt, automatisk behörighetsrouting och Supabase-felmappning.
