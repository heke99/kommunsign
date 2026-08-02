# KommunSign – leveransrapport för produktionsonboarding och domänarkitektur

Datum: 2026-08-02  
Version: 0.2.0  
Arbetsbranch: `fix/kommunsign-production-onboarding`

## Sammanfattning

Denna leverans vidareutvecklar befintligt repository additivt. Den ersätter inte fungerande signerings-, onboarding- eller säkerhetskod med scaffolding. Fokus är verklig PostgreSQL-runtime, serverhärledd tenantkontext, standard- och custom domains, idempotent provisioning, hostbundna auth-sessioner, strikt readiness och server-side storage/kö/kryptering.

Repositoryts kvalitetsgrind `npm run verify` passerar fullt. Liveverifiering mot Supabase, Vercel, DNS och TLS har inte utförts eftersom produktionshemligheter och externa konton inte fanns i leveransen.

## Implementerat

- Additiv kontrollplansmodell för dataplan, tenantmiljöer, reserverade sluggar, standarddomäner, custom domains, verifieringsutmaningar, provideroperationer, certifikat, routing, brandinghistorik och primärdomänhistorik.
- Additiv dataplansmodell för beständiga jobb, idempotens och opaque signer references.
- Produktionsruntime som använder konkreta PostgreSQL-repositories och aldrig faller tillbaka till in-memory i produktion.
- `withTenantTransaction`-baserad tenantkontext med lokala PostgreSQL-inställningar.
- Fail-closed hostname resolver med normalisering, IDN-hantering, active-domain-krav, kort cache och invalidation.
- Reserverade sluggar, kollisionsskydd och permanent standarddomän `{slug}.kommunsign.se`.
- Custom-domain state machine, DNS challenge, Vercel-provideradapter, certifikat-/health-evidens, tvåpersonsgodkänd primärdomän och säker removal.
- Hostbundna, kortlivade och single-use auth codes samt host-only sessions.
- AES-256-GCM-kryptering och HMAC-baserade blindindex för känsliga kontrollplansvärden.
- Server-side Supabase Storage-adapter med privata bucketar, tenantbundna objektvägar och signerade uppladdnings-URL:er.
- PostgreSQL-baserad beständig kö och worker lease/retry/dead-letter.
- Återupptagningsbar provisioning saga som reserverar slug, väljer dataplan, skapar tenantmiljö, standarddomän, namespaces, policies, roller, branding-/authutkast och första admininbjudan.
- Readinesskoder för DNS, TLS, routing, auth callback, signer flow, takeover-skydd och primärdomän.
- Arkitektur-, säkerhets-, deployment-, readiness- och incidentdokumentation.

## Verifierat

Kört från repositoryroten:

```text
npm run verify
```

Resultat:

- TypeScript 5.8.3: grön
- Portalbygge: 5 portaler
- Repositorykontroll: grön
- SQL-migrationskontroll: grön
- Provenance: grön
- SDK-synk: grön
- Secretscan: grön
- Java/Freja self-test: grön
- Enhetstester: 26 passerade
- Integration: tenantkontext och onboarding/provisioning passerade
- Säkerhet: branding, SSRF, domäner, uploads, invitations och OIDC passerade
- Extra SQL-anropsscan: inga parametriserade flersatsfrågor i produktionsadaptrarna

## Säkerhetskorrigeringar

- Tenant väljs inte från body, query, localStorage eller osignerad header.
- Okänd eller inaktiv hostname avvisas; ingen fallback till godtycklig tenant.
- Applicant-email lagras inte i klartext i onboardingens idempotenscache.
- Provisioning återanvänder stabilt tenant-ID och sparar varje slutfört steg separat.
- Auth code kan inte återanvändas och är bunden till ursprunglig hostname.
- Sessionscookies använder `__Host-`-modell utan Domain-attribut.
- Custom domain kan inte bli primär utan verifierings-, certifikat-, routing- och godkännandeevidens.
- Production runtime blockerar saknad konfiguration i stället för att fabricera lyckade resultat.
- Workerjobb utan produktionshandler misslyckas explicit och går till retry/dead-letter.

## Externa blockerare och kvarvarande arbete

1. Kontroll- och datamigrationerna är inte livekörda mot kundens Supabase-projekt.
2. Vercelprojekt, wildcarddomän, kunddomän, DNS, TLS och takeover-skydd är inte liveverifierade.
3. Full OIDC/SAML-broker med provider metadata, signaturvalidering, callbacks och SCIM är inte komplett end-to-end.
4. Dedicated/customer-hosted dataplan kräver hemlighetsresolver och dynamisk anslutningspool per `data_plane_id`.
5. Endast workerjobbet `TENANT_PROVISION` har komplett produktionshandler. Övriga jobbtyper avvisas explicit.
6. Tenant gateway- och auth-brokerpaketen saknar ännu separata färdiga HTTP-deployments för Vercel/container.
7. Platform-admin och tenant-onboarding UI täcker inte hela custom-domain- och readinessarbetsflödet.
8. Supabase Storage-adaptern är statiskt verifierad men inte liveverifierad med service role mot kundens projekt.
9. Sandboxens interna npm-registry saknade den låsta TypeScript-versionen. Verifieringen kördes med redan installerad TypeScript 5.8.3; normalt `npm ci` ska köras i kundens miljö.

## Slutsats

Kärnan för domändriven tenantupplösning, PostgreSQL-runtime och idempotent provisioning är implementerad och lokalt verifierad. KommunSign ska inte markeras som fullständigt produktionsklart förrän samtliga externa blockerare ovan är stängda och live-readiness är grön.
