# Leveransrapport — Kommunsign BankID-produktionsfas

Datum: 2026-08-03  
Repository: `kommunsign-main`  
Kontraktsversion: `2026-08-03.1`  
Datamigration: `migrations/data/0013_bankid_production_foundation.sql`

## 1. Mål

Repositoryt har byggts vidare till en fail-closed produktionsgrund för följande kedja:

> Privat PDF-uppladdning → ClamAV/qpdf-policy → PDF/A-2b via Gotenberg → veraPDF-validering → immutable flerhandlingsmanifest med SHA-256 → BankID-signering via TIC:s produktions-API → fristående TIC XML-DSig/OCSP → oberoende verifiering → deterministiskt evidenspaket → provider-neutral e-post med Resend-adapter.

Den juridiska produktbeskrivningen är **BankID-baserad avancerad elektronisk underskrift med fristående kryptografiskt bevispaket**. Implementationen påstår inte PAdES, PAdES-LT/LTA eller kvalificerad elektronisk underskrift.

## 2. Implementerat

### Domän, tenant och säkerhetsgränser

- Befintlig control/data-plane-arkitektur, tenant transaction context, forced RLS, tenant-FK, outbox, durable jobs, audit hash chain och idempotens har bevarats.
- Kanoniska `kommunsign.se`-domäner, reserved tenant slugs, verifierad Host/forwarded-host och trusted-proxy-policy finns i konfiguration och runtime.
- Publika signer-, webhook- och verifieringsrutter går före vanlig användarsession men använder hashade opaque tokens, rå-body-signaturkontroll och verifierad providerbindning.
- CSP, anti-framing, `nosniff`, `no-store` och PII-redaction är tillagda där signer-/verifieringsflödet kräver det.

### Personnummer

- Svenskt personnummer normaliseras till 12 siffror och valideras med datum och kontrollsiffra.
- Förväntat personnummer och e-post krypteras; blind index används för exakt matchning.
- Klartext loggas inte och UI visar maskerad form.
- `STRICT_PREBOUND` skickar `personalNumber` till TIC och kräver exakt eftermatchning.
- `BANKID_DISCOVERED` kräver tenantpolicy, behörigheten `signer:personnummer-binding-exempt`, godkänd orsakskod, fritext för `OTHER`, riskvarning och audit.

### Dokumentpipeline

- Single-use upload grant och server-side complete-verifiering av storlek/checksumma.
- Privata object paths börjar med tenant-ID.
- ClamAV `INSTREAM`, qpdf struktur-/policykontroll, Gotenberg PDF/A-2b och veraPDF-rapport.
- Krypterade PDF:er, JavaScript, OpenAction, Launch, embedded files, XFA, fel MIME/magic bytes och policygränser avvisas fail-closed.
- Canonical SHA-256 beräknas först efter konvertering och validering.
- Canonical dokument låses och kan inte ersättas efter signing-intent-start.

### TIC BankID

- Direkt backendintegration mot TIC:s REST API för start, status, collect, cancel och one-time extend.
- Deterministisk synlig text samt canonical `kommunsign.bankid-evidence.v2` för en eller flera handlingar.
- QR och samma-enhet stöds.
- Polling är begränsad till två sekunder, `Retry-After` respekteras och temporära fel separeras från definitiva fel.
- TIC-webhook verifieras över exakt rå body med HMAC-SHA256, timestampfönster, constant-time comparison, känt event, session/state-bindning och idempotens.
- Webhook kan aldrig ensam sätta signerare eller case till slutförd.

### Bevis och verifiering

- TIC collect response, XML-signatur och OCSP sparas som separata append-only artifacts.
- Java-valideringstjänst har XXE/externa entiteter avstängda, exakt en XML-signatur, endast interna och unika referenser, XML-DSig-kryptografikontroll, X.509-identitetsutläsning, signed visible/non-visible payload-matchning, personnummermatchning och parsable OCSP.
- Dokumenthashar jämförs mot exakt lagrade canonical PDF/A-bytes.
- Signerare blir `signed` först efter verifierat bevis, artifacts, rapport och audit.
- Per-signer- och casepaket skapas deterministiskt med manifest, checksums och package SHA-256.
- Offlineverifieraren avvisar modifierade ZIP-bytes, fel CRC, path traversal, dubbletter, oväntade filer och checksum-/manifestavvikelse.

