# Lokal utveckling

1. Installera Node 22, npm och Java 21. TypeScript installeras lokalt från den låsta npm-versionen.
2. Kör `npm ci` i repositoryts rot.
3. Kopiera `.env.example` till `.env`; använd endast testhemligheter via lokal secret manager.
4. Kör `npm run verify`.
5. Starta lokal infrastruktur med Docker Compose efter att image digests har verifierats och ersatts.
6. Kör SQL i ordning: control 0001, data 0001–0006, därefter `verify.sql`.

En lokal `TEST_ONLY` identity provider får endast byggas bakom explicit non-production guard och får aldrig producera artefakter som ser ut som produktionssignaturer.
