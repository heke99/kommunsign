# Säkerhetskontroller

- Sätt `SET LOCAL app.tenant_id = '<verified uuid>'` i varje databastransaktion.
- Sätt `SET LOCAL app.actor_kind = 'external_client'` för publika API-klienter.
- Databasrollen för runtime får inte äga tabeller och får inte ha `BYPASSRLS`.
- Object keys börjar med tenant-ID och kontrolleras både vid signering och hämtning.
- Personnummer krypteras med tenantunik data encryption key; blind index använder separat tenantunik HMAC-nyckel.
- Raw TIC/Freja evidence lagras krypterat i objektlagring och refereras med hash.
- Webhooks verifieras före JSON-parsning där raw body krävs.
- CSP byggs från allowlistade tokens; tenantkonfiguration får inte innehålla JavaScript eller rå HTML.
- Break-glass kräver dubbel attest och tidsbegränsad access grant; generell impersonation byggs inte.
