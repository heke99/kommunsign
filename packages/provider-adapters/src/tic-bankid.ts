import type {
  ElectronicIdentityProvider, IdentityEvidence, IdentitySession, IdentityStatus,
  StartIdentitySignature, VerifiedIdentityEvidence,
} from '../../contracts/src/index.js';
import { base64Encode } from '../../crypto/src/base64.js';
import { verifyHmacSha256Hex } from '../../crypto/src/hmac.js';
import { bankIdEvidenceBytes } from './evidence-payload.js';

export interface TicPaths {
  readonly start: string;
  readonly status: string;
  readonly collect: string;
  readonly cancel: string;
}

const DEFAULT_TIC_PATHS: TicPaths = {
  start: '/auth/bankid/sign',
  status: '/auth/{sessionId}/poll',
  collect: '/auth/{sessionId}/collect',
  cancel: '/auth/{sessionId}',
};

export interface TicBankIdConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly callbackUrl: string;
  readonly webhookUrl: string;
  readonly paths?: Partial<TicPaths>;
  readonly timeoutMs?: number;
}

interface TicStartResponse {
  readonly sessionId?: string;
  readonly orderRef?: string;
  readonly autoStartToken?: string;
  readonly qrStartToken?: string;
  readonly qrStartSecret?: string;
  readonly subscriptionToken?: string;
  readonly sessionExpiresAt?: string;
  readonly expiresAt?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export class TicConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicConfigurationError';
  }
}
export class TicProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicProtocolError';
  }
}

export interface TicEvidenceVerifier {
  verify(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence>;
}

export class RejectingTicEvidenceVerifier implements TicEvidenceVerifier {
  async verify(): Promise<VerifiedIdentityEvidence> {
    throw new TicConfigurationError('Independent BankID XML-DSig and OCSP verifier is not configured');
  }
}

function mapStatus(value: unknown): IdentityStatus {
  if (typeof value !== 'string') return 'PENDING';
  const normalized = value.toLowerCase();
  if (['complete', 'completed', 'done', 'success'].includes(normalized)) return 'COMPLETED';
  if (['cancelled', 'canceled'].includes(normalized)) return 'CANCELLED';
  if (normalized === 'expired') return 'EXPIRED';
  if (['failed', 'error'].includes(normalized)) return 'FAILED';
  if (['user_action_required', 'outstandingtransaction', 'pending_user', 'started'].includes(normalized)) return 'USER_ACTION_REQUIRED';
  return 'PENDING';
}

function resolvePath(template: string, sessionId?: string): string {
  if (template.includes('{sessionId}')) {
    if (!sessionId) throw new TicConfigurationError('TIC session ID is required for this operation');
    return template.replaceAll('{sessionId}', encodeURIComponent(sessionId));
  }
  return template;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TicConfigurationError('TIC base URL is invalid');
  }
  if (url.protocol !== 'https:') throw new TicConfigurationError('TIC base URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new TicConfigurationError('TIC base URL must not contain credentials, query or fragment');
  return url.toString().replace(/\/$/, '');
}

function safeProviderErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = (payload as Record<string, unknown>).code ?? (payload as Record<string, unknown>).errorCode;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : null;
}

export class TicBankIdProvider implements ElectronicIdentityProvider {
  private readonly baseUrl: string;
  private readonly paths: TicPaths;

  constructor(
    private readonly config: TicBankIdConfig,
    private readonly evidenceVerifier: TicEvidenceVerifier = new RejectingTicEvidenceVerifier(),
    private readonly http: typeof fetch = fetch,
  ) {
    this.baseUrl = validateBaseUrl(config.baseUrl);
    if (!config.apiKey.trim()) throw new TicConfigurationError('TIC API key is required');
    this.paths = { ...DEFAULT_TIC_PATHS, ...config.paths };
  }

