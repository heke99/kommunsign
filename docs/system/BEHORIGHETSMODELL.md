# Behörighetsmodell — Kommunsign

Krav 2059: systemdokumentationen ska beskriva hur behörighetskontrollen är
uppbyggd. Krav 2081 och 3521 (minsta möjliga behörighet) redovisas här.

Senast uppdaterad: 2026-08-07.

## Tre lager som alla måste hålla

Behörighet avgörs inte på ett ställe. Det är avsiktligt: varje lager skyddar mot
ett fel de andra inte fångar.

**1. Tenantkontext.** Vilken organisation frågan gäller härleds ur verifierad
domän, medlemskap, API-klient eller deployment. Aldrig ur ett fritt requestfält
(AGENTS.md regel 1). Ett fält en klient kontrollerar är inte en identitet.

**2. Row level security.** Varje tenantbunden tabell har RLS med `FORCE`, så att
även tabellägaren omfattas. Utan `FORCE` går en privilegierad anslutning tyst
förbi isoleringen. Policyn jämför `tenant_id` mot `app.current_tenant_id()`,
som sätts per transaktion.

**3. Applikationsauktorisering.** `packages/authorization` avgör om aktören har
rätt behörighet för operationen. RLS svarar på "får den här anslutningen se
raden", inte på "får den här användaren utföra den här åtgärden".

RLS ensamt är inte tillräckligt. En användare med giltig tenantkontext ser sin
egen organisations data — men får inte därmed gallra den.

## Aktörstyper

| Typ | Härkomst | Omfattning |
| --- | --- | --- |
| Plattformssuperadmin | `control.platform_role_assignments` | Plattformsdrift. Får aldrig gallra eller läsa skyddade personuppgifter i kundens ställe |
| Organisationsadministratör | Medlemskap med adminroll | Hela sin egen tenant |
| Handläggare | Medlemskap med rolltilldelning | Ärenden inom sin enhet |
| Undertecknare | Engångsbunden inbjudan | Endast det egna signeringsuppdraget |
| API-klient | `app.api_clients` med scopes | Endast beviljade scopes, endast sin tenant |
| SCIM-klient | `app.scim_provisioning_clients` | Endast provisionering, endast roller inom `assignable_roles` |
| Worker | Deployment-identitet | Endast jobb, med tenantkontext satt per jobb |

## Roller och rättigheter

Roller ligger i `app.roles` per tenant med rättigheter som JSON. Tilldelning
sker via `app.role_assignments` mot ett medlemskap, valfritt avgränsat till en
enhet. Rättigheter är verb på resurs, till exempel `case:create`,
`case:cancel`, `retention:execute`, `privacy:handle`, `archive:export`.

Två gränser är hårdkodade i beslutslagren snarare än konfigurerbara, eftersom
de skyddar kunden mot leverantören:

- **Gallring** kräver `retention:execute` *och* att aktören inte är
  plattformspersonal, *och* att godkännaren inte är den som begärde (krav 2069).
- **Skyddade personuppgifter** kräver ett tidsbegränsat, motiverat samtycke per
  person utfärdat av kunden. Stående supportåtkomst finns inte (krav 2028).

## Automatisk tilldelning

Vid federerad inloggning och vid SCIM-provisionering härleds roller ur
gruppmedlemskap genom en explicit mappning. Mappningen är deny-by-default i tre
avseenden: omappad grupp ger ingenting, användare utan mappad grupp avvisas i
stället för att få en defaultroll, och en mappning som pekar på en roll utanför
klientens `assignableRoles` är ett fel i stället för en tyst tilldelning. En
katalogadministratör som lägger till någon i en grupp kan därmed inte eskalera
bortom vad integrationen scopats för.

## Livscykel och spårbarhet

Konton skapas, uppdateras, avaktiveras och avetableras via SCIM eller av en
organisationsadministratör. Avaktivering är inte radering: en användare med
historik behålls avaktiverad, eftersom borttagen rad skulle föräldralösa de
signaturer och auditposter som namnger personen.

Varje förändring loggas i `app.scim_provisioning_events` och i auditloggen med
aktör, tenant, operation, mål och tidpunkt (krav 3518). Auditloggen är
hashkedjad, så manipulation är detekterbar.

## Minsta möjliga behörighet (krav 3521)

- API-klienter får endast de scopes integrationen behöver, och scopes
  kontrolleras per endpoint.
- SCIM-klienter kan inte tilldela roller utanför sin `assignable_roles`.
- Leverantörens personal har inte stående åtkomst till kunddata; åtkomst är
  tidsbegränsad, motiverad och loggad.
- Break glass-åtkomst är separat, tidsbegränsad och larmar vid användning.