### E-post

- Domänlagret använder `EmailProvider` och importerar inte Resend-typer.
- `ResendEmailProvider`, `DevelopmentEmailProvider` och SMTP-gränssnitt/adapter finns.
- Development-provider blockeras i produktion.
- Outbox/job, stabil idempotency key, provider message ID, retry/permanent failure, bounce/complaint-suppression och duplicate webhook hanteras.
- Resend/Svix-webhook verifieras över raw body.
- Mallar är svenska, text + HTML, utan personnummer, PDF-bilagor eller evidensbilagor.
- `EMAIL_DATA_RESIDENCY_APPROVED=false` är blockerande readiness för Resend.

### API, portaler och SDK

- Tenant-API har explicit signerarmodell, upload complete, signer patch, send/remind/cancel och evidens-/valideringsåtkomst.
- Publikt signer-API har invitation, opened, dokumentstream, BankID start/status/extend/cancel och decline.
- Publik verifiering ger endast icke-känslig sammanfattning eller verifierar uppladdat paket.
- Tenantportalen stöder fler-PDF, pipeline-status, signerare, strikt personnummer/undantag, signeringsgrupper, förhandsvisning, skickande och uppföljning.
- Signerportalen visar exakta handlingar, full hash i avancerad vy, exakt BankID-text, review-checkbox, QR/samma enhet, status, extend och decline.
- Verifieringsportalen visar resultat utan personnummer.
- OpenAPI och TypeScript-, C#- och Java-SDK är synkade på `2026-08-03.1`.

### Workers och statusmaskin

Verkliga handlers finns för:

- `DOCUMENT_SCAN`
- `DOCUMENT_CANONICALIZE`
- `IDENTITY_STATUS_POLL`
- `SIGNATURE_CREATE`
- `TIC_EVIDENCE_COLLECT`
- `SIGNATURE_VALIDATE`
- `EVIDENCE_PACKAGE_BUILD`
- `EMAIL_SEND`
- `APPLICATION_NOTIFICATION`
- `REMINDER_SEND`
- `CASE_EXPIRE`

Handlers använder tenant transaction context, payloadvalidering, leases/heartbeat, idempotens, retryable/permanent-fel, dead-letter och audit/outbox. Statusar härleds genom domänövergångar och kan inte fritt sättas till `signed`/`completed` från UI.

## 3. Migrationer

Ingen historisk migration har ändrats för BankID-fasen. Ny additiv migration:

```text
migrations/data/0013_bankid_production_foundation.sql
```

Den täcker bland annat:

- signing intents och ordered intent documents,
- identifier binding mode/undantag,
- TIC identity artifacts och verifieringsrapporter,
- document processor reports,
- evidenspaket och package files/checksums,
- provider webhook-idempotens,
- email provider message/event storage,
- statusconstraints och index,
- forced RLS och tenant-composite foreign keys,
- immutable/append-only guards.

`migrations/data/verify.sql` kontrollerar RLS/forced RLS, tenantlösa rows, FK-integritet, aktiva intents, låsta dokumenthashar, strikt identifiering, undantagsaudit och terminalt beviskrav.

## 4. Säkerhetsbeslut

- TIC- och Resend-hemligheter finns endast som secret references/runtime secrets.
- Personnummer, e-post, invitation tokens, TIC collect och identitetsbevis klassas som känsliga.
- Invitation tokens har minst 256 bit entropy och endast hash lagras.
- Dokumentbuckets är privata; signed URLs är kortlivade och responses är `private, no-store`.
- XML verifieras i isolerad Java-tjänst, inte med en ad hoc-parser i API-processen.
- Dokumentverktyg körs utanför API-processen med timeout, output-/storleksgränser och fail-closed resultat.
- TIC och e-post har kill switches och tenant rollout-gates.
- Resend får inte markeras upphandlingsmässigt godkänd innan skriftligt dataresidensbeslut eller providerbyte.

## 5. Verifieringar

Detaljer finns i `VERIFICATION_RESULTS_BANKID_PRODUCTION.txt`.

Passerade lokalt:

