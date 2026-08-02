# Domain readiness

Blockerande koder omfattar:

- `DEFAULT_TENANT_DOMAIN_NOT_ACTIVE`
- `CUSTOM_DOMAIN_REQUIRED_BUT_MISSING`
- `CUSTOM_DOMAIN_DNS_NOT_VERIFIED`
- `CUSTOM_DOMAIN_CERTIFICATE_NOT_READY`
- `CUSTOM_DOMAIN_ROUTING_FAILED`
- `CUSTOM_DOMAIN_AUTH_CALLBACK_FAILED`
- `CUSTOM_DOMAIN_SIGNER_FLOW_FAILED`
- `CUSTOM_DOMAIN_TAKEOVER_PROTECTION_FAILED`
- `PRIMARY_DOMAIN_NOT_SELECTED`
- `UNVERIFIED_HOSTNAME_CONFIGURED`

`DOMAIN_CERTIFICATE_EXPIRES_SOON` är varning. Readiness hämtar senaste aktiva health-evidens; ifyllda konfigurationsfält räcker inte.

Verifiera med `migrations/control/verify_domain_gateway.sql`, API:s readiness-endpoint och externa curl/DNS/TLS-kontroller i runbooken.
