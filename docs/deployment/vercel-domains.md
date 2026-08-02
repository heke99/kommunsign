# Vercelprojekt och domäner

Planerade projekt finns i `infrastructure/vercel/projects.json`:

- kommunsign-public: `kommunsign.se`, `www.kommunsign.se`
- kommunsign-onboarding: `apply.kommunsign.se`
- kommunsign-platform-admin: `admin.kommunsign.se`
- kommunsign-auth: `auth.kommunsign.se`
- kommunsign-tenant-gateway: `app.kommunsign.se`, `sign.kommunsign.se`, `*.kommunsign.se` och verifierade kunddomäner
- kommunsign-verification: `verify.kommunsign.se`
- kommunsign-docs: `docs.kommunsign.se`

`VercelDomainProvider` använder backend-token och projekt/team-ID. Providerresultat får inte ensamt markera readiness grön; DNS, TLS och tenantbindande health endpoint ska också passera.

Exempelkommandon finns i slutleveransrapporten. Kommandona skapar inte DNS hos kundens namnserver; det steget är alltid externt.
