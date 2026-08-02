import type {
  ElectronicIdentityProvider, IdentityEvidence, IdentitySession, IdentityStatus,
  StartIdentitySignature, VerifiedIdentityEvidence,
} from '../../contracts/src/index.js';
import { bankIdEvidenceBytes } from './evidence-payload.js';
import { verifyHmacSha256Hex } from '../../crypto/src/hmac.js';

export interface TicPaths {
  readonly start: string;
  readonly status?: string;
  readonly collect?: string;
  readonly cancel?: string;
}

export interface TicBankIdConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly callbackUrl: string;
  readonly webhookUrl: string;
  readonly paths: TicPaths;
}

interface TicStartResponse {
  readonly sessionId?: string;
  readonly orderRef?: string;
  readonly autoStartToken?: string;
  readonly qrStartToken?: string;
  readonly expiresAt?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export class TicConfigurationError extends Error {}
export class TicProtocolError extends Error {}

export interface TicEvidenceVerifier {
  verify(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence>;
}

export class RejectingTicEvidenceVerifier implements TicEvidenceVerifier {
  async verify(): Promise<VerifiedIdentityEvidence> {
    throw new TicConfigurationError('Independent BankID XML-DSig and OCSP verifier is not configured');
  }
}

function requiredPath(value: string | undefined, operation: string): string {
  if (!value) throw new TicConfigurationError(`TIC ${operation} path must be verified from the tenant contract documentation`);
  return value;
}

function mapStatus(value: unknown): IdentityStatus {
  if (typeof value !== 'string') return 'PENDING';
  const normalized = value.toLowerCase();
  if (['complete', 'completed', 'done', 'success'].includes(normalized)) return 'COMPLETED';
  if (['cancelled', 'canceled'].includes(normalized)) return 'CANCELLED';
  if (['expired'].includes(normalized)) return 'EXPIRED';
  if (['failed', 'error'].includes(normalized)) return 'FAILED';
  if (['user_action_required', 'outstandingtransaction', 'pending_user'].includes(normalized)) return 'USER_ACTION_REQUIRED';
  return 'PENDING';
}

export class TicBankIdProvider implements ElectronicIdentityProvider {
  constructor(
    private readonly config: TicBankIdConfig,
    private readonly evidenceVerifier: TicEvidenceVerifier = new RejectingTicEvidenceVerifier(),
    private readonly http: typeof fetch = fetch,
  ) {}

  async startSignature(input: StartIdentitySignature): Promise<IdentitySession> {
    const body = {
      endUserIp: input.endUserIp,
      userAgent: input.userAgent,
      userVisibleData: input.visibleText,
      userVisibleDataFormat: 'simpleMarkdownV1',
      userNonVisibleData: Array.from(bankIdEvidenceBytes(input)),
      ...(input.expectedSubject ? { personalNumber: input.expectedSubject } : {}),
      state: input.state,
      callbackUrl: this.config.callbackUrl,
      webhookUrl: this.config.webhookUrl,
    };
    const response = await this.request<TicStartResponse>(this.config.paths.start, body);
    const providerReference = response.sessionId ?? response.orderRef;
    if (!providerReference) throw new TicProtocolError('TIC start response did not contain a session reference');
    return {
      id: providerReference,
      provider: 'TIC_BANKID',
      providerReference,
      status: mapStatus(response.status),
      ...(response.autoStartToken ? { autoStartToken: response.autoStartToken } : {}),
      ...(response.qrStartToken ? { qrStartToken: response.qrStartToken } : {}),
      expiresAt: response.expiresAt ?? input.expiresAt,
    };
  }

  async getStatus(sessionId: string): Promise<IdentityStatus> {
    const result = await this.request<Record<string, unknown>>(requiredPath(this.config.paths.status, 'status'), { sessionId });
    return mapStatus(result.status);
  }

  async collectEvidence(sessionId: string): Promise<IdentityEvidence> {
    const rawPayload = await this.request<Record<string, unknown>>(requiredPath(this.config.paths.collect, 'collect'), { sessionId });
    return { provider: 'TIC_BANKID', providerReference: sessionId, rawPayload, collectedAt: new Date().toISOString() };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request(requiredPath(this.config.paths.cancel, 'cancel'), { sessionId });
  }

  async verifyEvidence(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence> {
    if (evidence.provider !== 'TIC_BANKID') throw new TicProtocolError('Wrong provider evidence');
    return this.evidenceVerifier.verify(evidence);
  }

  private async request<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await this.http(`${this.config.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new TicProtocolError(`TIC request failed with HTTP ${response.status}`);
    return await response.json() as T;
  }
}

export interface TicWebhookInput {
  readonly rawBody: Uint8Array;
  readonly signature: string;
  readonly timestamp: string;
  readonly secret: string;
  readonly nowEpochSeconds?: number;
  readonly maximumAgeSeconds?: number;
}

export async function verifyTicWebhook(input: TicWebhookInput): Promise<boolean> {
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp)) return false;
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.maximumAgeSeconds ?? 300)) return false;
  const timestampBytes = new TextEncoder().encode(`${input.timestamp}.`);
  const signedPayload = new Uint8Array(timestampBytes.length + input.rawBody.length);
  signedPayload.set(timestampBytes, 0);
  signedPayload.set(input.rawBody, timestampBytes.length);
  return verifyHmacSha256Hex(input.secret, signedPayload, input.signature);
}
