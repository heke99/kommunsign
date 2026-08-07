# Säker utveckling, förändringshantering och sårbarheter

Krav 3502, 3513, 3515, 3516, 3517, 3521, 3529, 3531, 3532, 3537, 3538, 3541,
3543, 3545, 3546, samt 2044, 2045 och 2046.

Senast uppdaterad: 2026-08-07.

## 1. Principer för säker utveckling (krav 3543, 3545)

Fyra principer styr utvecklingen, och de är verkställda i kod och bygge snarare
än enbart beskrivna. En princip som bara står i ett dokument är en avsikt.

**Fail closed.** Varje okonfigurerad provider vägrar. En signeringstjänst utan
nyckelmaterial producerar ingenting signaturliknande — den vägrar
(`NotConfiguredSigningEngine`, `BlockedSigningEngine`).

**Servern äger tillstånd.** Klienten sätter aldrig `signed`, `completed`,
`validated` eller `archived`. Övergångar valideras i databasen och i
domänmodellen.

**Tenant kommer aldrig ur ett fritt requestfält.** Ett fält klienten
kontrollerar är inte en identitet.

**Ingen egen kryptografi.** Primitiver, ASN.1, CMS och certifikatvalidering
kommer från granskade implementationer genom en beroendegrind (ADR 0003).

Webbutveckling följer OWASP ASVS-nivå 2 som referens. Attackytorna som testas
negativt är SSRF, domänkapning, uppladdning, inbjudningar, OIDC, tenantkorsning,
replay och signaturförfalskning (`tests/security.mjs`).

## 2. Uppdelning av ansvar (krav 3502)

Uppgifter som i kombination möjliggör missbruk är åtskilda, och de två viktigaste
är verkställda i kod och inte enbart i rutin:

- **Gallring** kräver att godkännaren är någon annan än den som begärde, att
  aktören har `retention:execute`, och att aktören inte är leverantörspersonal.
- **Åtkomst till skyddade personuppgifter** kräver ett tidsbegränsat, motiverat
  samtycke per person utfärdat av kunden.

Därutöver: den som skriver kod granskar inte sin egen ändring, och produktionsu
trullning kräver godkänd granskning och grön `npm run verify`.

## 3. Administrativa identiteter (krav 3516, 3521)

Systemadministration sker med personliga, namngivna konton. Delade konton
används inte. Administrativa konton är skilda från de konton samma person
använder för vanligt arbete, så att en komprometterad vardagssession inte bär
administrativ behörighet.

Behörighet tilldelas enligt minsta möjliga: API-klienter får bara de scopes
integrationen behöver, SCIM-klienter kan inte tilldela roller utanför sin
`assignable_roles`, och leverantörspersonal har ingen stående åtkomst till
kunddata. Break glass-åtkomst är separat, tidsbegränsad och larmar vid
användning.

## 4. Lösenordsdistribution och återställning (krav 3517)

Lösenord distribueras aldrig i klartext, varken vid nytt konto eller vid
återställning. Kommunsign skickar en engångslänk med kort giltighet till den
registrerade e-postadressen; mottagaren sätter själv lösenordet.

Kommunsign lagrar aldrig lösenord — autentiseringen sköts av Supabase Auth.
Vid återställning avslöjar svaret aldrig om kontot finns; ett svar som skiljer
sig åt gör återställningsflödet till ett verktyg för att kartlägga användare.

## 5. Kundens godkännande av kontohantering (krav 3515, 3541)

Skapande, ändring och borttagning av användare sker antingen av kundens egen
administratör eller genom SCIM från kundens katalog. Leverantören skapar inte
konton åt kunden på eget initiativ.

Informationsutbyten med andra system godkänns av kunden innan de aktiveras: en
integration kräver en API-klient som kunden själv skapar och scopar, och en
webhookprenumeration kräver en endpoint kunden själv registrerar. Federation och
provisionering kräver konfiguration från kunden. Ingen väg ut ur systemet öppnas
utan att kunden har vidtagit en aktiv åtgärd.

## 6. Förändringshantering (krav 3529, 3546, 2046)

Varje ändring går genom: förslag → granskning → automatiserad verifiering →
test i separat testmiljö → godkännande → utrullning → dokumentation.

