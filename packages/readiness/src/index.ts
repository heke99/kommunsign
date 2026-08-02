export type ReadinessSeverity = 'blocking' | 'warning';
export interface ReadinessCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly severity: ReadinessSeverity;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly checkedAt: string;
}
export interface ReadinessResult {
  readonly ready: boolean;
  readonly environment: 'test' | 'production';
  readonly blockingChecks: readonly ReadinessCheck[];
  readonly warningChecks: readonly ReadinessCheck[];
  readonly completedChecks: readonly ReadinessCheck[];
}

export const PRODUCTION_BLOCKING_CHECKS = [
  'TENANT_DATABASE_NOT_READY', 'OBJECT_STORAGE_NOT_READY', 'OIDC_NOT_CONFIGURED',
  'DEFAULT_TENANT_DOMAIN_NOT_ACTIVE', 'CUSTOM_DOMAIN_REQUIRED_BUT_MISSING',
  'CUSTOM_DOMAIN_DNS_NOT_VERIFIED', 'CUSTOM_DOMAIN_CERTIFICATE_NOT_READY',
  'CUSTOM_DOMAIN_ROUTING_FAILED', 'CUSTOM_DOMAIN_AUTH_CALLBACK_FAILED',
  'CUSTOM_DOMAIN_SIGNER_FLOW_FAILED', 'CUSTOM_DOMAIN_TAKEOVER_PROTECTION_FAILED',
  'PRIMARY_DOMAIN_NOT_SELECTED', 'UNVERIFIED_HOSTNAME_CONFIGURED',
  'SIGN_SERVICE_NOT_CONFIGURED', 'VALIDATION_SERVICE_NOT_CONFIGURED',
  'RETENTION_POLICY_NOT_APPROVED', 'DPA_NOT_ACCEPTED', 'ACCEPTANCE_TEST_NOT_PASSED',
  'SOFTWARE_TEST_KEY_IN_PRODUCTION', 'CERTIFICATE_EXPIRED',
] as const;

export function evaluateReadiness(
  environment: 'test' | 'production',
  checks: readonly ReadinessCheck[],
): ReadinessResult {
  const blockingChecks = checks.filter((check) => !check.passed && check.severity === 'blocking');
  const warningChecks = checks.filter((check) => !check.passed && check.severity === 'warning');
  const completedChecks = checks.filter((check) => check.passed);
  return { ready: blockingChecks.length === 0, environment, blockingChecks, warningChecks, completedChecks };
}

export function assertReadyForActivation(result: ReadinessResult): void {
  if (result.environment !== 'production') throw new Error('PRODUCTION_READINESS_REQUIRED');
  if (!result.ready) throw new Error('TENANT_NOT_READY_FOR_ACTIVATION');
}
