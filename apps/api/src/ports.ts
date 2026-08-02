import type { SignatureCaseStatus, TenantContext } from '../../../packages/contracts/src/index.js';

export interface CreateCaseInput {
  readonly externalReference?: string;
  readonly title: string;
  readonly decisionMode: 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
  readonly signaturePolicyId: string;
}
export interface SignatureCaseView {
  readonly id: string;
  readonly tenantId: string;
  readonly status: SignatureCaseStatus;
  readonly title: string;
  readonly externalReference?: string;
  readonly createdAt: string;
}
export interface CaseRepository {
  create(context: TenantContext, input: CreateCaseInput, idempotencyKey: string, payloadHash: string): Promise<SignatureCaseView>;
  get(context: TenantContext, id: string): Promise<SignatureCaseView | null>;
  list(context: TenantContext): Promise<readonly SignatureCaseView[]>;
  send(context: TenantContext, id: string): Promise<SignatureCaseView>;
  cancel(context: TenantContext, id: string): Promise<SignatureCaseView>;
}
export interface ApiDependencies {
  readonly cases: CaseRepository;
  readonly resolveContext: (request: Request) => Promise<TenantContext>;
}
