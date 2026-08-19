import type { DeliveryRepository } from './production-adapters/postgres/delivery-repository.js';
import type { FederationRepository } from './production-adapters/postgres/federation-repository.js';
import type { ScimRepository } from './production-adapters/postgres/scim-repository.js';
import type { Permission, PlatformPermission } from '../../../packages/authorization/src/index.js';
import type { ApplicantContext, DomainEvent, PlatformContext, SignatureCaseStatus, TenantContext } from '../../../packages/contracts/src/index.js';
import type { ApplicationStatus, ProvisioningStatus } from '../../../packages/onboarding/src/index.js';
import type { ReadinessResult } from '../../../packages/readiness/src/index.js';

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
export interface PersonalNumberExceptionInput {
  readonly code: 'UNKNOWN_AT_INVITATION' | 'DATA_MINIMIZATION' | 'PROTECTED_PERSONAL_DATA_WORKFLOW' | 'RECIPIENT_SELECTED_BY_SECURE_CHANNEL' | 'OTHER';
  readonly reason?: string | null;
}
export interface AddSignerInput {
  readonly displayName: string;
  readonly email: string;
  readonly personalNumber: string | null;
  readonly requirePersonalNumberMatch: boolean;
  readonly personalNumberException: PersonalNumberExceptionInput | null;
  readonly required: boolean;
  readonly signingOrder: number;
  /** Set by the API boundary only after authorization; never accepted from JSON. */
  readonly exceptionPermissionGranted?: true;
}
export interface SignerView {
  readonly id: string;
  readonly signatureCaseId: string;
  readonly displayName: string;
  readonly maskedEmail: string;
  readonly identifierBindingMode: 'STRICT_PREBOUND' | 'BANKID_DISCOVERED';
  readonly maskedPersonalNumber?: string;
  readonly identifierBindingExceptionCode?: PersonalNumberExceptionInput['code'];
  readonly status: 'pending' | 'invited' | 'opened' | 'identity_started' | 'identity_verified' | 'signing' | 'signed' | 'declined' | 'expired' | 'cancelled' | 'failed';
  readonly required: boolean;
  readonly signingOrder: number;
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
  /**
   * The signing secret, returned only by the call that created or rotated it.
   *
   * A subscriber cannot verify our HMAC without it, and it is never readable
   * again afterwards: it exists encrypted in the database and nowhere else, so
   * a lost secret is rotated rather than recovered.
   */
  readonly signingSecret?: string;
}
export interface WebhookDeliveryView {
  readonly id: string;
  readonly webhookEndpointId: string;
  readonly outboxEventId: string;
  readonly eventType: string;
  readonly status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead_letter';
  readonly attempt: number;
  readonly responseStatus: number | null;
  readonly nextAttemptAt: string;
  readonly deliveredAt: string | null;
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

export interface SignaturePolicyView {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly decisionMode: 'DIGITAL_APPROVAL' | 'ELECTRONIC_SIGNATURE';
  readonly active: boolean;
}

export interface CaseRepository {
  listPolicies(context: TenantContext): Promise<readonly SignaturePolicyView[]>;
  create(context: TenantContext, input: CreateCaseInput, idempotencyKey: string, payloadHash: string): Promise<SignatureCaseView>;
  get(context: TenantContext, id: string): Promise<SignatureCaseView | null>;
  list(context: TenantContext, page: PageInput): Promise<Page<SignatureCaseView>>;
  addDocument(context: TenantContext, id: string, input: AddDocumentInput, idempotencyKey: string, payloadHash: string): Promise<DocumentView>;
  addSigner(context: TenantContext, id: string, input: AddSignerInput, idempotencyKey: string, payloadHash: string): Promise<SignerView>;
  updateSigner(context: TenantContext, id: string, signerId: string, input: AddSignerInput, idempotencyKey: string, payloadHash: string, expectedVersion?: number): Promise<SignerView>;
  send(context: TenantContext, id: string, idempotencyKey: string, payloadHash: string, expectedVersion?: number): Promise<SignatureCaseView>;
  cancel(context: TenantContext, id: string, idempotencyKey: string, payloadHash: string, expectedVersion?: number): Promise<SignatureCaseView>;
  remind(context: TenantContext, id: string, idempotencyKey: string, payloadHash: string): Promise<{ readonly jobId: string; readonly status: 'queued' }>;
  signedDocument(context: TenantContext, id: string): Promise<DownloadArtifact>;
  validationReport(context: TenantContext, id: string): Promise<DownloadArtifact>;
  evidencePackage(context: TenantContext, id: string): Promise<DownloadArtifact>;
}
export interface UploadRepository {
  create(context: TenantContext, input: UploadGrantInput, idempotencyKey: string, payloadHash: string): Promise<UploadGrantView>;
  complete(context: TenantContext, uploadId: string, idempotencyKey: string, payloadHash: string): Promise<{ readonly id: string; readonly status: 'uploaded'; readonly sha256: string; readonly byteSize: number }>;
}
export interface WebhookRepository {
  createEndpoint(context: TenantContext, input: WebhookEndpointInput, idempotencyKey: string, payloadHash: string): Promise<WebhookEndpointView>;
  rotateSecret(context: TenantContext, endpointId: string, overlapSeconds: number): Promise<WebhookEndpointView>;
  listDeliveries(context: TenantContext, page: PageInput, status?: string): Promise<Page<WebhookDeliveryView>>;
  replayDelivery(context: TenantContext, deliveryId: string): Promise<WebhookDeliveryView>;
}
export interface GallringPreviewCase {
  readonly signatureCaseId: string;
  readonly title: string;
  readonly closedAt: string | null;
  readonly action: 'DELETE' | 'ARCHIVE_THEN_DELETE';
  readonly reason: string;
  /** True when a legal hold blocks this case; such cases are never queued. */
  readonly underLegalHold: boolean;
  readonly archived: boolean;
}
export interface GallringPreview {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly retentionClass: 'business_data' | 'security_log' | 'access_log';
  readonly evaluatedAt: string;
  readonly eligible: readonly GallringPreviewCase[];
  readonly blocked: readonly GallringPreviewCase[];
}
export interface GallringJobView {
  readonly id: string;
  readonly state: 'QUEUED' | 'PLANNED' | 'APPROVED' | 'EXECUTING' | 'VERIFIED' | 'REPORTED' | 'ABANDONED';
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly retentionClass: string;
  readonly caseIds: readonly string[];
  readonly plannedTargets: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly report?: {
    readonly complete: boolean;
    readonly deletedTotal: number;
    readonly unverifiedTargets: readonly string[];
    readonly reportSha256: string;
  };
}
export interface RetentionRepository {
  /**
   * Shows what a gallring would remove before anything is removed. Gallring is
   * irreversible, so the preview is not a convenience — it is how the customer
   * sees what they are about to approve.
   */
  preview(context: TenantContext, policyKey: string): Promise<GallringPreview>;
  queue(context: TenantContext, policyKey: string, caseIds: readonly string[], idempotencyKey: string, payloadHash: string): Promise<GallringJobView>;
  approve(context: TenantContext, gallringJobId: string): Promise<GallringJobView>;
  get(context: TenantContext, gallringJobId: string): Promise<GallringJobView>;
  list(context: TenantContext, page: PageInput): Promise<Page<GallringJobView>>;
}
/** What the customer sees of a rights request, with nothing about the subject in it. */
export interface PrivacyRequestView {
  readonly privacyRequestId: string;
  readonly state: 'RECEIVED' | 'IDENTITY_VERIFIED' | 'IN_PROGRESS' | 'FULFILLED' | 'DELIVERED' | 'REFUSED';
  readonly right: 'ACCESS' | 'RECTIFICATION' | 'RESTRICTION' | 'ERASURE' | 'PORTABILITY';
  readonly receivedAt: string;
  readonly dueAt: string;
  /** True once the deadline has passed with the request still open. */
  readonly overdue: boolean;
  readonly identityAssurance: 'LOW' | 'SUBSTANTIAL' | 'HIGH' | null;
  readonly deliveredAt: string | null;
  readonly refusalGround: string | null;
  /** One entry per store, present only once the request has been answered. */
  readonly coverage: readonly {
    readonly store: 'CONTROL' | 'DATA' | 'OBJECT_STORAGE' | 'AUDIT_LOG' | 'BACKUP';
    readonly recordCount: number;
    readonly searched: boolean;
    readonly exemptionReason: string | null;
    readonly actionTaken: string;
  }[];
}
export interface RecordPrivacyRequestInput {
  readonly right: 'ACCESS' | 'RECTIFICATION' | 'RESTRICTION' | 'ERASURE' | 'PORTABILITY';
  /** The subject's identifier, in the clear on the wire and never stored as such. */
  readonly subjectIdentifier: string;
  readonly identityMethod: string;
  readonly identityAssurance: 'LOW' | 'SUBSTANTIAL' | 'HIGH';
}
export interface PrivacyRepository {
  /**
   * Records a request and starts the thirty-day clock. Identity is supplied at
   * this point rather than later because everything after it — searching,
   * exporting, erasing — is disclosure or destruction, and neither may happen
   * on an unproven claim to be someone.
   */
  record(context: TenantContext, input: RecordPrivacyRequestInput, idempotencyKey: string, payloadHash: string): Promise<PrivacyRequestView>;
  /** Queues execution. Separate from recording so the erasing act needs its own grant. */
  execute(context: TenantContext, privacyRequestId: string): Promise<PrivacyRequestView>;
  get(context: TenantContext, privacyRequestId: string): Promise<PrivacyRequestView>;
  list(context: TenantContext, page: PageInput): Promise<Page<PrivacyRequestView>>;
}
export interface EventRepository {
  list(context: TenantContext, page: PageInput): Promise<Page<DomainEvent>>;
}
export interface TemplateRepository {
  list(context: TenantContext, page: PageInput): Promise<Page<TemplateView>>;
  create(context: TenantContext, input: TemplateInput, idempotencyKey: string, payloadHash: string): Promise<TemplateView>;
}

export type DeploymentMode = 'shared_saas' | 'dedicated_data_plane' | 'customer_hosted';
export interface CreateApplicationInput {
  readonly organizationName: string;
  readonly organizationNumber: string;
  readonly organizationType: 'municipality' | 'region' | 'municipal_federation' | 'municipal_company' | 'authority' | 'public_supplier' | 'other_public_body';
  readonly primaryEmail: string;
  readonly primaryContactName: string;
  readonly primaryContactTitle: string;
}
export interface ApplicationProfile {
  readonly website?: string;
  readonly officialEmailDomain?: string;
  readonly municipalityOrRegion?: string;
  readonly postalAddress?: Readonly<Record<string, string>>;
  readonly billing?: Readonly<Record<string, string>>;
  readonly procurementReference?: string;
  readonly technicalContact?: Readonly<Record<string, string>>;
  readonly legalAndPrivacy?: Readonly<Record<string, string>>;
  readonly plannedUse?: Readonly<Record<string, unknown>>;
  readonly identityAndAccess?: Readonly<Record<string, unknown>>;
  readonly deployment?: Readonly<{ mode: DeploymentMode; region?: string; customDomain?: string; estimatedStorageGb?: number; classification?: string }>;
}
export interface UpdateApplicationInput {
  readonly organizationName?: string;
  readonly primaryContactName?: string;
  readonly primaryContactTitle?: string;
  readonly profile?: ApplicationProfile;
}
export interface ApplicationView {
  readonly id: string;
  readonly applicationReference?: string;
  readonly status: ApplicationStatus;
  readonly statusVersion: number;
  readonly organizationName: string;
  readonly organizationNumber: string;
  readonly organizationType: CreateApplicationInput['organizationType'];
  readonly primaryEmail: string;
  readonly primaryContactName: string;
  readonly primaryContactTitle: string;
  readonly profile: ApplicationProfile;
  readonly emailVerifiedAt?: string;
  readonly submittedAt?: string;
  readonly decidedAt?: string;
  readonly assignedTo?: string;
  readonly tenantId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ApplicationCreatedView {
  readonly application: ApplicationView;
  readonly accessToken: string;
  readonly verificationRequired: true;
  readonly developmentVerificationToken?: string;
}
export interface ApplicationDocumentInput extends UploadGrantInput { readonly category: string; }
export interface ApplicationDocumentView extends ApplicationDocumentInput {
  readonly id: string;
  readonly applicationId: string;
  readonly status: 'quarantined' | 'scanning' | 'rejected' | 'ready';
  readonly createdAt: string;
}
export interface ExternalMessageInput { readonly body: string; readonly attachmentIds?: readonly string[]; }
export interface ExternalMessageView extends ExternalMessageInput {
  readonly id: string;
  readonly applicationId: string;
  readonly direction: 'applicant_to_platform' | 'platform_to_applicant';
  readonly createdAt: string;
}
export interface InformationRequestInput {
  readonly category: 'commercial' | 'legal' | 'security' | 'technical' | 'organization' | 'other';
  readonly question: string;
  readonly dueAt?: string;
  readonly attachmentRequired: boolean;
}
export interface InformationRequestView extends InformationRequestInput {
  readonly id: string;
  readonly applicationId: string;
  readonly status: 'open' | 'answered' | 'accepted' | 'rejected' | 'cancelled';
  readonly createdAt: string;
}
export interface InformationResponseInput { readonly answer: string; readonly attachmentIds?: readonly string[]; }
export interface ReviewInput {
  readonly reviewType: 'commercial' | 'legal' | 'security' | 'technical';
  readonly result: 'pending' | 'passed' | 'failed' | 'requires_information';
  readonly summary: string;
  readonly riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}
export interface DecisionInput {
  readonly reason: string;
  readonly internalReason?: string;
  readonly conditions?: readonly string[];
  readonly validUntil?: string;
  readonly secondApproverId?: string;
}
export interface ProvisioningRequestView {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId?: string;
  readonly status: ProvisioningStatus;
  readonly currentStep?: string;
  readonly blockingCode?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ActivationRequestView {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly status: 'requested' | 'pending_approval' | 'approved' | 'rejected' | 'activated' | 'cancelled';
  readonly createdAt: string;
  readonly decidedAt?: string;
}
export interface CreateOrganizationInput {
  readonly organizationName: string;
  readonly organizationNumber: string;
  readonly organizationType: CreateApplicationInput['organizationType'];
  readonly primaryAdminEmail: string;
  readonly primaryAdminName: string;
  readonly primaryAdminTitle: string;
  readonly deploymentMode: DeploymentMode;
  readonly region: string;
}
export interface PlatformOrganizationView {
  readonly applicationId: string;
  readonly legalName: string;
  readonly organizationNumber: string;
  readonly organizationType: CreateApplicationInput['organizationType'];
  readonly applicationStatus: ApplicationStatus;
  readonly primaryAdminEmail: string;
  readonly primaryAdminName: string;
  readonly primaryAdminTitle: string;
  readonly domainReady: boolean;
  readonly createdAt: string;
  readonly tenantId?: string;
  readonly tenantStatus?: 'provisioning' | 'onboarding' | 'active' | 'paused' | 'suspended' | 'decommissioning' | 'decommissioned';
  readonly provisioningRequestId?: string;
  readonly provisioningStatus?: ProvisioningStatus;
  readonly currentStep?: string;
  readonly blockingCode?: string;
  readonly primaryHostname?: string;
}

export interface OnboardingRepository {
  platformOrganizations(context: PlatformContext, page: PageInput, filters: Readonly<Record<string, string>>): Promise<Page<PlatformOrganizationView>>;
  createOrganization(context: PlatformContext, input: CreateOrganizationInput, idempotencyKey: string, payloadHash: string): Promise<PlatformOrganizationView>;
  create(input: CreateApplicationInput, idempotencyKey: string, payloadHash: string): Promise<ApplicationCreatedView>;
  resolveApplicant(applicationId: string, accessToken: string, requestId: string): Promise<ApplicantContext>;
  get(context: ApplicantContext): Promise<ApplicationView>;
  update(context: ApplicantContext, input: UpdateApplicationInput, expectedVersion: number | undefined, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  verifyEmail(applicationId: string, token: string, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  resendVerification(applicationId: string, idempotencyKey: string, payloadHash: string): Promise<{ readonly accepted: true; readonly developmentVerificationToken?: string }>;
  addDocument(context: ApplicantContext, input: ApplicationDocumentInput, idempotencyKey: string, payloadHash: string): Promise<ApplicationDocumentView>;
  submit(context: ApplicantContext, expectedVersion: number | undefined, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  withdraw(context: ApplicantContext, expectedVersion: number | undefined, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  listMessages(context: ApplicantContext): Promise<readonly ExternalMessageView[]>;
  createMessage(context: ApplicantContext, input: ExternalMessageInput, idempotencyKey: string, payloadHash: string): Promise<ExternalMessageView>;
  listInformationRequests(context: ApplicantContext): Promise<readonly InformationRequestView[]>;
  respondToInformationRequest(context: ApplicantContext, requestId: string, input: InformationResponseInput, idempotencyKey: string, payloadHash: string): Promise<InformationRequestView>;
  platformList(context: PlatformContext, page: PageInput, filters: Readonly<Record<string, string>>): Promise<Page<ApplicationView>>;
  platformGet(context: PlatformContext, applicationId: string): Promise<ApplicationView | null>;
  assign(context: PlatformContext, applicationId: string, assigneeId: string, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  addReview(context: PlatformContext, applicationId: string, input: ReviewInput, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  requestInformation(context: PlatformContext, applicationId: string, input: InformationRequestInput, idempotencyKey: string, payloadHash: string): Promise<InformationRequestView>;
  approve(context: PlatformContext, applicationId: string, input: DecisionInput, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  reject(context: PlatformContext, applicationId: string, input: DecisionInput, idempotencyKey: string, payloadHash: string): Promise<ApplicationView>;
  provision(context: PlatformContext, applicationId: string, idempotencyKey: string, payloadHash: string): Promise<ProvisioningRequestView>;
  audit(context: PlatformContext, applicationId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  getProvisioning(context: PlatformContext, requestId: string): Promise<ProvisioningRequestView | null>;
  retryProvisioning(context: PlatformContext, requestId: string, idempotencyKey: string, payloadHash: string): Promise<ProvisioningRequestView>;
  runReadiness(context: PlatformContext, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<ReadinessResult>;
  getReadiness(context: PlatformContext, tenantId: string): Promise<ReadinessResult | null>;
  createActivationRequest(context: PlatformContext, tenantId: string, idempotencyKey: string, payloadHash: string): Promise<ActivationRequestView>;
  decideActivation(context: PlatformContext, requestId: string, decision: 'approve' | 'reject', reason: string, idempotencyKey: string, payloadHash: string): Promise<ActivationRequestView>;
}



export interface LoginInput {
  readonly email: string;
  readonly password: string;
}
export interface PasswordRecoveryInput {
  readonly email: string;
}
export interface CompletePasswordInput {
  readonly accessToken?: string;
  readonly tokenHash?: string;
  readonly type?: 'invite' | 'recovery';
  readonly destinationHostname?: string;
  readonly password: string;
}
export interface AuthRequestMetadata {
  readonly ipAddress: string;
  readonly userAgent: string;
}
export interface AuthenticatedSessionView {
  readonly subjectId: string;
  readonly boundary: 'tenant' | 'platform';
  readonly destinationUrl: string;
  readonly expiresAt: string;
  readonly csrfToken: string;
  readonly tenantId?: string;
  readonly displayName?: string;
}
export interface OrganizationUserInput {
  readonly displayName: string;
  readonly email: string;
  readonly roleKey: 'tenant_admin' | 'tenant_security_admin' | 'tenant_integration_admin' | 'tenant_archive_admin' | 'department_admin' | 'document_creator' | 'document_sender' | 'approver' | 'auditor' | 'readonly';
}
export interface OrganizationUserStatusInput {
  readonly action: 'disable' | 'enable';
}
export interface OrganizationUserView {
  readonly id: string;
  readonly tenantId: string;
  readonly providerSubjectId: string;
  readonly displayName: string;
  readonly maskedEmail: string;
  readonly roleKey: OrganizationUserInput['roleKey'];
  readonly status: 'invited' | 'active' | 'disabled' | 'revoked' | 'failed';
  readonly invitedAt: string;
}
export interface AuthenticationRepository {
  login(input: LoginInput, metadata: AuthRequestMetadata): Promise<AuthenticatedSessionView & { readonly sessionToken: string }>;
  forgotPassword(input: PasswordRecoveryInput, metadata: AuthRequestMetadata): Promise<{ readonly accepted: true }>;
  completePassword(input: CompletePasswordInput, metadata: AuthRequestMetadata): Promise<AuthenticatedSessionView & { readonly sessionToken: string }>;
  session(sessionToken: string, originHostname: string): Promise<AuthenticatedSessionView>;
  logout(sessionToken: string, originHostname: string, csrfToken: string): Promise<{ readonly loggedOut: true }>;
  listOrganizationUsers(context: PlatformContext, tenantId: string): Promise<readonly OrganizationUserView[]>;
  inviteOrganizationUser(context: PlatformContext, tenantId: string, input: OrganizationUserInput, idempotencyKey: string, payloadHash: string): Promise<OrganizationUserView>;
  setOrganizationUserStatus(context: PlatformContext, tenantId: string, accountId: string, input: OrganizationUserStatusInput): Promise<OrganizationUserView>;
}

export interface PublicSigningDocumentView {
  readonly id: string;
  readonly displayName: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: 'application/pdf';
  readonly profile: 'PDF/A-2b';
  readonly ordinal: number;
}
export interface PublicSigningInvitationView {
  readonly invitationId: string;
  readonly signerId: string;
  readonly signatureCaseId: string;
  readonly organizationName: string;
  readonly caseReference: string;
  readonly caseTitle: string;
  readonly signerDisplayName: string;
  readonly status: SignerView['status'];
  readonly expiresAt: string;
  readonly identifierBindingMode: 'STRICT_PREBOUND' | 'BANKID_DISCOVERED';
  readonly visibleText: string;
  readonly documents: readonly PublicSigningDocumentView[];
}
export interface PublicBankIdSessionView {
  readonly sessionId: string;
  readonly status: 'PENDING' | 'USER_ACTION_REQUIRED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  readonly expiresAt: string;
  readonly autoStartToken?: string;
  readonly qrCodeData?: string;
  readonly canExtend: boolean;
}
export interface PublicSigningRepository {
  getInvitation(token: string): Promise<PublicSigningInvitationView>;
  markOpened(token: string): Promise<{ readonly opened: true }>;
  document(token: string, documentId: string): Promise<DownloadArtifact>;
  startBankId(token: string, input: { readonly reviewAcknowledged: true; readonly endUserIp: string; readonly userAgent: string }): Promise<PublicBankIdSessionView>;
  bankIdStatus(token: string, sessionId: string): Promise<PublicBankIdSessionView>;
  extendBankId(token: string, sessionId: string): Promise<PublicBankIdSessionView>;
  cancelBankId(token: string, sessionId: string): Promise<{ readonly cancelled: true }>;
  decline(token: string, reason?: string): Promise<{ readonly declined: true }>;
}
export interface ProviderWebhookRepository {
  tic(input: { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string,string|undefined>>; readonly receivedAt: string }): Promise<{ readonly accepted: true; readonly duplicate: boolean }>;
  resend(input: { readonly rawBody: Uint8Array; readonly headers: Readonly<Record<string,string|undefined>>; readonly receivedAt: string }): Promise<{ readonly accepted: true; readonly duplicate: boolean }>;
}
export interface PublicVerificationSummary {
  readonly verified: boolean;
  readonly organization: string;
  readonly caseReference: string;
  readonly documents: readonly { readonly displayName: string; readonly sha256: string }[];
  readonly signerCount: number;
  readonly signedAt: string;
  readonly verifierEngine: string;
  readonly verifierPolicyVersion: string;
  readonly packageSha256: string;
}
export interface PublicVerificationRepository {
  get(verificationId: string): Promise<PublicVerificationSummary | null>;
  verifyPackage(bytes: Uint8Array): Promise<{ readonly verified: boolean; readonly packageSha256: string; readonly failures: readonly string[] }>;
}
export interface MetricsEndpoint {
  readonly scrapeToken: string;
  render(now: Date): Promise<string>;
}
export interface ApiDependencies {
  readonly cases: CaseRepository;
  readonly uploads: UploadRepository;
  readonly webhooks: WebhookRepository;
  readonly events: EventRepository;
  readonly templates: TemplateRepository;
  /** Optional: a deployment without gallring configured simply has no routes. */
  readonly retention?: RetentionRepository;
  /** Optional: a deployment without rights-request handling simply has no routes. */
  readonly privacy?: PrivacyRepository;
  /** Optional: a deployment with no directory connected simply has no SCIM surface. */
  readonly scim?: ScimRepository;
  /** Optional: a tenant with no IdP configured simply cannot federate. */
  readonly federation?: FederationRepository;
  /**
   * Optional: without a scrape credential configured there is no /metrics
   * endpoint. The default has to be "absent" rather than "open", because an
   * accidentally public metrics endpoint leaks cross-tenant operational state
   * and nothing about the deployment looks wrong while it does.
   */
  readonly metrics?: MetricsEndpoint;
  /**
   * Optional: without it a completed document can still be fetched through the
   * authenticated API, there is simply no shareable link.
   */
  readonly delivery?: DeliveryRepository;
  readonly publicSigning?: PublicSigningRepository;
  readonly providerWebhooks?: ProviderWebhookRepository;
  readonly publicVerification?: PublicVerificationRepository;
  readonly resolveContext: (request: Request) => Promise<TenantContext>;
  readonly authorize: (context: TenantContext, permission: Permission) => Promise<void> | void;
  readonly onboarding?: OnboardingRepository;
  readonly authentication?: AuthenticationRepository;
  readonly resolvePlatformContext?: (request: Request) => Promise<PlatformContext>;
  readonly authorizePlatform?: (context: PlatformContext, permission: PlatformPermission) => Promise<void> | void;
  readonly reportError?: (cause: unknown, requestId: string) => void;
}

