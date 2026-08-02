# Kravstatus – produktionsonboarding och domäner

| Kravområde | Status | Evidens / kommentar |
|---|---|---|
| Kanonisk produktrot `kommunsign.se` | Implementerad i konfiguration och publik webb | Live-DNS ej verifierad |
| `/ansok` till ansökningsportal | Implementerad | Publik sida länkar till `apply.kommunsign.se` |
| Separat control/data PostgreSQL | Implementerad i runtime och migrationer | Liveprojekt ej verifierade |
| In-memory förbjudet i produktion | Klar | Produktionsbootstrap fail-closed och testad |
| Unik standarddomän per tenant | Klar i modell och provisioning | Wildcard-DNS/TLS ej liveverifierad |
| Server-side hostname → tenant UUID | Klar | Resolver, aktiv domänkontroll och cachetest |
| Custom-domain request/lifecycle | Kärna klar | Admin-UI och liveproviderflöde kvar |
| DNS challenge | Klar i kod/datamodell | Verklig DNS ej verifierad |
| TLS-/certifikatstatus | Klar i modell/provider | Verkligt certifikat ej verifierat |
| Primär custom domain + fallback | Klar i modell/repository | End-to-end länkflöde ej liveverifierat |
| Tenant transaction context | Klar | Integrationstest passerar |
| PostgreSQL production repositories | Klar för implementerade API-flöden | Dedicated routing kvar |
| Supabase Storage server-side | Adapter klar | Liveprojekt ej verifierat |
| Beständig PostgreSQL-kö | Klar | Endast provisioninghandler komplett |
| Återupptagningsbar provisioning | Klar | Integrationstest passerar |
| Host-only sessions | Kärna klar | Full extern IdP callback kvar |
| OIDC/SAML broker | Delvis | State/code/sessiongräns klar; komplett providerflöde kvar |
| Same-origin gateway/API | Kärnresolver klar | Separat deploybar gateway/BFF kvar |
| Strikt CORS/origin | Befintlig + domänmodell klar | Live custom-origin-test kvar |
| Versionerad branding | Datamodell klar | Full admin-UI/kontrastflöde kvar |
| Server-side URL generation | Domänrepository och primary-domain-regler klara | Full notifieringsintegration kvar |
| Readiness blockerar fel | Klar i kärna | Aktiva externa probes behöver livekonfiguration |
| Tenantisolering | Klar för delad databasmodell | Live Supabase/PostgreSQL-test kvar |
| Vercelprojektdesign | Manifest/dokumentation klar | Projekt och domäner ej skapade |
| Dokumentation/runbooks | Klar | Ska uppdateras efter liveverifiering |
| Full Definition of Done | Inte uppnådd | Blockeras av liveinfra, auth, gateway, UI och workerhandlers |
