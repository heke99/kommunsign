# Tenant gateway

`packages/tenant-gateway` normaliserar Host/forwarded host, validerar betrodd proxy, gör exakt kontrollplansuppslag och skapar en serverhärledd `TenantContext`. Okända värdar ger `TENANT_DOMAIN_NOT_FOUND`; inkonsekvent routing ger `MISDIRECTED_REQUEST`. Cache är host-bunden, kortlivad och kan invalidieras.

Produktions-API:t verifierar dessutom HMAC-signerade interna gatewayheaders med tidsfönster. Tenant-ID accepteras inte från body, query, localStorage eller osignerad header.

Same-origin-BFF ska exponera `/api/*` på tenantdomänen. Den centrala API-tjänsten ligger bakom gatewayen och får inte lita på publik `x-forwarded-host` utan Vercel-/Cloudflaremarkör.

Kvarvarande blockerare: repositoryt innehåller resolver och produktionsauth, men inte en komplett separat Vercel gateway-deployment som proxyar samtliga portalvägar. Det är därför inte korrekt att kalla gatewayflödet liveverifierat ännu.
