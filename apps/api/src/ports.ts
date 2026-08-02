import type { Permission } from '../../../packages/authorization/src/index.js';
import type { DomainEvent, SignatureCaseStatus, TenantContext } from '../../../packages/contracts/src/index.js';

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
  readonly statusVersion?: number;
  readonly decisionMode: 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
  readonly title: string;
  readonly externalReference?: string;
  readonly createdAt: string;
}
export interface AddDocumentInput {
  readonly uploadId: string;
  readonly displayName: string;
}
export interface DocumentView {
  readonly id: string;
  readonly signatureCaseId: string;
  readonly displayName: string;
  readonly status: 'quarantined' | 'scanning' | 'rejected' | 'canonicalizing' | 'ready' | 'locked';
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
}
export interface AddSignerInput {
  readonly displayName?: string;
  readonly recipientReference: string;
  readonly identifierType?: 'SSN' | 'UPI' | 'EMAIL' | 'PHONE' | 'INFERRED';
  readonly required: boolean;
  readonly signingOrder?: number;
}
export interface SignerView {
  readonly id: string;
  readonly signatureCaseId: string;
  readonly displayName?: string;
  readonly recipientReference: string;
  readonly status: 'pending' | 'invited' | 'opened' | 'identity_started' | 'identity_verified' | 'signing' | 'signed' | 'declined' | 'expired' | 'cancelled' | 'failed';
  readonly required: boolean;
  readonly signingOrder?: number;
}
export interface UploadGrantInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
export interface UploadGrantView extends UploadGrantInput {
  readonly id: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}
export interface WebhookEndpointInput {
  readonly url: string;
  readonly subscribedEvents: readonly string[];
}
export interface WebhookEndpointView extends WebhookEndpointInput {
  readonly id: string;
  readonly active: boolean;
  readonly createdAt: string;
}
export interface TemplateInput {
  readonly templateKey: string;
  readonly locale: string;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
}
export interface TemplateView extends TemplateInput {
  readonly id: string;
  readonly version: number;
  readonly active: boolean;
}
export interface DownloadArtifact {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fileName: string;
  readonly sha256?: string;
}
export interface PageInput {
  readonly limit: number;
  readonly cursor?: string;
}
export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor?: string;
}

export interface CaseRepository {
  create(context: TenantContext, input: CreateCaseInput, idempotencyKey: string, payloadHash: string): Promise<SignatureCaseView>;
  get(context: TenantContext, id: string): Promise<SignatureCaseView | null>;
  list(context: TenantContext, page: PageInput): Promise<Page<SignatureCaseView>>;
  addDocument(context: TenantContext, id: string, input: AddDocumentInput, idempotencyKey: string, payloadHash: string): Promise<DocumentView>;
  addSigner(context: TenantContext, id: string, input: AddSignerInput, idempotencyKey: string, payloadHash: string): Promise<SignerView>;
  send(context: TenantContext, id: string, idempotencyKey: string, payloadHash: string, expectedVersion?: number): Promise<SignatureCaseView>;
  cancel(context: TenantContext, id: string, idempotencyKey: string, payloadHash: string, expectedVersion?: number): Promise<SignatureCaseView>;
  remind(context: TenantContext, id: string, idempotencyKey: string, payloadHash: string): Promise<{ readonly jobId: string; readonly status: 'queued' }>;
  signedDocument(context: TenantContext, id: string): Promise<DownloadArtifact>;
  validationReport(context: TenantContext, id: string): Promise<DownloadArtifact>;
  evidencePackage(context: TenantContext, id: string): Promise<DownloadArtifact>;
}
export interface UploadRepository {
  create(context: TenantContext, input: UploadGrantInput, idempotencyKey: string, payloadHash: string): Promise<UploadGrantView>;
}
export interface WebhookRepository {
  createEndpoint(context: TenantContext, input: WebhookEndpointInput, idempotencyKey: string, payloadHash: string): Promise<WebhookEndpointView>;
}
export interface EventRepository {
  list(context: TenantContext, page: PageInput): Promise<Page<DomainEvent>>;
}
export interface TemplateRepository {
  list(context: TenantContext, page: PageInput): Promise<Page<TemplateView>>;
  create(context: TenantContext, input: TemplateInput, idempotencyKey: string, payloadHash: string): Promise<TemplateView>;
}
export interface ApiDependencies {
  readonly cases: CaseRepository;
  readonly uploads: UploadRepository;
  readonly webhooks: WebhookRepository;
  readonly events: EventRepository;
  readonly templates: TemplateRepository;
  readonly resolveContext: (request: Request) => Promise<TenantContext>;
  readonly authorize: (context: TenantContext, permission: Permission) => Promise<void> | void;
  readonly reportError?: (cause: unknown, requestId: string) => void;
}
