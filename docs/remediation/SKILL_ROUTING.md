# Skill routing

Status per installerad skill i `skills-lock.json` (37 st) för
Kommunsign production remediation.

Statusvärden:

- **ACTIVE** — använd i denna remediation.
- **CONDITIONAL** — relevant först när en viss förutsättning finns.
- **NOT_APPLICABLE** — teknikstacken eller uppgiften matchar inte.

En ärlig anmärkning: i den föregående sessionen arbetade jag direkt mot
kodbasen utan att läsa in skills. Denna fil upprättar routingen, och
kolumnen *Använd hittills* säger vad som faktiskt tillämpats, inte vad som
borde ha tillämpats.

## ACTIVE

| Skill | Motivering | Använd hittills |
| --- | --- | --- |
| `security-and-hardening` | Kärnan i remediationen: fail-closed identitet, signering och authorization. | Ja — identity-registry och PAdES-grinden är byggda fail-closed. |
| `secrets-management` | De tre läckta produktionsnycklarna och den hårdare scannern. | Ja — scan-secrets utökad, rotationsrunbook skriven. |
| `security-threat-model` | Hotmodell krävs av krav 3512 och masterprompten. | Nej — kvarstår. |
| `threat-model-analyst` | STRIDE-genomgång av signerings- och tenantgränser. | Nej — kvarstår. |
| `test-driven-development` | PASS kräver verifierbar evidens; varje ny modul behöver negativa tester. | Ja — retention, identity-registry och PAdES har tester före statusändring. |
| `supabase-postgres-best-practices` | RLS, index, migrationer i CONTROL och DATA. | Delvis — schemat lästes före ändring, inga migrationer ändrade. |
| `supabase` | Två Supabase-projekt, storage policies, exposed schemas. | Delvis — schemainventering. |
| `sql-optimization-patterns` | Prioritet 13: databasprestanda och index. | Nej — kvarstår. |
| `api-and-interface-design` | Provider-neutrala interface (IdentityProvider, KeyProvider). | Ja — identity-registry designad som metod-till-provider-upplösning. |
| `api-design-principles` | Versionerat /v1-API, krav 2073–2076. | Delvis. |
| `openapi-spec-generation` | `docs/api/openapi.yaml` måste följa nya endpoints. | Nej — inga nya endpoints ännu. |
| `auth-implementation-patterns` | SAML/OIDC workforce-IdP, SCIM, krav 2079–2085. | Nej — kvarstår. |
| `error-handling-patterns` | Konsekvent felkontrakt utan interna detaljer. | Ja — typade felkoder i retention, identity och PAdES. |
| `observability-and-instrumentation` | Prioritet 16 och supportnivåerna i Bilaga 3. | Nej — kvarstår. |
| `code-review-and-quality` | Granskning före varje commit. | Delvis. |
| `find-bugs` | Aktiv buggjakt i signerings- och isoleringsvägar. | Nej — kvarstår. |
| `documentation-and-adrs` | Krav 2057–2061 kräver svensk systemdokumentation. | Delvis — readiness, SLA och runbook skrivna. |
| `incremental-implementation` | Små logiska commits enligt instruktionen. | Ja. |
| `debugging-and-error-recovery` | Rotorsaksanalys vid testfel. | Ja — felaktig testförväntan i identity-registry rättades mot koden. |
| `source-driven-development` | ETSI, DIGG, PUB-avtalet ska styra, inte antaganden. | Ja — PUB §7.5 och Bilaga 3 lästes ur källdokumenten. |
| `doubt-driven-development` | Signeringsbevis och tenantisolering tål inte gissningar. | Ja — PAdES-nivå härleds ur evidens i stället för att antas. |
| `performance-optimization` | Prioritet 12–14. | Nej — kvarstår. |
| `ci-cd-and-automation` | Kvalitetsgrindar i `npm run verify`. | Ja — `verify:requirements` tillagd. |
| `sast-configuration` | Krav 2045, 3538 om sårbarhetshantering. | Nej — kvarstår. |
| `refactor` | Filstorleksregeln och duplicerad logik. | Nej — inga filer nära gränsen. |
| `code-simplifier` | Löpande. | Nej. |
| `quality-playbook` | Slutlig kvalitetsgenomgång före GO/NO-GO. | Nej — kvarstår. |
| `acquire-codebase-knowledge` | Kartläggning av CONTROL/DATA och tjänstegränser. | Ja — schema- och ruttinventering. |

## CONDITIONAL

| Skill | Villkor |
| --- | --- |
| `e2e-testing-patterns` | Krävs för krav 2008–2010 och 2014 (Edge, Chrome, Safari, responsivt). Förutsätter att Playwright införs, vilket är ett beroendebeslut mot repots nollberoendeprofil. |
| `web-design-guidelines` | Aktiveras vid WCAG 2.2 AA-arbetet (krav 2015, prioritet 15). |
| `deployment-pipeline-design` | Aktiveras när staging-miljö införs (krav 2046, 3531). |
| `skill-scanner` | Endast om nya skills installeras. |

## NOT_APPLICABLE

| Skill | Motivering |
| --- | --- |
| `nextjs-app-router-patterns` | Portalerna är statisk HTML/CSS/JS byggd av `scripts/build-portals.mjs`. Ingen Next.js finns i repot. |
| `vercel-react-best-practices` | Ingen React i kodbasen. Vercel används enbart för statisk hosting. |
| `nodejs-backend-patterns` | Bygger på Express/Fastify. API:t använder Web Fetch API-handlers utan ramverk, och repot har medvetet noll runtime-beroenden utöver `postgres`. |

## Beroendebeslut som blockerar flera skills

Repot har i dag **noll externa Java-beroenden** (`scripts/build-java.sh` är
rent `javac`) och ett enda Node-runtimeberoende (`postgres`). Det är ett
medvetet supply chain-val som provenance-grinden upprätthåller.

Tre arbetsströmmar kan inte slutföras utan att det valet omprövas:

- **EU DSS för PAdES-produktion och -validering** — kräver ett stort
  Maven-träd.
- **veraPDF för PDF/A-validering** (krav 2013, F013).
- **Playwright för webbläsar- och tillgänglighetstester** (krav 2008–2010, 2015).

Detta är ett arkitekturbeslut för ägaren, inte något jag ändrar ensidigt.
Se `FINAL_REMEDIATION_REPORT.md`.
