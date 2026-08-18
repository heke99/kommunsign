import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { AssertionLedger, FederationConfig, FederationProtocol } from '../../../../../packages/federation/src/index.js';

/**
 * Workforce federation, backed by the control plane.
 *
 * The replay ledger is the reason this file exists. `InMemoryAssertionLedger`
 * protects nothing that survives a restart, and in a deployment running more
 * than one instance it never protected anything at all — each process kept its
 * own set, so a replay simply had to land on a different instance. Migration
 * 0017 created `control.federation_assertion_ledger` with the right primary
 * key for the job; nothing used it.
 */

export interface FederationRepository {
  /**
   * A ledger bound to one tenant.
   *
   * Bound per call rather than held as state on the repository: two ACS
   * requests for different tenants are served concurrently by the same
   * process, and a shared mutable "current tenant" would let one of them
   * consume the other's assertion ID. Ambient tenant state is a cross-tenant
   * bug that only appears under load.
   */
  ledgerFor(tenantId: string): AssertionLedger;
  /** The tenant's provider configuration, or null when federation is off. */
  configFor(tenantId: string, providerKey: string, environment: string): Promise<FederationConfig | null>;
  /** Removes ledger entries whose assertions can no longer be replayed. */
  pruneLedger(now: Date): Promise<number>;
}

export function createFederationRepository(controlDatabase: SqlDatabase): FederationRepository {
  return {
    ledgerFor(tenantId) {
      return {
        /**
         * Consumes an assertion ID, atomically.
         *
         * `insert ... on conflict do nothing` plus the row count is the whole
         * mechanism: the primary key is what makes the insert single-use, so
         * two replays arriving at the same moment cannot both see "not yet
         * consumed" and both win. A check-then-insert would have exactly that
         * race, and a race in replay protection is not a rare edge — it is
         * what a replay attack looks like when it is done properly.
         */
        async consume(assertionId, notOnOrAfter) {
          const inserted = await controlDatabase.transaction(async (tx) => tx.query(
            `insert into control.federation_assertion_ledger(tenant_id,assertion_id,not_on_or_after)
             values($1,$2,$3) on conflict (tenant_id,assertion_id) do nothing`,
            [tenantId, assertionId, notOnOrAfter],
          ));
          return inserted.rowCount === 1;
        },
      };
    },

    async configFor(tenantId, providerKey, environment) {
      const result = await controlDatabase.transaction(async (tx) => tx.query<ProviderRow>(
        `select provider_key,enabled,public_configuration,certificate_secret_reference
           from control.tenant_identity_providers
          where tenant_id=$1 and provider_key=$2 and environment=$3`,
        [tenantId, providerKey, environment],
      ));
      const row = result.rows[0];
      if (!row) return null;

      const mappings = await controlDatabase.transaction(async (tx) => tx.query<{ readonly group_value: string; readonly role_key: string }>(
        `select group_value,role_key from control.tenant_federation_role_mappings
          where tenant_id=$1 and provider_key=$2 and environment=$3`,
        [tenantId, providerKey, environment],
      ));

      const configuration = row.public_configuration ?? {};
      return {
        tenantId,
        protocol: protocolFor(row.provider_key),
        enabled: row.enabled,
        issuer: requireString(configuration, 'issuer'),
        audience: requireString(configuration, 'audience'),
        destination: requireString(configuration, 'destination'),
        // Never the certificate itself: a signing certificate inlined in a
        // configuration row is a secret in a column nobody treats as one.
        signingCertificateSecretReference: row.certificate_secret_reference ?? '',
        requiredAuthnContexts: stringArray(configuration, 'requiredAuthnContexts'),
        maximumAuthenticationAgeSeconds: numberOr(configuration, 'maximumAuthenticationAgeSeconds', 3600),
        subjectAttribute: stringOr(configuration, 'subjectAttribute', 'sub'),
        groupsAttribute: stringOr(configuration, 'groupsAttribute', 'groups'),
        groupToRole: Object.fromEntries(mappings.rows.map((entry) => [entry.group_value, entry.role_key])),
        assignableRoles: stringArray(configuration, 'assignableRoles'),
      };
    },

    async pruneLedger(now) {
      const result = await controlDatabase.transaction(async (tx) => tx.query(
        // Strictly past the window. Deleting an entry whose assertion is still
        // inside its validity period would let that assertion be presented a
        // second time.
        `delete from control.federation_assertion_ledger where not_on_or_after < $1`,
        [now.toISOString()],
      ));
      return result.rowCount ?? 0;
    },
  };
}

interface ProviderRow {
  readonly provider_key: string;
  readonly enabled: boolean;
  readonly public_configuration: Readonly<Record<string, unknown>> | null;
  readonly certificate_secret_reference: string | null;
}

/**
 * Protocol from the provider key, not from anything the assertion says.
 *
 * The keys are generic by design — migration 0017 replaced the vendor-specific
 * list with GENERIC_SAML/GENERIC_OIDC precisely so that connecting a different
 * IdP is a configuration row rather than a code change. MobilityGuard, which is
 * what Kungälv runs, is one such row and is named nowhere in this codebase.
 */
function protocolFor(providerKey: string): FederationProtocol {
  return providerKey.endsWith('_SAML') ? 'SAML2' : 'OIDC';
}

function requireString(configuration: Readonly<Record<string, unknown>>, key: string): string {
  const value = configuration[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`FEDERATION_CONFIGURATION_${key.toUpperCase()}_MISSING`);
  }
  return value;
}
function stringOr(configuration: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = configuration[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}
function numberOr(configuration: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = configuration[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function stringArray(configuration: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = configuration[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
