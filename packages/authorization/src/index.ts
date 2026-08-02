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
  | 'case:create' | 'case:send' | 'case:cancel' | 'case:read'
  | 'document:download' | 'policy:manage' | 'integration:manage'
  | 'audit:read' | 'archive:manage' | 'tenant:manage';

const permissions: Readonly<Record<TenantRole, readonly Permission[]>> = {
  tenant_admin: ['case:create', 'case:send', 'case:cancel', 'case:read', 'document:download', 'policy:manage', 'integration:manage', 'audit:read', 'archive:manage', 'tenant:manage'],
  tenant_security_admin: ['case:read', 'policy:manage', 'audit:read', 'integration:manage'],
  tenant_integration_admin: ['case:create', 'case:read', 'integration:manage'],
  tenant_archive_admin: ['case:read', 'document:download', 'archive:manage', 'audit:read'],
  department_admin: ['case:create', 'case:send', 'case:cancel', 'case:read', 'document:download'],
  document_creator: ['case:create', 'case:read'],
  document_sender: ['case:create', 'case:send', 'case:cancel', 'case:read', 'document:download'],
  approver: ['case:read'],
  auditor: ['case:read', 'audit:read'],
  readonly: ['case:read'],
};

export function hasPermission(roles: readonly TenantRole[], permission: Permission): boolean {
  return roles.some((role) => permissions[role].includes(permission));
}

export function requirePermission(roles: readonly TenantRole[], permission: Permission): void {
  if (!hasPermission(roles, permission)) throw new Error(`Permission denied: ${permission}`);
}
