# Kommunsign Vercel build hotfix

## Orsak

`.vercelignore` exkluderade browserportalerna `apps/platform-admin`, `apps/tenant-portal`, `apps/signer-portal` och `apps/verification-portal`. Vercel laddade därför inte upp filerna som `scripts/build-vercel-unified.mjs` behöver.

## Ändringar

- Browserportalerna är inte längre exkluderade från Vercel-uploaden.
- Backendmapparna `apps/api` och `apps/workers` är fortfarande exkluderade.
- Node-versionen är låst till `22.x` i `package.json` och `package-lock.json`.
- Toolchain-kontrollen avvisar andra Node-majorversioner.

## Verifiering

```bash
npm run build:vercel
```

Förväntat resultat:

```text
Vercel unified build: 7 portaler i build/vercel
```
