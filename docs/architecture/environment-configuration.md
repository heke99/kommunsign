# Miljökonfiguration

`.env.example` är uppdelad i runtime, domäner, databaser, adapters, storage, domänprovider, auth, proxy, CORS, e-post, providers och workers.

Produktionskrav:

1. `APP_ENV=production` och `ALLOW_IN_MEMORY_RUNTIME=false`.
2. Kontroll- och data-URL ska peka på separata projekt.
3. Alla adaptermoduler ska vara granskade produktionsmoduler; namn med `dev` eller `memory` avvisas.
4. `INTERNAL_GATEWAY_HMAC_KEY` ska vara minst 32 slumpmässiga tecken och lagras i secret store.
5. `TRUST_PROXY=true`, `TRUSTED_PROXY_PROVIDER=vercel` och verifierad forwarded host används först i Vercel.
6. `PLATFORM_WILDCARD_VERIFIED` förblir false tills DNS/TLS/routing är verifierat externt.

7. `SENSITIVE_DATA_ENCRYPTION_KEY_BASE64` och `SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64` ska vara separata 32-byte-nycklar, Base64-kodade och lagrade i secret store.
8. `SUPABASE_DATA_SERVICE_ROLE_KEY` får endast finnas i API/worker-runtime och aldrig i frontend.
9. Produktionsworkers är endast kompletta för `TENANT_PROVISION`; övriga handlerblockerare måste stängas före full produktionsaktivering.

Endast variabler med `NEXT_PUBLIC_` får exponeras till frontend.
