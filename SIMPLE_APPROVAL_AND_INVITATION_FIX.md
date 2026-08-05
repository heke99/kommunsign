# Förenklat godkännande och inbjudan

## Grundfelet

API-felet `REQUIRED_REVIEWS_NOT_PASSED` kom från `decideApplication()` i produktionsrepositoryt. Koden krävde att de senaste granskningarna för exakt fyra områden – `commercial`, `legal`, `security` och `technical` – alla hade resultatet `passed` innan en ansökan fick godkännas.

Administrationsgränssnittet visade samtidigt en vanlig knapp med texten **Godkänn ansökan** utan att förklara den dolda fyrgranskningsregeln. Därför såg flödet trasigt ut.

## Nytt flöde

1. Superadmin öppnar ansökan.
2. Superadmin anger motivering och klickar **Godkänn och skapa organisation**.
3. Ansökan godkänns direkt.
4. Provisioneringen startas automatiskt.
5. När organisationen är färdigskapad kan huvudadministratören bjudas in.
6. Aktiveringslänken leder normalt till den gemensamma portalen `app.kommunsign.se`.

Specialistgranskningar finns kvar som ett valfritt avancerat steg. Om en registrerad granskning markerats med hög eller kritisk risk krävs fortfarande en separat godkännare.

## Domänförklaring

Domän betyder webbadressen som användaren öppnar, inte e-postdomänen. Vanliga Kommunsign-kunder behöver inte ange någon egen domän. Den gemensamma adressen `app.kommunsign.se` används som säker reserv och fungerar för inbjudan och inloggning.

Kundspecifika adresser som `kommun.kommunsign.se` eller `signering.kommun.se` är valfria tillägg och ska inte blockera `shared_saas`.

## Databasmigration

Kör den nya kontrollplansmigrationen:

```bash
npm run db:migrate
npm run db:verify
```

Migration: `migrations/control/0013_simple_approval_flow.sql`

Den tillåter direkta statusövergångar från `submitted` till `approved` eller `rejected`, samt direkt godkännande från `under_initial_review` och `resubmitted`.

## Verifierat

Följande kontroller har körts:

- TypeScript: `tsc -p tsconfig.json --noEmit`
- 42 enhets-/repositorytester
- Integrationstest för direkt godkännande och provisionering
- SQL-migrationskontroll
- Säkerhetstester för domäner, inbjudningar, uppladdningar, OIDC och SSRF
