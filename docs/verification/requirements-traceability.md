# Kravspårning

| requirement_id | status | implementation_files | test_files | external_dependency | remaining_work |
|---|---|---|---|---|---|
| A-REPOSITORY-INSPECTION | VERIFIED | `docs/architecture/current-state-verified.md` | `scripts/verify-repository.mjs` | none | Git metadata must be checked after sync |
| A-DONOR-PERMISSIONS | LEGAL_BLOCKER | `upstream/manifests/*`, `upstream/permissions/*` | provenance gate | signed permission files | keep reused LOC at zero |
| B-WORKSPACES-COMMANDS | IMPLEMENTED | `package.json`, `scripts/dev-all.mjs` | repository verification | none | add app-specific packages when framework dependencies are approved |
| B-LOCAL-RUNTIME | PARTIAL | `docker-compose.yml`, `infrastructure/docker/*` | container execution external | Docker | production worker/database bootstrap |
| B-POSTGRES-RLS | PARTIAL | `packages/database`, migrations | `tests/sql/tenant-isolation.sql` | live PostgreSQL | execute in CI/staging and retain logs |
| C-OIDC-PKCE | IMPLEMENTED | `packages/auth` | `tests/security.mjs` | Entra tenant | discovery/JWK/token/session runtime |
| C-SAML | NOT_IMPLEMENTED | control migration model | none | IdP metadata/certificates | protocol runtime and signature validation |
| C-SCIM | PARTIAL | control migration `0005` | migration checks | Entra SCIM client | endpoints and data-plane provisioning |
| C-BREAK-GLASS | PARTIAL | control migration `0005` | migration checks | operating policy | API/UI, notification and expiry worker |
| D-PLATFORM-ADMIN | PARTIAL | `apps/platform-admin/public/*` | portal build | control API | tenant CRUD and provider configuration |
| D-WHITE-LABEL | PARTIAL | `packages/branding` | `tests/security.mjs` | branding assets | persistence and portal application |
| D-CUSTOM-DOMAIN | PARTIAL | `packages/custom-domains`, control migration | `tests/security.mjs` | DNS/TLS provider | provider adapter and retries |
| E-TENANT-PORTAL | PARTIAL | `apps/tenant-portal/public/*` | integration flow | production API | remaining views and auth |
| E-UPLOAD | PARTIAL | `packages/uploads`, API uploads, data migration | integration/security tests | object storage | PUT completion, checksum and quarantine worker |
| E-DOCUMENT-SECURITY | NOT_IMPLEMENTED | schema and Compose services | none | ClamAV/Gotenberg runtime | adapters and hostile PDF tests |
| E-DIGITAL-APPROVAL | IMPLEMENTED | migration `0009`, domain guards | unit tests | none | production repository/API workflow |
| F-SIGNER-PORTAL | PARTIAL | `apps/signer-portal/public/*`, `packages/invitations` | security tests | signer session API | invitation endpoints and provider sessions |
| G-TIC-BANKID | PARTIAL | `packages/provider-adapters/src/tic-bankid.ts` | unit tests | TIC testtenant/key | live E2E and XML-DSig/OCSP |
| H-FREJA | PARTIAL | `FrejaJwsVerifier.java`, provider policy | Java self-test | Freja client/mTLS | official client and live E2E |
| I-PADES | EXTERNAL_BLOCKER | fail-closed signservice | Java build | Sweden Connect/CA/HSM/TSA | real integration and vectors |
| J-DSS | EXTERNAL_BLOCKER | fail-closed validation service | Java build | EU DSS/trust lists | validation runtime and reports |
| K-EVIDENCE-PACKAGE | PARTIAL | `packages/evidence`, CLI | unit tests | TSA/signing key optional | complete package contents and signed manifest |
| L-COMPLETE-API | PARTIAL | `apps/api/src/router.ts`, `ports.ts`, OpenAPI | integration tests | production adapters | PostgreSQL/object/provider implementations |
| L-IDEMPOTENCY | IMPLEMENTED | database package and dev runtime | unit/integration tests | none | persist all responses in production adapter |
| M-WEBHOOKS | PARTIAL | webhooks security, endpoint API, schema | security tests | network resolver/secret manager | delivery worker and DNS rebinding checks |
| M-NOTIFICATIONS | PARTIAL | schema and migration `0011` | migration checks | email provider/domain | worker, templates and delivery events |
| N-EARCHIVE | NOT_IMPLEMENTED | archive schema | none | archive target | connector SDK and export worker |
| O-RETENTION-LEGAL-HOLD | PARTIAL | existing schema/guards | migration/unit coverage | policy decisions | runtime jobs, dry-run and certificates |
| P-SECURITY-HARDENING | PARTIAL | SSRF/upload/branding/auth guards | security tests | pentest environment | CSP headers, abuse tests, penetration test |
| Q-OBSERVABILITY | PARTIAL | alerts baseline | repository checks | telemetry backend | OTel instrumentation and dashboards |
| R-DEPLOYMENT | PARTIAL | Vercel, Docker, Kubernetes, Terraform baseline | repository checks | target cloud | reference deployment and secret bindings |
| S-BACKUP-RESTORE | NOT_IMPLEMENTED | runbook baseline | none | staging infrastructure | automated restore evidence |
| T-E2E-LOAD-WCAG | EXTERNAL_BLOCKER | category commands fail honestly | category scripts | credentials/browser/load environment | execute and archive reports |
