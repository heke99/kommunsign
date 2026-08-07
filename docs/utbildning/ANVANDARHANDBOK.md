# Användarhandbok — Kommunsign

Krav 2036 (digitalt tillgänglig användarhandbok och hjälpfunktioner i systemet)
och 2055 (utbildningsmaterial på god svenska i elektronisk och redigerbar form).

Formatet är Markdown: elektroniskt, redigerbart av kunden utan särskild
programvara, versionshanterat tillsammans med koden så att handboken inte kan
hamna efter systemet. Kunden får materialet i sitt eget arkiv och får ändra det.

## 1. Logga in

Gå till kommunens Kommunsign-adress. Logga in med kommunens vanliga
inloggning, eller med e-postadress och lösenord om kommunen använder det.

Nya konton skapas inte av användaren själv. En administratör bjuder in dig, och
inbjudan kommer per e-post.

## 2. Skapa ett signeringsärende

1. Välj **Nytt ärende**.
2. Ange ärendets namn och referens.
3. Ladda upp handlingen som ska undertecknas. Endast PDF tas emot. Filen
   granskas, konverteras till PDF/A och låses.
4. Lägg vid behov till **bilagor**. En bilaga undertecknas inte, men den binds
   till underskriften — den som skriver under godkänner beslutet i ljuset av
   bilagorna, och ett byte i efterhand går därför att upptäcka.
5. Lägg till dem som ska skriva under.

### Turordning

- **Parallellt**: alla kan skriva under samtidigt, i valfri ordning.
- **I turordning**: nästa person får åtkomst först när föregående är klar.

Om någon avböjer avslutas ärendet. Återstående underskrifter skulle inte
summera till ett godkänt beslut.

## 3. Skriva under

Undertecknaren får ett e-postmeddelande med en länk. Ämnesraden innehåller
aldrig namn, ärendemening eller personuppgifter, eftersom den syns på en låst
skärm och i e-postserverloggar.

I signeringsvyn:

1. Öppna och läs varje handling.
2. Kryssa i bekräftelsen.
3. Välj **Starta BankID** (eller Freja).
4. Skanna QR-koden med appen i mobilen, eller starta appen på samma enhet.

Underskriften binds till exakt de filer som visades. Ändras en fil efteråt
upptäcks det vid verifiering.

## 4. Följa och påminna

I ärendevyn ser du vem som skrivit under och vem som återstår. Påminnelser går
bara till den vars tur det faktiskt är — ingen får en påminnelse om ett dokument
de ännu inte kan öppna.

## 5. Hämta resultatet

När alla skrivit under kan du hämta:

- **Undertecknat dokument** i PDF/A.
- **Bevispaket** med underskrifter, identitetsbevis, tidsstämplar, kontrollsummor
  och händelselogg.

## 6. Verifiera en underskrift

Verifieringsportalen kontrollerar ett undertecknat dokument eller ett bevispaket.
Den fungerar även för handlingar som lämnat kommunen, och kräver inte inloggning.

## 7. Arkivera och gallra

**Arkivexport** skapar ett leveranspaket enligt Riksarkivets föreskrifter, med
metadata, kontrollsummor och bevis. Paketet kan verifieras utan Kommunsign.

**Gallring** styrs av kommunens egen gallringsregel. Den kräver behörigheten
`retention:execute` och måste godkännas av någon annan än den som begärde den.
Leverantören kan inte gallra åt kommunen. Ett ärende under legal hold gallras
aldrig. Efter genomförd gallring skapas en gallringsrapport.

## 8. Personuppgiftsbegäran

Begäran om registerutdrag, rättelse, begränsning, radering eller dataportabilitet
hanteras under **Personuppgifter**. Identiteten måste styrkas innan något lämnas
ut. Fristen är 30 dagar från det att begäran togs emot.

## 9. Skyddade personuppgifter

Personer med sekretessmarkering, skyddad folkbokföring eller fingerade
personuppgifter hanteras särskilt. Uppgifterna maskeras i listor, e-post,
exporter och loggar, och personen visas inte i sökträffar från och med skyddad
folkbokföring — en maskerad träff bekräftar ändå att personen har ett ärende
hos kommunen.

## 10. Hjälp i systemet

Varje vy har en hjälpsektion som förklarar just det steget, med samma text som i
den här handboken. Vid fel visas vad som gick fel och vad du kan göra åt det.

## 11. Support

Se `docs/operations/KUNGALV_SUPPORT_SLA.md` för kontaktvägar, öppettider,
prioritetsnivåer och svarstider.
