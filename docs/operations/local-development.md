# Lokal utveckling

1. Installera Node 22, TypeScript 5.8+ och Java 21.
2. Kopiera `.env.example` till `.env`; använd endast testhemligheter via lokal secret manager.
3. Kör `npm run verify`.
4. Starta lokal infrastruktur med Docker Compose efter att image digests har verifierats och ersatts.
5. Kör SQL i ordning: control 0001, data 0001–0006, därefter `verify.sql`.

En lokal `TEST_ONLY` identity provider får endast byggas bakom explicit non-production guard och får aldrig producera artefakter som ser ut som produktionssignaturer.
