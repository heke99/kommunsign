# Custom domain lifecycle

Tillstånd: `requested → dns_challenge_created → dns_verification_pending → dns_verified → routing_pending → certificate_pending → active`, med avvikelserna `renewal_required`, `suspended`, `removed`, `failed`.

`domain-management-repository.ts` begär domän från provider, skapar krypterat challenge, verifierar DNS, ansluter routing, läser certifikatstatus, kör tenantbindande health check och kan därefter aktivera domänen. En domän blir inte primär genom vanlig update. Funktionen `control.set_primary_tenant_domain` kräver två olika aktörer och skriver historik/routingevent.

Standarddomänen tas inte bort vid custom domain. Borttagning av primärdomän blockeras.

Readiness kräver DNS, certifikat, routing, auth callback, same-origin API, signerflöde och takeover-skydd. Avsaknad av aktiv evidens blockerar aktivering.
