import type { ElectronicIdentityProvider } from '../../contracts/src/index.js';

export interface FrejaGatewayClient extends ElectronicIdentityProvider {
  readonly transport: 'MTLS_JAVA_GATEWAY';
}

export function assertFrejaSubjectType(
  subjectType: 'INFERRED' | 'PHONE' | 'EMAIL' | 'SSN' | 'UPI',
  classification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'HIGHLY_CONFIDENTIAL',
): void {
  if (subjectType === 'INFERRED' && (classification === 'CONFIDENTIAL' || classification === 'HIGHLY_CONFIDENTIAL')) {
    throw new Error('INFERRED Freja subject is forbidden for person-bound sensitive documents');
  }
}
