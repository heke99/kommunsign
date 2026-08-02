# Lokal utveckling

## Verktyg

- Node.js 22
- npm 10
- Java 21
- PostgreSQL 17 eller kompatibel stödd version
- Docker/Compose för lokal infrastruktur

## Installation och verifiering

```bash
npm ci
cp .env.example .env
npm run verify
npm run sbom
npm run provenance:report
```

Använd endast testhemligheter via lokal secret manager. Testidentity provider får endast aktiveras bakom explicit non-production guard och får aldrig skapa artefakter som ser ut som produktionssignaturer.

## Lokal infrastruktur

Verifiera/pinna image-digests innan start:

```bash
docker compose up -d postgres redis minio clamav gotenberg
```

## Migrationer

Control plane och data plane är separata databaser eller separata, strikt avgränsade deployment targets. Kör först backup och använd `ON_ERROR_STOP`.

```bash
for file in migrations/control/[0-9]*.sql; do
  psql "$CONTROL_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

for file in migrations/data/[0-9]*.sql; do
  psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

psql "$DATA_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/data/verify.sql
```

Kör alltid migrationerna mot en tom databas och en representativ befintlig databas i CI/staging innan produktion. Migrationerna `0009` och `0010` skärper status-, evidence- och oföränderlighetsregler och ska därför granskas mot befintlig data före utrullning.

## API shell

```bash
node apps/api/server.mjs
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
```

`ready` ska returnera 503 tills ett riktigt bootstrap-module med databas, auth och repositories har konfigurerats genom `KOMMUNSIGN_API_BOOTSTRAP_MODULE`.
