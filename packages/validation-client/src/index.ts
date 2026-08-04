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
  async requestHash(input: TicEvidenceValidationRequest): Promise<string> { return sha256Hex(JSON.stringify(input)); }
}
