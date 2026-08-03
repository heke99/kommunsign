# Supabase Auth-e-post

Supabase Auth används för två säkerhetskritiska meddelandetyper:

- **Bjud in användare**
- **Återställ lösenord**

Supabases inbyggda standardutskick används inte i produktion. Konfigurera Custom SMTP med Resend eller en annan godkänd SMTP-leverantör.

## URL-konfiguration

Sätt Site URL till:

```text
https://auth.kommunsign.se
```

Lägg till exakt följande Redirect URLs i produktion:

```text
https://auth.kommunsign.se/aktivera/
https://auth.kommunsign.se/aterstall/
```

Använd inte breda globmönster i produktion. Preview-URL:er ska ligga i ett separat Supabase-projekt utan produktionsdata.

## SMTP

Produktionsinställningar när Resend används:

```text
Host: smtp.resend.com
Port: 465
Username: resend
Password: separat Resend API-nyckel lagrad i secrets manager
From: Kommunsign <konto@notify.kommunsign.se>
```

Miljökontraktet finns i `.env.production.template`. Kör konfiguration och livekontroll med:

```bash
npm run auth:configure-production
npm run verify:auth-config
```

`SUPABASE_MANAGEMENT_ACCESS_TOKEN` och den upplösta `AUTH_SMTP_PASSWORD` används endast under konfigurationskörningen och ska tas bort från applikationens runtime efteråt.

Krav:

- SPF, DKIM och DMARC verifierade,
- TLS till SMTP-servern,
- inga personnummer eller dokumentuppgifter i meddelandet,
- leveransloggar och dataresidens godkända,
- separata credentials från vanliga signeringsmeddelanden där leverantören stödjer det,
- rate limits anpassade för inbjudningar och återställningar,
- bounce/complaint övervakade.

## Mall: Bjud in användare

Ämne:

```text
Aktivera ditt konto i Kommunsign
```

HTML-mallen versionshanteras i `infrastructure/supabase/auth-templates/invite.html`. Den använder `{{ .TokenHash }}` och leder först till Kommunsigns aktiveringssida. Supabase-token verifieras inte förrän användaren faktiskt skickar in sitt nya lösenord.

## Mall: Återställ lösenord

Ämne:

```text
Återställ ditt lösenord i Kommunsign
```

HTML-mallen versionshanteras i `infrastructure/supabase/auth-templates/recovery.html` och använder samma förhandsöppningssäkra token-hashflöde.

## Skydd mot e-postskanning

Mallarna länkar inte direkt till `{{ .ConfirmationURL }}`. E-postsystem som Microsoft Safe Links kan förhandsöppna länkar; en direkt engångslänk kan då förbrukas innan mottagaren klickar. Kommunsigns mallar skickar därför `{{ .TokenHash }}` till `auth.kommunsign.se`, tar omedelbart bort tokenvärdet ur adressfältet och verifierar det server-side först när användaren väljer lösenord. Klickspårning ska vara avstängd.

## Verifiering

Testa med ett särskilt produktionsverifieringskonto:

1. superadmininbjudan,
2. organisationsinbjudan,
3. återställning av lösenord,
4. utgången länk,
5. återanvänd länk,
6. okänd e-postadress,
7. hard bounce och complaint,
8. korrekt avsändardomän och länkmål.

Sätt `AUTH_EMAIL_DELIVERY_VERIFIED=true` först när samtliga tester är dokumenterade.
