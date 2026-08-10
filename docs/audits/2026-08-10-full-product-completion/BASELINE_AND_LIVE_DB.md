# Baseline and live database verification — 2026-08-10

## GitHub baseline

- Repository: `heke99/kommunsign`
- Base branch: `main`
- Baseline commit: `7fadbfecdb302c0ebae8c2832726805718371ef9`
- Remediation branch: `remediation/kommunsign-full-product-completion-2026-08-10`

The remediation branch was created from `main` at the baseline commit above. No existing remediation branch was reused as the base.

## Live Supabase projects

- CONTROL: `kommunsign-control` / `bvaffzjqzwsqxevolblu`, eu-north-1, PostgreSQL 17.6.1.155, ACTIVE_HEALTHY.
- DATA: `kommunsign-data` / `ddawgwlyjaoaajwyunaw`, eu-north-1, PostgreSQL 17.6.1.155, ACTIVE_HEALTHY.

## Live schema result

The live databases are not merely migration descriptions; both were queried directly.

### CONTROL

`kommunsign_meta.schema_migrations` reports migrations through `0016_consistent_tenant_and_account_activation.sql`. The live schema nevertheless already contains the objects introduced by control migration `0017_workforce_federation.sql` (`tenant_federation_role_mappings` and `federation_assertion_ledger`). The migration ledger therefore does not describe the complete live schema.

### DATA

`kommunsign_meta.schema_migrations` reports migrations through `0016_pgcrypto_audit_runtime_repair.sql`. The live schema nevertheless already contains the objects/columns associated with `0017_scim_provisioning.sql` and `0018_document_attachments.sql`, including SCIM tables, `users.scim_external_id`, `users.scim_user_name`, `documents.document_role`, `documents.document_ordinal`, and `signing_intent_bundles`.

An attempted application of the repository's DATA `0017_scim_provisioning` migration was correctly stopped by an existing `scim_provisioning_clients_tenant_isolation` policy. No partial migration was accepted. This is evidence of schema/ledger drift, not evidence that the migration should be blindly replayed.

## RLS result

Every inspected `app` table in the live DATA database has both RLS enabled and FORCE RLS enabled. The tenant policies use `tenant_id = app.current_tenant_id()` for both `USING` and `WITH CHECK`.

## Code finding requiring remediation

The current tenant portal still contains `const caseDetails=new Map()` and uses it to accumulate document/signer state. Although the API already exposes `GET /v1/signature-cases/:id`, its production repository currently returns only the shallow `SignatureCaseView` fields. This does not satisfy the masterprompt's server-authoritative case-detail contract.

## Verification limitation

A local `npm ci --ignore-scripts` could not complete because the environment's package registry returned HTTP 404 for `postgres@3.4.7`. Therefore no claim is made that a fresh local `npm run verify` passed in this environment. The repository's prior clean-checkout verification remains historical evidence only until rerun successfully in an environment with the declared dependency available.