`npm run verify` är grinden och måste vara grön. Den kör bygge,
repositoryverifiering, deployment-konfiguration, migrationsverifiering,
kravmatris, provenance, SDK-synk, tillgänglighet, hemlighetsskanning,
Java-gränstjänster samt enhets-, integrations- och säkerhetstester.

Ändringar som påverkar säkerhet eller bevisvärde — schema, RLS, auktorisering,
signeringskedjan, kryptografi — kräver dessutom uttrycklig säkerhetsgranskning
och negativa tester för den nya attackytan (AGENTS.md).

Migrationer ändras aldrig i efterhand; en ny läggs till. Varje migration
dokumenterar syfte, påverkan, backfill, rollback och verifiering, vilket
kontrolleras maskinellt av `npm run verify:migrations`.

## 7. Testmiljö och testdata (krav 3531)

Samtliga leveranser testas i separat testmiljö före produktion. Testmiljön är
skild från produktion i nät, databaser, lagring och credentials.

Produktionsdata kopieras inte till testmiljön. Behövs realistisk volym genereras
syntetiska data. Ett testdataset med riktiga personnummer är en
personuppgiftsbehandling utan rättslig grund, och testmiljöer har regelmässigt
svagare skydd än produktion — vilket är hela problemet.

Produktionsvägar kan inte använda testprovider (AGENTS.md regel 10), och
`packages/identity-registry` vägrar i produktion för varje metod som inte är
produktionsklar.

## 8. Skydd mot skadlig kod (krav 3532, 3537)

Uppladdade filer skannas med kontinuerligt uppdaterade signaturer före
bearbetning. Endast PDF tas emot, kontrollerat på både MIME-typ och magiska
bytes; filer i karantän blir aldrig tillgängliga. PDF:er kanoniseras och aktivt
innehåll tas bort innan dokumentet låses.

Exekverbar kod i tjänsten begränsas till det som byggts ur repositoryt.
Beroenden är pinnade med checksummor i lockfilen, provenance kontrolleras av
`npm run verify:provenance`, och en SBOM genereras med `npm run sbom`.
Portalerna kör med strikt CSP utan `unsafe-inline` och `unsafe-eval`, och
bygget misslyckas om inline-skript eller inline-stil dyker upp — policyn och
markupen kan därför inte glida isär.

## 9. Sårbarhetshantering (krav 2045, 3538)

Beroenden skannas vid varje bygge och löpande mot publicerade sårbarheter.
Nya sårbarheter i levererade komponenter bedöms utifrån faktisk exponering i
Kommunsign, inte enbart utifrån CVSS.

| Allvarlighet | Åtgärd | Information till kunden |
| --- | --- | --- |
| Kritisk, exponerad | Åtgärd påbörjas omgående, utrullning inom 24 timmar | Utan dröjsmål, före åtgärd |
| Hög | Åtgärd inom 7 dagar | Utan dröjsmål |
| Medel | Åtgärd inom 30 dagar | I förvaltningsmötet |
| Låg eller ej exponerad | Planeras i ordinarie underhåll | I förvaltningsmötet |

Kunden informeras utan dröjsmål vid kritisk och hög allvarlighet — även innan
åtgärden är klar, eftersom kommunen kan behöva vidta egna åtgärder under tiden.

## 10. Underhållsverktyg (krav 2044, 3524)

Verktyg för underhåll och felsökning har samma skydd som tjänsten: personlig
inloggning, minsta möjliga behörighet, ingen stående åtkomst till kunddata, och
loggning av varje administrativ åtgärd med aktör, tenant och korrelation.
Loggverktygen är i sin tur åtkomstskyddade, och auditloggen är hashkedjad så att
manipulation är detekterbar.

## 11. Beställarens krav på informationshantering (krav 3513)

Kungälvs uttryckliga krav följs enligt kravmatrisen
(`docs/compliance/kungalv/REQUIREMENT_MATRIX.md`), som är genererad och där
`npm run verify` misslyckas om ett krav saknar bedömning.

Där kommunen inte uttryckligen ställt krav tillämpas den strängare av
branschpraxis och vår egen policy. Konkret innebär det bland annat: personnummer
krypterat med blind index i stället för i klartext, `no-referrer` i stället för
`same-origin`, WCAG 2.2 AA i stället för 2.0 AA som kravet anger, och radering
som kräver verifierad borttagning i varje kopia i stället för i primärlagret.
