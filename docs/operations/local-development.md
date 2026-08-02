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

`db:verify` kör både schemaverifiering och ett tenant-escape-test med en icke-superuserroll. I produktion ska migrationer köras separat mot `CONTROL_DATABASE_URL` och `DATA_DATABASE_URL` efter backup och stagingverifiering.

Återställ endast lokal testmiljö:

```bash
npm run db:reset:test
```

## API och portaler

Terminal 1:

```bash
npm run dev:api
```

Terminal 2:

```bash
npm run dev:tenant
```

Kontroller:

```bash
curl -i http://127.0.0.1:8787/health/live
curl -i http://127.0.0.1:8787/health/ready
```

Utvecklingsruntime använder `KOMMUNSIGN_API_BOOTSTRAP_MODULE=../../dist/apps/api/src/dev-runtime.js`. Modulen stoppar om `APP_ENV=production`. Produktionsruntime ska i stället injicera OAuth/mTLS, PostgreSQLrepositories, objektlagring och provideradapters.

## Testkategorier

```bash
npm run test:unit
npm run test:integration
npm run test:security
```

`test:e2e` och `test:accessibility` avslutas avsiktligt med blockerad status tills browser-, provider- och testmiljön är konfigurerad. Det ska inte tolkas som ett grönt testresultat.
