import { sha256Hex } from '../../crypto/src/hash.js';

export interface TicEvidenceValidationRequest {
  readonly signatureXmlBase64: string;
  readonly ocspResponseBase64: string;
  readonly expectedVisibleData: string;
  readonly expectedNonVisibleData: string;
  readonly expectedPersonalNumber?: string;
  readonly policyVersion: string;
}
export interface TicEvidenceValidationReport {
  readonly result: 'PASS' | 'FAIL';
  readonly checks: readonly { readonly code: string; readonly passed: boolean; readonly detail?: string }[];
  readonly personalNumber?: string;
  readonly displayName?: string;
  readonly visibleDataSha256: string;
  readonly nonVisibleDataSha256: string;
  readonly signatureXmlSha256: string;
  readonly ocspSha256: string;
  readonly engine: string;
  readonly policyVersion: string;
  readonly verifiedAt: string;
}

export interface PadesValidationRequest {
  readonly pdfBase64: string;
  readonly expectedDocumentSha256: string;
  readonly trustAnchorsBase64: readonly string[];
  readonly policyVersion: string;
}
export interface PadesValidationCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly mandatory: boolean;
  readonly detail?: string;
}
export interface PadesSignatureSummary {
  readonly status: string;
  readonly coversDocument: boolean;
  readonly etsiAdes: boolean;
  readonly signatureAlgorithm?: string;
  readonly claimedSigningTime?: string | null;
  readonly timestampCount: number;
  readonly signerSubject?: string;
  readonly issuer?: string;
  readonly serialNumber?: string;
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly certificateBase64?: string;
  readonly certificateSha256?: string;
  readonly certificateChainBase64?: readonly string[];
}
/**
 * What the validator found, not what it concluded about a PAdES level.
 *
 * The level is derived from this by packages/pades. Keeping derivation in one
 * place is the reason the validator reports evidence rather than a verdict.
 */
export interface PadesLevelEvidence {
  readonly hasTrustedCertificatePath: boolean;
  readonly hasSignatureTimestamp: boolean;
  readonly hasRevocationEvidence: boolean;
  readonly hasArchiveTimestamp: boolean;
}
export interface PadesValidationReport {
  readonly result: 'PASS' | 'FAIL';
  readonly indication: 'TOTAL_PASSED' | 'INDETERMINATE' | 'TOTAL_FAILED';
  readonly checks: readonly PadesValidationCheck[];
  readonly signatures: readonly PadesSignatureSummary[];
  readonly levelEvidence: PadesLevelEvidence;
  readonly signatureCount: number;
  readonly validSignatureCount: number;
  readonly signsWholeDocument: boolean;
  readonly engine: string;
  readonly engineVersion: string;
  readonly policyVersion: string;
  readonly validatedAt: string;
}

export class ValidationServiceClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly serviceToken: string, private readonly http: typeof fetch = fetch) {
    const parsed = new URL(baseUrl); const privateHttp = parsed.protocol === 'http:' && (['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.hostname.endsWith('.railway.internal')); if (parsed.protocol !== 'https:' && !privateHttp) throw new Error('VALIDATION_SERVICE_URL_INVALID');
    if (!serviceToken.trim()) throw new Error('VALIDATION_SERVICE_TOKEN_MISSING'); this.baseUrl = parsed.toString().replace(/\/$/, '');
  }
  async validateTicEvidence(input: TicEvidenceValidationRequest): Promise<TicEvidenceValidationReport> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.http(`${this.baseUrl}/v1/validate/tic-bankid`, { method: 'POST', headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
      if (!response.ok) throw new Error(`VALIDATION_SERVICE_FAILED:${response.status}`);
      const report = await response.json() as TicEvidenceValidationReport;
      if (!report || !['PASS', 'FAIL'].includes(report.result) || !Array.isArray(report.checks)) throw new Error('VALIDATION_SERVICE_PROTOCOL_INVALID');
      return report;
    } finally { clearTimeout(timeout); }
  }

  async validatePades(input: PadesValidationRequest): Promise<PadesValidationReport> {
    const controller = new AbortController();
    // Parsing and path-building over a multi-megabyte signed PDF takes longer
    // than an XML-DSig check, so this gets its own, larger budget.
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await this.http(`${this.baseUrl}/v1/validate/pades`, { method: 'POST', headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
      // 422 is a completed validation that returned "no", which is a legitimate
      // answer and must be read, not treated as a transport failure.
      if (!response.ok && response.status !== 422) throw new Error(`VALIDATION_SERVICE_FAILED:${response.status}`);
      const report = await response.json() as PadesValidationReport;
      if (!report || !['PASS', 'FAIL'].includes(report.result) || !Array.isArray(report.checks) || !report.levelEvidence) {
        throw new Error('VALIDATION_SERVICE_PROTOCOL_INVALID');
      }
      if (!['TOTAL_PASSED', 'INDETERMINATE', 'TOTAL_FAILED'].includes(report.indication)) throw new Error('VALIDATION_SERVICE_PROTOCOL_INVALID');
      return report;
    } finally { clearTimeout(timeout); }
  }

  async requestHash(input: TicEvidenceValidationRequest): Promise<string> { return sha256Hex(JSON.stringify(input)); }
}
