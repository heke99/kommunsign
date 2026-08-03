export const PLATFORM_ROLES = [
  'platform_super_admin', 'platform_security_admin', 'platform_operations',
  'platform_support', 'platform_auditor', 'onboarding_manager',
  'onboarding_case_worker', 'commercial_reviewer', 'legal_reviewer',
  'security_reviewer', 'technical_reviewer', 'provisioning_operator',
  'activation_approver',
] as const;
export const TENANT_ROLES = [
  'tenant_admin', 'tenant_security_admin', 'tenant_integration_admin',
  'tenant_archive_admin', 'department_admin', 'document_creator',
  'document_sender', 'approver', 'auditor', 'readonly',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type TenantRole = (typeof TENANT_ROLES)[number];
export type PlatformPermission =
  | 'onboarding:read' | 'onboarding:assign' | 'onboarding:review'
  | 'onboarding:request_information' | 'onboarding:decide' | 'onboarding:provision'
  | 'tenant:readiness' | 'tenant:activation_request' | 'tenant:activation_approve'
  | 'organization:user_manage' | 'platform:audit_read';

export type Permission =
  | 'case:create' | 'case:send' | 'case:cancel' | 'case:read' | 'case:remind'
  | 'document:add' | 'document:download' | 'signer:add' | 'signer:personnummer-binding-exempt' | 'upload:create'
  | 'validation:read' | 'evidence:download'
  | 'policy:manage' | 'integration:manage' | 'webhook:manage'
  | 'event:read' | 'template:read' | 'template:manage'
  | 'audit:read' | 'archive:manage' | 'tenant:manage';

const permissions: Readonly<Record<TenantRole, readonly Permission[]>> = {
  tenant_admin: [
    'case:create', 'case:send', 'case:cancel', 'case:read', 'case:remind',
    'document:add', 'document:download', 'signer:add', 'signer:personnummer-binding-exempt', 'upload:create',
    'validation:read', 'evidence:download', 'policy:manage', 'integration:manage',
    'webhook:manage', 'event:read', 'template:read', 'template:manage',
    'audit:read', 'archive:manage', 'tenant:manage',
  ],
  tenant_security_admin: ['case:read', 'validation:read', 'policy:manage', 'audit:read', 'event:read', 'integration:manage'],
  tenant_integration_admin: ['case:create', 'case:read', 'document:add', 'signer:add', 'upload:create', 'integration:manage', 'webhook:manage', 'event:read', 'template:read'],
  tenant_archive_admin: ['case:read', 'document:download', 'validation:read', 'evidence:download', 'archive:manage', 'audit:read', 'event:read'],
  department_admin: ['case:create', 'case:send', 'case:cancel', 'case:read', 'case:remind', 'document:add', 'document:download', 'signer:add', 'upload:create', 'validation:read', 'evidence:download', 'template:read'],
  document_creator: ['case:create', 'case:read', 'document:add', 'signer:add', 'upload:create', 'template:read'],
  document_sender: ['case:create', 'case:send', 'case:cancel', 'case:read', 'case:remind', 'document:add', 'document:download', 'signer:add', 'upload:create', 'validation:read', 'evidence:download', 'template:read'],
  approver: ['case:read'],
  auditor: ['case:read', 'validation:read', 'event:read', 'audit:read'],
  readonly: ['case:read', 'template:read'],
};

export function hasPermission(roles: readonly TenantRole[], permission: Permission): boolean {
  return roles.some((role) => permissions[role].includes(permission));
}

export function requirePermission(roles: readonly TenantRole[], permission: Permission): void {
  if (!hasPermission(roles, permission)) throw new Error(`Permission denied: ${permission}`);
}


const platformPermissions: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  platform_super_admin: ['onboarding:read','onboarding:assign','onboarding:review','onboarding:request_information','onboarding:decide','onboarding:provision','tenant:readiness','tenant:activation_request','tenant:activation_approve','organization:user_manage','platform:audit_read'],
  platform_security_admin: ['onboarding:read','onboarding:review','tenant:readiness','tenant:activation_approve','platform:audit_read'],
  platform_operations: ['onboarding:read','onboarding:assign','onboarding:provision','tenant:readiness','tenant:activation_request','platform:audit_read'],
  platform_support: ['onboarding:read','onboarding:request_information'],
  platform_auditor: ['onboarding:read','platform:audit_read'],
  onboarding_manager: ['onboarding:read','onboarding:assign','onboarding:review','onboarding:request_information','onboarding:decide','onboarding:provision','tenant:readiness','tenant:activation_request','platform:audit_read'],
  onboarding_case_worker: ['onboarding:read','onboarding:assign','onboarding:review','onboarding:request_information'],
  commercial_reviewer: ['onboarding:read','onboarding:review'],
  legal_reviewer: ['onboarding:read','onboarding:review'],
  security_reviewer: ['onboarding:read','onboarding:review','tenant:readiness'],
  technical_reviewer: ['onboarding:read','onboarding:review','tenant:readiness'],
  provisioning_operator: ['onboarding:read','onboarding:provision','tenant:readiness','tenant:activation_request'],
  activation_approver: ['onboarding:read','tenant:readiness','tenant:activation_approve'],
};

export function hasPlatformPermission(roles: readonly PlatformRole[], permission: PlatformPermission): boolean {
  return roles.some((role) => platformPermissions[role].includes(permission));
}

export function requirePlatformPermission(roles: readonly PlatformRole[], permission: PlatformPermission): void {
  if (!hasPlatformPermission(roles, permission)) throw new Error(`Permission denied: ${permission}`);
}
