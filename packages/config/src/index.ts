export type RuntimeEnvironment = 'local' | 'development' | 'test' | 'staging' | 'production';

export interface SecretReference {
  readonly uri: string;
}

export function parseSecretReference(value: string): SecretReference {
  if (!/^(vault|aws-kms|azure-keyvault|gcp-secret):\/\//.test(value)) throw new Error('Secret must be referenced through an approved secret manager URI');
  return { uri: value };
}

export function assertEnvironmentSeparation(environment: RuntimeEnvironment, providerEnvironment: string): void {
  if (environment === 'production' && providerEnvironment.toLowerCase().includes('test')) throw new Error('Production cannot use test provider configuration');
  if (environment !== 'production' && providerEnvironment.toLowerCase().includes('prod')) throw new Error('Non-production cannot use production provider configuration');
}
