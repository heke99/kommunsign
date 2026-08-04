# Auth broker

Brokerkomponenterna stöder host-bundna engångskoder, destinationsverifiering och separata host-only cookies:

- `__Host-ks_tenant_session`
- `__Host-ks_platform_session`
- `__Host-ks_applicant_session`
- `__Host-ks_signer_session`

Migration `0009_auth_broker_sessions.sql` lagrar endast kod-/sessionhashar och krypterad PKCE-data. En kod konsumeras atomiskt och kan inte återanvändas eller bytas på annan hostname.

OIDC/SAML-providerkonfiguration finns tenantvis i kontrollplanet. Kompletta publika callbackroutes på `app.kommunsign.se/login/`, metadataimport, signaturvalidering och SCIM-arbetare kräver fortsatt implementation och livekonfiguration hos respektive IdP.
