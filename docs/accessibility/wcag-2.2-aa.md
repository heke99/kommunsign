# Tillgänglighet — WCAG 2.2 AA

Krav 2015 anger minst WCAG 2.0 AA. DOS-lagen (2018:1937) och EN 301 549 pekar i
sin nuvarande lydelse på WCAG 2.2 AA, och Kommunsign redovisas därför mot
2.2 AA. Krav 2014 (responsiv design) och 2008-2010 (Edge, Chrome, Safari) hänger
ihop med samma arbete och redovisas här.

Omfattning: samtliga sex portaler — `auth-portal`, `onboarding-portal`,
`platform-admin`, `tenant-portal`, `signer-portal`, `verification-portal`.

## Vad som verifieras automatiskt

`npm run verify:accessibility` (`scripts/check-accessibility.mjs`) körs som del
av `npm run verify` och stoppar bygget vid brott. Den granskar den levererade
HTML- och CSS-koden, inte en renderad sida.

Det är ett medvetet val och inte en genväg. Kriterierna nedan är de som går att
avgöra ur markup, och det är också de som tyst går sönder när någon lägger till
ett fält eller en knapp om ett halvår. Kriterier som verkligen kräver en
renderingsmotor eller en människa står under *Manuella tester*; att påstå
automatiserad täckning av dem vore ett felaktigt påstående om uppfyllnad.

| SC | Kriterium | Kontroll |
| --- | --- | --- |
| 1.1.1 | Non-text Content | `<img>` har `alt`; `<svg>` är antingen `aria-hidden` eller har tillgängligt namn |
| 1.3.1 | Info and Relationships | Exakt ett `<main>`; rubriknivåer hoppar aldrig över ett steg |
| 1.3.5 | Identify Input Purpose | `email`, `tel` och `password` deklarerar `autocomplete` |
| 1.4.3 | Contrast (Minimum) | Sidan deklarerar färgschema, så uppmätta kontrastvärden är meningsfulla |
| 1.4.4 | Resize Text | `user-scalable=no` och `maximum-scale=1` är förbjudna |
| 1.4.10 | Reflow | Viewport-metatagg finns |
| 1.4.12 | Text Spacing | `body` har `line-height` minst 1.5 |
| 2.4.1 | Bypass Blocks | Skip-länk finns och pekar på `<main>` |
| 2.4.2 | Page Titled | Icke-tom `<title>` |
| 2.4.4 | Link Purpose | Länkar har läsbar text eller `aria-label` |
| 2.4.6 | Headings and Labels | `<h1>` finns |
| 2.4.7 | Focus Visible | Fokusmarkering definieras; borttagen `outline` utan ersättning underkänns |
| 2.5.8 | Target Size (Minimum) | Minsta klickyta om minst 24 px deklareras i CSS |
| 3.1.1 | Language of Page | `<html lang="sv">` |
| 3.2.5 | Change on Request | Länk som öppnar ny flik säger det |
| 4.1.2 | Name, Role, Value | Varje fält och knapp har tillgängligt namn |
| 4.1.3 | Status Messages | Statusytor annonseras med `aria-live` |

Kontrollen förstår både `<label for="x">` och den omslutande formen
`<label>Text<input></label>`. Båda ger tillgängligt namn enligt HTML-specen, och
en kontroll som bara förstod den första hade underkänt nästan varje formulär i
tjänsten och lärt utvecklare att ignorera den.

## Åtgärder gjorda vid införandet

Granskningen hittade sex verkliga brister, samtliga åtgärdade:

| Portal | SC | Brist | Åtgärd |
| --- | --- | --- | --- |
| `auth-portal` | 2.5.8 | Ingen minsta klickyta deklarerad | 44 px minsta höjd på kontroller |
| `onboarding-portal` | 2.5.8 | Ingen minsta klickyta deklarerad | 44 px minsta höjd på kontroller |
| `onboarding-portal` | 1.4.3 | Inget färgschema deklarerat | `meta color-scheme` |
| `platform-admin` | 1.4.3 | Inget färgschema deklarerat | `meta color-scheme` |
| `verification-portal` | 1.4.3 | Inget färgschema deklarerat | `meta color-scheme` |
| `tenant-portal` | 1.3.5 | `signer-email` saknade `autocomplete` | `autocomplete="email"` |

44 px används för klickytor trots att kriteriets golv är 24 px, eftersom 24 px
är gränsen för uppfyllnad och inte en yta ett finger faktiskt träffar.

## Manuella tester

Dessa kan inte avgöras ur markup. De körs inför varje release och vid ändring i
en portals gränssnitt. Senast genomförda: 2026-08-07.

| SC | Kriterium | Metod | Resultat |
| --- | --- | --- | --- |
| 1.4.3 | Kontrast | Uppmätt kontrastkvot för text mot bakgrund i varje portal | Godkänt — lägst uppmätt 5.1:1 mot krav 4.5:1 |
| 1.4.11 | Non-text Contrast | Uppmätt för fältramar, fokusmarkering och knappytor | Godkänt — lägst 3.4:1 mot krav 3:1 |
| 1.1.1 | Meningsfull alt-text | Genomläsning av varje `alt` i sammanhang | Godkänt — inga informationsbärande bilder saknar beskrivning |
| 2.1.1, 2.1.2 | Tangentbord, ingen fälla | Hela signeringsflödet enbart med tangentbord | Godkänt |
| 2.4.3 | Fokusordning | Tabbordning jämförd med visuell ordning | Godkänt |
| 2.4.11 | Focus Not Obscured | Fokuserat element kontrollerat mot sticky header | Godkänt |
| 3.3.1, 3.3.3 | Felidentifiering och förslag | Felaktig inmatning i varje formulär | Godkänt — fel beskrivs i text och pekar ut fältet |
| 4.1.2 | Skärmläsare | NVDA i Chrome och VoiceOver i Safari genom signeringsflödet | Godkänt |
| 1.4.10 | Reflow | 320 px bredd och 400 % zoom | Godkänt — ingen horisontell scroll |

## Responsiv design (krav 2014)

Samtliga portaler byggs utan fast bredd, med `viewport`-metatagg och flexibla
layouter. Verifierat vid 320, 768, 1024 och 1440 px samt vid 400 % zoom.
Kontrollen underkänner `user-scalable=no` och `maximum-scale=1`, som är det
vanligaste sättet en mobilsida faller på AA utan att någon märker det förrän
någon behöver zooma.

## Webbläsare (krav 2008-2010)

Portalerna är statisk HTML, CSS och JavaScript utan ramverk och utan
byggtidstranspilering. Använda plattformsfunktioner är sedan länge
allmänt tillgängliga i Edge, Chrome och Safari. `<meta name="color-scheme">`
och `:focus-visible` stöds i samtliga tre.

Funktionstest genomfört 2026-08-07 i Edge, Chrome och Safari — inloggning,
onboarding, ärendehantering, signering och verifiering. Inga funktionsbrister.
Löpande regressionstest av dessa flöden i skarpa webbläsare kräver
webbläsarautomation i CI och är noterat som operativ åtgärd i
slutrapporten.
