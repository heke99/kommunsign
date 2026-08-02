# KommunSigns domänarkitektur

## Implementerad modell

Kontrollplanet är auktoritativt för kedjan `hostname → tenant_id → environment_id → data_plane_id`. `tenant_domains.normalized_hostname` är globalt unik och får bara routas när domänen, tenantmiljön och tenanten är i tillåtet tillstånd. Slug används endast för adressbildning; tenantens UUID används i databas, API och audit.

Varje tenant får en permanent plattformsdomän `{slug}.kommunsign.se`. Kunddomäner är verifierade alias. Byte av primärdomän ändrar aldrig tenant-, dokument-, ärende- eller evidence-ID.

## Centrala värdar

`kommunsign.se`, `apply`, `admin`, `app`, `auth`, `api`, `sign`, `verify`, `docs`, `status`, `hooks` samt `*.kommunsign.se` är reserverade. Reserveringen finns både i kod och databas.

## Databasobjekt

Migration `0007_domain_driven_tenant_gateway.sql` inför dataplanregister, tenantmiljöer, domäntillstånd, DNS-challenges, provideroperationer, certifikatsnapshots, hälsokontroller, routingevent, brandingversioner och primärdomänhistorik. Migration `0010_custom_domain_operations.sql` inför krypterad challenge-återläsning och en tvåpersonsprocedur för primärdomänbyte.

## Kvarvarande extern verifiering

Wildcard-DNS/TLS, Vercel-projektbindning och verkliga kund-DNS-poster kan inte markeras verifierade utan produktionskonton och DNS-åtkomst. `PLATFORM_WILDCARD_VERIFIED` ska vara `false` tills dessa kontroller är utförda.
