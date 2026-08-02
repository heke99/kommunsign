# AGENTS.md

## Icke förhandlingsbara regler

1. Tenant får aldrig tas från ett fritt requestfält.
2. Alla domänfrågor ska bära `tenant_id` och composite foreign keys där relationen korsar tabeller.
3. Klienter får aldrig sätta `signed`, `completed`, `validated` eller `archived`.
4. Browsercallback är navigering, aldrig signeringsbevis.
5. PAdES får endast registreras efter kryptografisk signering och DSS/likvärdig validering.
6. Personnummer får inte loggas, ligga i URL eller vara primärnyckel.
7. Providerhemligheter hämtas via secret references; de lagras inte i klartext i databasen.
8. Långvariga jobb måste vara persistenta, idempotenta och återupptagningsbara.
9. Donorkod får inte importeras före dokumenterat tillstånd, commit-pin och manifestpost.
10. Ingen produktionsväg får använda testprovider.

## Definition för en säker förändring

En förändring är inte klar förrän:

- tenantisolering är testad,
- statusövergångar är serverstyrda,
- migrationspåverkan och backfill är dokumenterade,
- audit/outbox skapas i samma transaktion som affärshändelsen,
- loggar inte innehåller känsliga payloads,
- negativa tester finns för den nya attackytan.