  async startSignature(input: StartIdentitySignature): Promise<IdentitySession> {
    const body = {
      endUserIp: input.endUserIp,
      userAgent: input.userAgent,
      userVisibleData: input.visibleText,
      userVisibleDataFormat: 'simpleMarkdownV1',
      userNonVisibleData: base64Encode(bankIdEvidenceBytes(input)),
      ...(input.expectedSubject ? { personalNumber: input.expectedSubject } : {}),
      state: input.state,
      callbackUrl: this.config.callbackUrl,
      webhookUrl: this.config.webhookUrl,
    };
    const response = await this.request<TicStartResponse>('POST', resolvePath(this.paths.start), body);
    const providerReference = response.sessionId ?? response.orderRef;
    if (!providerReference) throw new TicProtocolError('TIC start response did not contain a session reference');
    return {
      id: response.sessionId ?? providerReference,
      provider: 'TIC_BANKID',
      providerReference,
      status: mapStatus(response.status),
      ...(response.autoStartToken ? { autoStartToken: response.autoStartToken } : {}),
      ...(response.qrStartToken ? { qrStartToken: response.qrStartToken } : {}),
      ...(response.qrStartSecret ? { qrStartSecret: response.qrStartSecret } : {}),
      ...(response.subscriptionToken ? { subscriptionToken: response.subscriptionToken } : {}),
      ...(response.orderRef ? { orderReference: response.orderRef } : {}),
      expiresAt: response.sessionExpiresAt ?? response.expiresAt ?? input.expiresAt,
    };
  }

  async getStatus(sessionId: string): Promise<IdentityStatus> {
    const result = await this.request<Record<string, unknown>>('POST', resolvePath(this.paths.status, sessionId));
    return mapStatus(result.status);
  }

  async collectEvidence(sessionId: string): Promise<IdentityEvidence> {
    const rawPayload = await this.request<Record<string, unknown>>('GET', resolvePath(this.paths.collect, sessionId));
    const returnedSessionId = rawPayload.sessionId;
    if (typeof returnedSessionId === 'string' && returnedSessionId !== sessionId) {
      throw new TicProtocolError('TIC collect response session did not match the requested session');
    }
    return { provider: 'TIC_BANKID', providerReference: sessionId, rawPayload, collectedAt: new Date().toISOString() };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request('DELETE', resolvePath(this.paths.cancel, sessionId));
  }

  async verifyEvidence(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence> {
    if (evidence.provider !== 'TIC_BANKID') throw new TicProtocolError('Wrong provider evidence');
    return this.evidenceVerifier.verify(evidence);
  }

  private async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': this.config.apiKey };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.http(`${this.baseUrl}/${path.replace(/^\//, '')}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = undefined;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new TicProtocolError('TIC returned a non-JSON response');
        }
      }
      if (!response.ok) {
        const code = safeProviderErrorCode(payload);
        throw new TicProtocolError(`TIC request failed with HTTP ${response.status}${code ? ` (${code})` : ''}`);
      }
      return payload as T;
    } catch (cause) {
      if (cause instanceof TicProtocolError) throw cause;
      if (cause instanceof Error && cause.name === 'AbortError') throw new TicProtocolError('TIC request timed out');
      throw new TicProtocolError('TIC request failed');
    } finally {
      clearTimeout(timeout);
    }
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

export interface TicWebhookEnvelope {
  readonly event: string;
  readonly sessionId: string;
  readonly state?: string;
  readonly status?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function parseTicWebhookEnvelope(rawBody: Uint8Array): TicWebhookEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    throw new TicProtocolError('TIC webhook payload is not valid UTF-8 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TicProtocolError('TIC webhook payload must be an object');
  const payload = parsed as Record<string, unknown>;
  const nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  const event = payload.event ?? payload.type;
  const sessionId = nested.sessionId ?? payload.sessionId;
  if (typeof event !== 'string' || !event) throw new TicProtocolError('TIC webhook event is missing');
  if (typeof sessionId !== 'string' || !sessionId) throw new TicProtocolError('TIC webhook session ID is missing');
  return {
    event,
    sessionId,
    ...(typeof nested.state === 'string' ? { state: nested.state } : {}),
    ...(typeof nested.status === 'string' ? { status: nested.status } : {}),
    payload,
  };
}

export function assertTicWebhookBinding(
  envelope: TicWebhookEnvelope,
  expected: { readonly sessionId: string; readonly state: string },
): void {
  if (envelope.sessionId !== expected.sessionId) throw new TicProtocolError('TIC webhook session mismatch');
  if (envelope.state !== expected.state) throw new TicProtocolError('TIC webhook state mismatch');
}
