# Systemdokumentation — Kommunsign

Krav 2057 (svenska), 2058 (systemkrav, systemdesign, installationsanvisningar)
och 2061 (uppdateras vid förändring).

Senast uppdaterad: 2026-08-07. Uppdateringsrutinen står sist i dokumentet.

## 1. Systemkrav

### 1.1 Kundens krav

Kommunsign är en molntjänst. Kunden behöver ingen installation och ingen
klientprogramvara.

| Område | Krav |
| --- | --- |
| Webbläsare | Edge, Chrome eller Safari i version som får säkerhetsuppdateringar |
| Skärmbredd | Från 320 px; layouten är responsiv |
| Nätverk | Utgående HTTPS mot kundens Kommunsign-domän |
| Inloggning | Kommunens IdP över SAML 2.0 eller OIDC, alternativt lösenordskonto |
| Underskrift | BankID eller Freja på undertecknarens egen enhet |

Ingen brandväggsöppning inåt mot kommunen krävs. Federation och provisionering
initieras alltid från webbläsaren eller från kommunens katalog utåt.

### 1.2 Driftmiljöns krav

| Komponent | Krav |
| --- | --- |
| Node.js | 22.x (`engines` i package.json, kontrolleras av `scripts/check-toolchain.mjs`) |
| PostgreSQL | 15 eller senare, med `pgcrypto` |
| Objektlagring | S3-kompatibel, privat som standard |
| Redis | För köer och rate limiting |
| Java | 21 för gränstjänsterna signservice, validation-service och identity-service |
| Container | Dokumentprocessorn (qpdf, malware-skanning, PDF/A) |

## 2. Systemdesign

### 2.1 Grundprinciper

Fyra beslut styr designen och förklarar det mesta av strukturen.

**Control plane skild från data plane.** `control` håller tenants, domäner,
federation och onboarding. `app` (data plane) håller ärenden, dokument,
signaturer och bevis. En kund kan ha egen dataplansdatabas utan att
plattformslagret flyttar med. Se ADR 0002.

**Ren kärna, providers vid gränsen.** Affärsbeslut ligger i rena, testbara
moduler under `packages/` utan I/O. Allt som talar med omvärlden ligger bakom
ett interface — `SigningEngine`, `ElectronicIdentityProvider`, `EmailProvider`,
`DomainProvider`. Kärnan namnger aldrig en leverantör. Se ADR 0001 och 0003.

**Fail closed.** Varje okonfigurerad provider vägrar i stället för att falla
tillbaka på något tillåtande. En signeringstjänst som producerar något
signaturliknande när den saknar nyckelmaterial är farligare än en som vägrar.

**Servern äger tillstånd.** Klienten sätter aldrig `signed`, `completed`,
`validated` eller `archived`. Statusövergångar valideras i databasen
(`assert_valid_status_transition`) och i domänmodellen.

### 2.2 Komponenter

| Lager | Innehåll |
| --- | --- |
| Portaler | Sex statiska gränssnitt: auth, onboarding, platform-admin, tenant, signer, verification |
| API | `apps/api` — versionerat REST under `/v1`, tenantbunden autentisering, idempotensnycklar |
| Workers | `apps/workers` — persistenta, idempotenta, återupptagningsbara jobb |
| Domänpaket | `packages/*` — rena beslut: signering, identitet, gallring, integritet, arkiv, federation, SCIM |
| Gränstjänster | `services/*` — Java, kryptografi och providerprotokoll bakom mTLS |
| Datalager | PostgreSQL (control + data), objektlagring, Redis |

### 2.3 Signeringskedjan

```
uppladdning → virusskanning → PDF/A-kanonisering → låsning + SHA-256
  → signeringsintent (dokumentpaket med bilagor)
  → identitetsverifiering (BankID via TIC, Freja)
  → kryptografisk signering (SigningEngine)
  → tidsstämpling (TimestampProvider)
  → validering (SignatureValidator)
  → PAdES-antagning (nivå härledd ur faktisk evidens)
  → evidenspaket → arkivexport
```

Varje steg är ett eget tillstånd i `packages/signing-engine`. Ett steg kan inte
hoppas över, och signaturen måste täcka exakt den låsta dokumentversionens hash.

### 2.4 Dataflöde och tenantisolering

Tenant härleds ur verifierad domän, medlemskap, API-klient eller deployment —
aldrig ur ett fritt requestfält. Isoleringen bärs av tre lager som alla måste
hålla: RLS med `FORCE` på varje tenantbunden tabell, composite foreign keys som
bär `tenant_id` över varje relation, och applikationsauktorisering.

## 3. Installationsanvisningar

### 3.1 Lokal miljö

```bash
npm ci
npm run env:local:init
npm run db:up          # postgres, redis, minio, clamav, gotenberg, mailpit
npm run db:migrate
npm run db:verify
npm run dev
```

### 3.2 Produktion

1. **Miljövariabler.** Utgå från `.env.production.template`. Verifiera med
   `npm run verify:env` och `npm run verify:env-contract`.
2. **Hemligheter.** Endast som secret references (`vault://`, `aws-kms://`,
   `azure-keyvault://`, `gcp-secret://`). Klartexthemlighet i databas eller
   repo underkänns av `npm run scan:secrets`.
3. **Migrationer.** `npm run db:migrate` följt av `npm run db:verify`.
   Migrationer ändras aldrig i efterhand; en ny läggs till.
4. **Gränstjänster.** Bygg med `npm run verify:java`. Signeringsbackend
   aktiveras genom `KOMMUNSIGN_SIGNING_BACKEND` och
   `KOMMUNSIGN_SIGNING_KEY_PROTECTION`. Utan båda vägrar tjänsten signera.
5. **Portaler och API.** `npm run build:vercel` för portalerna,
   `npm run start:api` och `npm run start:workers` för körtiden.
6. **Verifiering.** `npm run verify` måste vara grön. `npm run verify:auth-config`
   och `npm run verify:container-health` kontrollerar den driftsatta miljön.

### 3.3 Uppgradering

Ny version testas i separat testmiljö före produktion. Migrationer är
additiva och bakåtkompatibla, så applikationen kan rullas ut före eller efter
schemaändringen. Rollback beskrivs per migration i dess `-- Rollback:`-rubrik.

## 4. Uppdateringsrutin (krav 2061)

Dokumentationen är en del av leveransen, inte en bilaga till den.

- Ändring i schema, publikt API eller behörighetsmodell kräver uppdatering av
  detta dokument och av `docs/system/BEHORIGHETSMODELL.md` i samma pull request.
- `docs/compliance/kungalv/REQUIREMENT_MATRIX.md` genereras ur
  `assessments.json` och `requirements.json`; `npm run verify` misslyckas om ett
  krav saknar bedömning, så matrisen kan inte hamna efter.
- `CHANGELOG.md` uppdateras vid varje leverans.
- Arkitekturbeslut som ändrar en princip skrivs som ny ADR under
  `docs/architecture/adr/` i stället för att ändra en befintlig.