- TypeScript-kompilering.
- Bygg av fem portaler.
- 28 enhetstester.
- Tenant-API/onboarding-integrationstester.
- Säkerhetstester.
- SQL-migrationsstatisk verifiering.
- Repository-, provenance- och secret scan.
- SDK-synk.
- Java boundary services och verifierarens self-test.
- Deterministisk evidence fixture och modifieringsavslag.

Inte körbara i denna miljö:

- `npm ci`: intern npm-spegel returnerar 404 för den låsta artefakten `postgres@3.4.7`.
- Därför kan `npm run verify` från ren lokal installation inte passera här.
- Docker, `psql`, qpdf och ClamAV-binaries saknas.
- E2E och accessibility har ingen konfigurerad browser-/serviceenvironment och stoppar explicit utan falskt grönt resultat.
- TIC/Resend live-verifiering saknar externa credentials, verifierade URL:er och godkända testpersoner.

## 6. Externa releaseblockerare

Följande måste lösas innan extern tenant aktiveras:

1. Godkänd npm registry måste kunna leverera `postgres@3.4.7`, följt av ren `npm ci && npm run verify`.
2. Tom-databas- och uppgraderingsrepetition måste köras med verklig PostgreSQL/psql.
3. ClamAV, qpdf, Gotenberg, vald veraPDF-service och valideringstjänst måste health-testas i isolerat nät.
4. Exakt veraPDF-image/build och digest måste beslutas och dokumenteras.
5. Alla produktionsimages måste låsas till registry digest, SBOM-skannas och licensgranskas.
6. Vercel wildcard/TLS, systemdomäner och trusted proxy måste verifieras live.
7. Supabase-buckets, RLS, service role och krypteringsnycklar måste konfigureras i rätt region/projekt.
8. TIC-konto, produktionssignering, callback, webhook, API key och webhook secret måste godkännas.
9. Resend sender DNS/webhook måste verifieras; skriftligt dataresidensgodkännande krävs eller annan provider väljs.
10. QR och samma-enhet, XML/OCSP och negativa fall måste köras i TIC produktion med intern tenant och samtyckande testpersoner.
11. WCAG 2.2 AA, browser-E2E, backup/restore och runbooks måste verifieras i staging/produktion.

## 7. Exakt deployordning

1. **Godkänn tredjepart**: veraPDF-distribution, image tags/digests, SBOM, licenser, DPA/underbiträden och retention.
2. **Skapa secrets** i godkänd secret manager; lägg aldrig resolved values i Git eller databaskolumner.
3. **Provisionera control- och data-databaser** med separata credentials och nätverksregler.
4. **Kör control-migrationer** `0001`–`0010` i stigande ordning.
5. **Kör data-migrationer** `0001`–`0013` i stigande ordning.
6. **Kör DB-verifiering** och tenant-isolering på både tom och uppgraderad databas.
7. **Skapa privata Supabase Storage-buckets** och verifiera att inga publika policies finns.
8. **Deploya interna tjänster**: ClamAV, Gotenberg, veraPDF och validation-service utan fri egress; kör `npm run verify:container-health` från worker-nätet.
9. **Deploya API och workers** med `TIC_BANKID_ENABLED=false`, `EMAIL_GLOBAL_KILL_SWITCH=true` och extern tenant-rollout avstängd.
10. **Konfigurera Vercel/ingress/DNS** och verifiera wildcard, systemdomäner, HSTS, Host-rejection och trusted forwarded IP/host.
11. **Konfigurera TIC** med fasta callback/webhook-URL:er och secrets; verifiera HMAC-fixture och live endpoint.
12. **Konfigurera vald e-postprovider**; för Resend verifieras `notify.kommunsign.se`, Svix-secret och compliancebeslut.
13. **Kör readiness** och lämna varje blocker röd tills faktisk evidens finns.
14. **Aktivera intern tenant** och allowlistade testpersoner; slå av email kill switch endast för intern tenant.
15. **Kör positivt och negativt produktionstest**, verifiera package hash offline och dokumentera test-ID utan personuppgifter i Git.
16. **Sätt acceptance/readiness-flaggor** först efter evidens; aktivera TIC tenant rollout och därefter externa tenants stegvis.

## 8. Databasordning

```bash
export CONTROL_DATABASE_URL='postgresql://.../kommunsign_control'
export DATA_DATABASE_URL='postgresql://.../kommunsign_data'

# Kör control 0001–0010, därefter data 0001–0013.
npm run db:migrate

# Kör control onboarding-kontroller, data verify.sql och tenant isolation.
npm run db:verify
```

