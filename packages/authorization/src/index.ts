export const PLATFORM_ROLES = [
  'platform_super_admin', 'platform_security_admin', 'platform_operations',
  'platform_support', 'platform_auditor',
] as const;
export const TENANT_ROLES = [
  'tenant_admin', 'tenant_security_admin', 'tenant_integration_admin',
  'tenant_archive_admin', 'department_admin', 'document_creator',
  'document_sender', 'approver', 'auditor', 'readonly',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type TenantRole = (typeof TENANT_ROLES)[number];
export type Permission =
  | 'case:create' | 'case:send' | 'case:cancel' | 'case:read' | 'case:remind'
  | 'document:add' | 'document:download' | 'signer:add' | 'upload:create'
  | 'validation:read' | 'evidence:download'
  | 'policy:manage' | 'integration:manage' | 'webhook:manage'
  | 'event:read' | 'template:read' | 'template:manage'
  | 'audit:read' | 'archive:manage' | 'tenant:manage';

const permissions: Readonly<Record<TenantRole, readonly Permission[]>> = {
  tenant_admin: [
    'case:create', 'case:send', 'case:cancel', 'case:read', 'case:remind',
    'document:add', 'document:download', 'signer:add', 'upload:create',
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
