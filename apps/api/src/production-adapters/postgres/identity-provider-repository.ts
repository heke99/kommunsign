import type { SqlDatabase } from '../../../../../packages/database/src/index.js';

export interface IdentityProviderConfigurationView {
  readonly tenantId: string;
  readonly providerKey: 'ENTRA_OIDC' | 'ENTRA_SAML' | 'SWEDEN_CONNECT' | 'TIC_BANKID' | 'FREJA_DIRECT';
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  readonly enabled: boolean;
  readonly publicConfiguration: Readonly<Record<string, unknown>>;
  readonly credentialSecretReference: string | null;
  readonly certificateSecretReference: string | null;
  readonly updatedAt: string;
}

export function createIdentityProviderRepository(database: SqlDatabase): {
  enabledForTenant(tenantId: string, environment: IdentityProviderConfigurationView['environment']): Promise<readonly IdentityProviderConfigurationView[]>;
} {
  return {
    async enabledForTenant(tenantId, environment) {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{
          readonly tenant_id: string;
          readonly provider_key: IdentityProviderConfigurationView['providerKey'];
          readonly environment: IdentityProviderConfigurationView['environment'];
          readonly enabled: boolean;
          readonly public_configuration: Readonly<Record<string, unknown>>;
          readonly credential_secret_reference: string | null;
          readonly certificate_secret_reference: string | null;
          readonly updated_at: Date | string;
        }>(
          `select tenant_id,provider_key,environment,enabled,public_configuration,
                  credential_secret_reference,certificate_secret_reference,updated_at
             from control.tenant_identity_providers
            where tenant_id=$1
              and environment=$2
              and enabled=true
            order by provider_key`,
          [tenantId, environment],
        );
        return result.rows.map((row) => ({
          tenantId: row.tenant_id,
          providerKey: row.provider_key,
          environment: row.environment,
          enabled: row.enabled,
          publicConfiguration: row.public_configuration,
          credentialSecretReference: row.credential_secret_reference,
          certificateSecretReference: row.certificate_secret_reference,
          updatedAt: new Date(row.updated_at).toISOString(),
        }));
      });
    },
  };
}
