import type { DecisionMode, DocumentStatus, IdentifierBindingExceptionCode, IdentifierBindingMode, IsoDateTime, SignatureCaseStatus, SignerStatus, UUID } from './index.js';

export type ContractJsonPrimitive = string | number | boolean | null;
export type ContractJsonValue = ContractJsonPrimitive | readonly ContractJsonValue[] | { readonly [key: string]: ContractJsonValue };
export type ContractJsonObject = { readonly [key: string]: ContractJsonValue };

export interface SignatureCaseDetailDocument {
  readonly id: UUID;
  readonly displayName: string;
  readonly role: string | null;
  readonly ordinal: number;
  readonly version: number;
  readonly status: DocumentStatus;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly sourcePageCount: number | null;
  readonly canonicalPageCount: number | null;
  readonly pdfProfile: string | null;
  readonly lockedAt: IsoDateTime | null;
  readonly scanResult: string | null;
  readonly processingResult: string | null;
}

export interface SignatureCaseDetailSigner {
  readonly id: UUID;
  readonly displayName: string;
  readonly status: SignerStatus;
  readonly signingOrder: number;
  readonly required: boolean;
  readonly identifierBindingMode: IdentifierBindingMode;
  readonly identifierBindingExceptionCode: IdentifierBindingExceptionCode | null;
  readonly emailConfigured: boolean;
}

export interface SignatureCaseDetailAuditEvent {
  readonly id: UUID;
  readonly type: string;
  readonly category: string;
  readonly actorType: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly occurredAt: IsoDateTime;
}

export interface SignatureCaseDetail {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly status: SignatureCaseStatus;
  readonly statusVersion?: number;
  readonly decisionMode: DecisionMode;
  readonly title: string;
  readonly externalReference?: string;
  readonly createdAt: IsoDateTime;
  readonly policy: {
    readonly id: UUID;
    readonly version: number;
    readonly snapshot: ContractJsonObject;
  };
  readonly createdBy: UUID;
  readonly sentAt?: IsoDateTime;
  readonly completedAt?: IsoDateTime;
  readonly expiresAt?: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly documents: readonly SignatureCaseDetailDocument[];
  readonly signers: readonly SignatureCaseDetailSigner[];
  readonly events: readonly SignatureCaseDetailAuditEvent[];
  readonly evidenceAvailable: boolean;
  readonly archiveCompleted: boolean;
}
