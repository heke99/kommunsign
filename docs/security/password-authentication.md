# Lösenordsautentisering

## Säkerhetsmodell

- Ingen publik registrering eller automatisk kontoskapning från ansökan.
- Administrativa Supabase Auth-anrop körs endast från backend med service-role-nyckel.
- Lösenord lagras och verifieras av Supabase Auth, aldrig i Kommunsigns databastabeller.
- Kommunsign lagrar endast provider-subject, krypterad e-post, blind index, medlemskap, roll och auditreferenser.
- Webbläsarsessionen ligger i en `Secure`, `HttpOnly`, `SameSite=Lax`, hostbunden cookie.
- Muterande cookieautentiserade anrop kräver separat CSRF-token.
- Sessionens host måste motsvara den verifierade organisationens domän.
- Glömt-lösenord-svaret är neutralt för att förhindra användaruppräkning.
- Rate limiting kombinerar irreversibelt hashat underlag från åtgärd, IP, e-post och user agent. Rå IP/e-post sparas inte i rate-limit-tabellen.

## Lösenordspolicy

- 12–128 tecken,
- minst en gemen,
- minst en versal,
- minst en siffra,
- minst ett specialtecken.

MFA bör aktiveras för superadministratörer och säkerhetsadministratörer i nästa identity-policyversion. Datamodellen och auth-providergränssnittet ska inte kringgås genom lokal lösenordslagring.

## Tokens och redirect

- Aktiverings- och återställningslänkar får endast gå till exakta allowlistade HTTPS-URL:er.
- Access-token i URL-fragment läses en gång och tas omedelbart bort med `history.replaceState`.
- Token skrivs inte till logg, audit, localStorage eller querystring av Kommunsign.
- Slutförd aktivering skapar en separat Kommunsign-session och återanvänder inte provider-token som applikationssession.

## Avvikelsehantering

- Upprepade misslyckade försök ger `AUTH_RATE_LIMITED` utan providertext.
- Providerfel redigeras till stabila felkoder.
- Saknad auth-providerkonfiguration stoppar produktionsruntime.
- Aktiv session utan CSRF-bindning förbjuds av databasconstraint och verifierings-SQL.
