# Lokal utveckling

## Verktyg

- Node.js 22 och npm 10
- Java 21
- PostgreSQL 17-klient (`psql`)
- Docker Compose

## Installation och verifiering

```bash
npm ci
cp .env.example .env
npm run verify
npm run web:build
npm run sbom
```

## Infrastruktur och migrationer

```bash
npm run db:up
npm run db:migrate
npm run db:verify
```

`db:verify` kör schemaverifiering och tenant-escape-test med icke-superuserroll. Migration `migrations/control/0006_onboarding_and_activation.sql` är additiv och ska köras efter tidigare control-plane-migrationer. I produktion ska migrationer journalföras och köras efter backup/stagingverifiering.

Återställ endast lokal testmiljö:

```bash
npm run db:reset:test
```

## API och portaler

Alla utvecklingsytor:

```bash
npm run dev
```

Separat körning:

```bash
npm run dev:api             # http://127.0.0.1:8787
npm run dev:website         # http://127.0.0.1:3000
npm run dev:platform-admin  # http://127.0.0.1:3001
npm run dev:tenant          # http://127.0.0.1:3002
npm run dev:signer          # http://127.0.0.1:3003
npm run dev:verify          # http://127.0.0.1:3004
npm run dev:onboarding      # http://127.0.0.1:3005
```

Kontroller:

```bash
curl -i http://127.0.0.1:8787/health/live
curl -i http://127.0.0.1:8787/health/ready
```

Utvecklingsruntime returnerar en verifieringstoken i create-responsen för automatiserade/lokala tester och använder bearer-token i portalen. Detta är avsiktligt dev-only. Produktionsadaptern ska skicka magic link och skapa en kortlivad HttpOnly-cookie med CSRF-skydd.

## Produktionsgräns

```bash
npm run build
APP_ENV=production \
KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE=<reviewed-module> \
KOMMUNSIGN_WORKER_ADAPTER_MODULE=<reviewed-module> \
npm run start:api
```

Produktionsruntime stoppar om adaptermoduler eller obligatoriska endpoints saknas och accepterar inte `dev-runtime`, `dev-onboarding` eller `dev-runner`.

## Testkategorier

```bash
npm run test:unit
npm run test:integration
npm run test:security
```

`test:e2e` och `test:accessibility` avslutas avsiktligt med blockerad status tills browser-, provider- och testmiljö är konfigurerad. Det får inte tolkas som ett grönt resultat.