För en uppgraderad miljö används samma kommando; migrationerna är additiva och numeriskt ordnade. Ta verifierad backup före körning. Ändra inte historiska migrationsfiler.

## 9. Vercel-konfiguration

- Lägg `kommunsign.se`/`www` på public website-projektet och konfigurera 301 för `www`.
- Lägg `apply`, `admin`, `app`, `auth`, `sign`, `verify`, `api`, `hooks`, `docs`, `status`, `support` på avsedda projekt/tjänster.
- Lägg `*.kommunsign.se` på tenant gateway-projektet och verifiera automatic TLS.
- `notify.kommunsign.se` används endast som sändande e-postdomän.
- Lägg runtime secrets som encrypted environment variables per miljö; frontend får endast `NEXT_PUBLIC_*` utan hemligheter.
- Sätt `TRUST_PROXY=true`, `TRUSTED_PROXY_PROVIDER=vercel` och `REQUIRE_VERIFIED_FORWARDED_HOST=true`.
- Verifiera callback-/webhook-hostar mot allowlist innan readiness-flaggor ändras.

## 10. Supabase-konfiguration

Skapa privata buckets:

```text
document-quarantine
original-documents
canonical-documents
signed-documents
validation-reports
identity-evidence
evidence-packages
```

- Ingen bucket får vara public.
- Service role används endast server-side.
- Konfigurera `SUPABASE_DATA_PROJECT_URL`, `SUPABASE_DATA_SERVICE_ROLE_KEY` och bucketvariabler via secret manager.
- Verifiera signed URL TTL på högst 300 sekunder.
- Kör migrationer med separat DB-credential, därefter `migrations/data/verify.sql` och `tests/sql/tenant-isolation.sql`.

## 11. TIC-konfiguration

- Bekräfta att kontot har BankID signing i produktion.
- Registrera exakt:
  - callback `https://sign.kommunsign.se/bankid/callback`
  - webhook `https://hooks.kommunsign.se/v1/provider-webhooks/tic/bankid`
- Lägg `TIC_API_KEY` och `TIC_WEBHOOK_SECRET` som resolved runtime secrets från respektive secret reference.
- Behåll `TIC_BANKID_ENABLED=false` tills intern smoke test.
- Konfigurera intern tenant, testsubject allowlist, rate limits och kill switch.
- Kör QR och samma-enhet separat samt negativa tester för personnummer, HMAC, dokumenthash och OCSP.

## 12. Resend-konfiguration

- Verifiera `notify.kommunsign.se` med SPF/DKIM enligt providerinstruktion.
- Skapa API key och Svix webhook secret med minsta behörighet.
- Registrera webhook `https://hooks.kommunsign.se/v1/provider-webhooks/resend`.
- Sätt `EMAIL_PROVIDER=resend`; håll tracking avstängd.
- Kontrollera bounce/complaint och suppression med testad idempotens.
- Låt `EMAIL_DATA_RESIDENCY_APPROVED=false` tills skriftligt beslut finns. Alternativt välj annan adapter utan ändring i case/signer/reminder/template-domänen.

## 13. Synkning av changed-only ZIP

ZIP-filen innehåller repositoryrelativa paths utan extra toppmapp:

```bash
ZIP="$HOME/Downloads/kommunsign-bankid-production-changed-files.zip"
TARGET="/Users/hekmath/Projects/kommunsign"
TMP="$(mktemp -d)"

unzip -q "$ZIP" -d "$TMP"
rsync -av --itemize-changes "$TMP"/ "$TARGET"/
rm -rf "$TMP"

cd "$TARGET"
npm ci
npm run verify
```

Använd inte `--delete` med en changed-only ZIP. Kontrollera `CHANGED_FILES_BANKID_PRODUCTION.txt` före commit.

## 14. Releasebeslut

Koden är en genomförd produktionsgrund med fail-closed gränser, verkliga adapters/handlers och verifierbara artefakter. Den är **inte externt live-verifierad** i denna körmiljö. Extern aktivering är korrekt blockerad tills punkterna i `PRODUCTION_CHECKLIST.md` och acceptanceprotokollet har faktisk miljöevidens.
