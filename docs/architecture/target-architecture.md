# KommunSign – målarkitektur

## Principer

KommunSign är en gemensam multi-tenantprodukt utan kundunika kodforkar. Skillnader hanteras genom tenantkonfiguration, policies, feature flags, branding, providers, connectors och data-plane-val. Ansökningsdata tillhör control plane. Verksamhetsdata, dokument och signaturbevis tillhör tenantens data plane.

## Exponerade applikationer

| Applikation | Primär domän | Säkerhetskontext |
|---|---|---|
| Public website | `kommunsign.se` | publik, inga tenantoperationer |
| Onboarding portal | `apply.kommunsign.se` | verifierad sökandesession bunden till ansökan |
| Platform admin | `admin.kommunsign.se` | plattforms-OIDC/WebAuthn och plattforms-RBAC |
| Tenant portal | `app.kommunsign.se` eller tenantdomän | verifierad tenantmedlem härledd server-side |
| Signer portal | `sign.kommunsign.se` | signerare-/ärende-/tenantbunden engångsinbjudan |
| Verification portal | `verify.kommunsign.se` | isolerad temporär dokumentbehandling |
| API | `api.kommunsign.se` | applicant, platform eller tenant auth per route group |
| Workers | privat nät | durable lease och tjänsteidentitet |

## Control plane

Control plane lagrar ansökningar och revisioner, plattformsidentiteter, reviews, beslut, tenants, miljöer, deployment targets, domäner, subscriptions, providers, certifikatstatus, provisioning, checklistor, readiness, aktiveringar och plattformsaudit. Interna reviewuppgifter och sökandesynlig information separeras både logiskt och behörighetsmässigt.

## Tenant data plane

Varje tenantoperation körs i `withTenantTransaction` med serverhärledd `tenant_id`, `actor_id`, `request_id` och authmetod. Shared SaaS använder tvingad RLS och composite tenantnycklar. Dedicated och customer-hosted använder samma kontrakt och migrationsnivå men separata anslutningar och driftmål.

## Runtimeflöde

```text
HTTP/TLS
  -> route classification
     -> applicant session | platform identity | tenant identity
        -> authorization
           -> idempotency + canonical payload hash + optimistic concurrency
              -> control/data transaction
                 -> append-only audit + durable job
                    -> worker/provider
                       -> verified result + readiness/evidence
```

Ingen route får härleda tenant från body, query, osignerad header eller frontendstate. En utvecklingsheader får endast finnas bakom en explicit utvecklingsruntime som är blockerad i produktion.

## Onboarding och aktivering

```text
Ansökan -> e-postverifiering -> submit -> reviews/komplettering -> beslut
-> idempotent provisioning -> tenant:onboarding -> checklista/readiness
-> acceptanstest -> aktiveringsbegäran -> separat godkännare -> active
```

Beslut, provisioning och aktivering är tre separata domänhändelser. Ingen av dem får implicit utföra nästa steg.

## Dokument och signering

Dokument går via objektlagring, quarantine, antivirus, PDF-sandbox och canonicalisering innan immutable version låses. Providers får endast påverka status efter serververifierad collect, kryptografisk kontroll och policykontroll. PAdES och DSS körs som Java 21-tjänster. Evidence package skapas av verifierade artefakter och ett hashmanifest.

## Produktionskomponenter

- PostgreSQL control plane
- PostgreSQL tenant data plane(s)
- S3-kompatibel objektlagring
- Redis/queue eller motsvarande durable broker
- API och workers
- identity service
- document processing service
- sign service
- validation service
- notification/webhook/archive adapters
- KMS/HSM, certifikat och secrets manager
- OpenTelemetry collector, metrics, logs och traces

## Fail-closed-regler

- In-memoryrepository är förbjudet i produktion.
- Testprovider och mjuk testnyckel blockerar produktion.
- Saknad provider ger blockerande readiness, inte simulerad framgång.
- Sökande kan aldrig se interna anteckningar.
- Tenant blir aldrig aktiv utan full readiness, acceptanstest och tvåpersonsgodkännande.
- Signeringsärende blir aldrig completed utan verifierade signaturartefakter och validatorresultat.
