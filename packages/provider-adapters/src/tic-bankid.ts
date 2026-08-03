import type {
  ElectronicIdentityProvider, IdentityEvidence, IdentitySession, IdentityStatus,
  StartIdentitySignature, VerifiedIdentityEvidence,
} from '../../contracts/src/index.js';
import { hmacSha256Hex, verifyHmacSha256Hex } from '../../crypto/src/hmac.js';
import { sha256Hex } from '../../crypto/src/hash.js';
import { bankIdEvidenceText } from './evidence-payload.js';
import type { TicEvidenceValidationRequest, TicEvidenceValidationReport } from '../../validation-client/src/index.js';

export interface TicPaths {
  readonly start: string; readonly status: string; readonly collect: string; readonly cancel: string; readonly extend: string;
}
const DEFAULT_TIC_PATHS: TicPaths = {
  start: '/auth/bankid/sign', status: '/auth/{sessionId}/poll', collect: '/auth/{sessionId}/collect', cancel: '/auth/{sessionId}', extend: '/auth/{sessionId}/extend',
};
export interface TicBankIdConfig {
  readonly baseUrl: string; readonly apiKey: string; readonly callbackUrl: string; readonly webhookUrl: string;
  readonly paths?: Partial<TicPaths>; readonly timeoutMs?: number;
}
interface TicStartResponse {
  readonly sessionId?: string; readonly orderRef?: string; readonly autoStartToken?: string; readonly qrStartToken?: string;
  readonly qrStartSecret?: string; readonly subscriptionToken?: string; readonly sessionExpiresAt?: string; readonly expiresAt?: string;
  readonly status?: string; readonly [key: string]: unknown;
}
export class TicConfigurationError extends Error { constructor(message: string) { super(message); this.name = 'TicConfigurationError'; } }
export class TicProtocolError extends Error { constructor(message: string) { super(message); this.name = 'TicProtocolError'; } }
export class TicRateLimitError extends TicProtocolError { constructor(readonly retryAfterSeconds?: number) { super('TIC_RATE_LIMITED'); this.name = 'TicRateLimitError'; } }

export interface TicEvidenceVerifier { verify(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence>; }
export class RejectingTicEvidenceVerifier implements TicEvidenceVerifier {
  async verify(): Promise<VerifiedIdentityEvidence> { throw new TicConfigurationError('Independent BankID XML-DSig and OCSP verifier is not configured'); }
}
export interface ExpectedTicEvidence {
  readonly visibleData: string; readonly nonVisibleData: string; readonly expectedPersonalNumber?: string; readonly policyVersion: string;
}
export interface TicValidationService { validateTicEvidence(input: TicEvidenceValidationRequest): Promise<TicEvidenceValidationReport>; }
export class ValidationServiceTicEvidenceVerifier implements TicEvidenceVerifier {
  constructor(private readonly validation: TicValidationService, private readonly expected: (providerReference: string) => Promise<ExpectedTicEvidence>) {}
  async verify(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence> {
    if (evidence.provider !== 'TIC_BANKID') throw new TicProtocolError('Wrong provider evidence');
    const collect = asObject(evidence.rawPayload, 'TIC collect payload');
    const signature = asObject(collect.signature, 'TIC signature');
    const signatureXmlBase64 = requiredString(signature.value, 'TIC signature value');
    const ocspResponseBase64 = requiredString(signature.ocspResponse, 'TIC OCSP response');
    const expected = await this.expected(evidence.providerReference);
    const report = await this.validation.validateTicEvidence({
      signatureXmlBase64, ocspResponseBase64, expectedVisibleData: expected.visibleData,
      expectedNonVisibleData: expected.nonVisibleData, ...(expected.expectedPersonalNumber ? { expectedPersonalNumber: expected.expectedPersonalNumber } : {}),
      policyVersion: expected.policyVersion,
    });
    if (report.result !== 'PASS' || report.checks.some((check) => !check.passed)) throw new TicProtocolError('TIC_EVIDENCE_INVALID');
    const personalNumber = report.personalNumber;
    if (!personalNumber) throw new TicProtocolError('TIC_EVIDENCE_IDENTITY_MISSING');
    return {
      provider: 'TIC_BANKID', providerReference: evidence.providerReference, subject: personalNumber, personalNumber,
      ...(report.displayName ? { displayName: report.displayName } : {}), assuranceLevel: 'HIGH',
      signedPayloadSha256: report.nonVisibleDataSha256, visibleDataSha256: report.visibleDataSha256,
      signatureXmlSha256: report.signatureXmlSha256, ocspSha256: report.ocspSha256,
      verificationChecks: report.checks, verifiedAt: report.verifiedAt, originalEvidence: evidence,
    };
  }
}

export function mapTicStatus(value: unknown): IdentityStatus {
  if (typeof value !== 'string') return 'PENDING';
  const normalized = value.toLowerCase();
  if (['complete', 'completed', 'done', 'success'].includes(normalized)) return 'COMPLETED';
  if (['cancelled', 'canceled'].includes(normalized)) return 'CANCELLED';
  if (normalized === 'expired') return 'EXPIRED';
  if (['failed', 'error'].includes(normalized)) return 'FAILED';
  if (['user_action_required', 'outstandingtransaction', 'pending_user', 'started'].includes(normalized)) return 'USER_ACTION_REQUIRED';
  return 'PENDING';
}
function resolvePath(template: string, sessionId?: string): string { if (template.includes('{sessionId}')) { if (!sessionId) throw new TicConfigurationError('TIC session ID is required'); return template.replaceAll('{sessionId}', encodeURIComponent(sessionId)); } return template; }
function validateHttpsUrl(value: string, label: string): string { let url: URL; try { url = new URL(value); } catch { throw new TicConfigurationError(`${label} is invalid`); } if (url.protocol !== 'https:') throw new TicConfigurationError(`${label} must use HTTPS`); if (url.username || url.password || url.hash) throw new TicConfigurationError(`${label} contains forbidden components`); return url.toString().replace(/\/$/, ''); }
function safeProviderErrorCode(payload: unknown): string | null { if (!payload || typeof payload !== 'object') return null; const candidate = (payload as Record<string, unknown>).code ?? (payload as Record<string, unknown>).errorCode; return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : null; }

export class TicBankIdProvider implements ElectronicIdentityProvider {
  private readonly baseUrl: string; private readonly callbackUrl: string; private readonly webhookUrl: string; private readonly paths: TicPaths;
  constructor(private readonly config: TicBankIdConfig, private readonly evidenceVerifier: TicEvidenceVerifier = new RejectingTicEvidenceVerifier(), private readonly http: typeof fetch = fetch) {
    this.baseUrl = validateHttpsUrl(config.baseUrl, 'TIC base URL'); this.callbackUrl = validateHttpsUrl(config.callbackUrl, 'TIC callback URL'); this.webhookUrl = validateHttpsUrl(config.webhookUrl, 'TIC webhook URL');
    if (!config.apiKey.trim()) throw new TicConfigurationError('TIC API key is required'); this.paths = { ...DEFAULT_TIC_PATHS, ...config.paths };
  }
  async startSignature(input: StartIdentitySignature): Promise<IdentitySession> {
    const body = {
      endUserIp: input.endUserIp, userAgent: input.userAgent, userVisibleData: input.visibleText,
      userVisibleDataFormat: 'simpleMarkdownV1', userNonVisibleData: bankIdEvidenceText(input),
      ...(input.identifierBindingMode === 'STRICT_PREBOUND' ? { personalNumber: input.expectedPersonalNumber } : {}),
      state: input.state, callbackUrl: this.callbackUrl, webhookUrl: this.webhookUrl,
    };
    const response = await this.request<TicStartResponse>('POST', resolvePath(this.paths.start), body);
    return sessionFromResponse(response, input.expiresAt);
  }
  async getStatus(sessionId: string): Promise<IdentityStatus> { const result = await this.request<Record<string, unknown>>('POST', resolvePath(this.paths.status, sessionId)); return mapTicStatus(result.status); }
  async collectEvidence(sessionId: string): Promise<IdentityEvidence> { const rawPayload = await this.request<Record<string, unknown>>('GET', resolvePath(this.paths.collect, sessionId)); const returned = rawPayload.sessionId; if (typeof returned === 'string' && returned !== sessionId) throw new TicProtocolError('TIC collect response session did not match'); return { provider: 'TIC_BANKID', providerReference: sessionId, rawPayload, collectedAt: new Date().toISOString() }; }
  async cancel(sessionId: string): Promise<void> { await this.request('DELETE', resolvePath(this.paths.cancel, sessionId)); }
  async extend(sessionId: string): Promise<IdentitySession> { const response = await this.request<TicStartResponse>('POST', resolvePath(this.paths.extend, sessionId)); return sessionFromResponse({ ...response, sessionId: response.sessionId ?? sessionId }, response.sessionExpiresAt ?? response.expiresAt ?? new Date(Date.now() + 60_000).toISOString()); }
  async verifyEvidence(evidence: IdentityEvidence): Promise<VerifiedIdentityEvidence> { return this.evidenceVerifier.verify(evidence); }
  async createQrCodeData(qrStartToken: string, qrStartSecret: string, elapsedSeconds: number): Promise<string> {
    if (!/^[A-Za-z0-9._~-]{1,500}$/.test(qrStartToken) || !qrStartSecret || !Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0) throw new TicProtocolError('TIC_QR_INPUT_INVALID');
    const qrAuthCode = await hmacSha256Hex(qrStartSecret, String(elapsedSeconds));
    return `bankid.${qrStartToken}.${elapsedSeconds}.${qrAuthCode}`;
  }
  private async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': this.config.apiKey }; if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.http(`${this.baseUrl}/${path.replace(/^\//, '')}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
      const text = await response.text(); let payload: unknown;
      if (text) { try { payload = JSON.parse(text); } catch { throw new TicProtocolError('TIC returned non-JSON'); } }
      if (response.status === 429) { const retry = Number(response.headers.get('retry-after')); throw new TicRateLimitError(Number.isFinite(retry) ? retry : undefined); }
      if (!response.ok) { const code = safeProviderErrorCode(payload); throw new TicProtocolError(`TIC request failed with HTTP ${response.status}${code ? ` (${code})` : ''}`); }
      return payload as T;
    } catch (cause) { if (cause instanceof TicProtocolError) throw cause; if (cause instanceof Error && cause.name === 'AbortError') throw new TicProtocolError('TIC request timed out'); throw new TicProtocolError('TIC request failed'); }
    finally { clearTimeout(timeout); }
  }
}
function sessionFromResponse(response: TicStartResponse, fallbackExpiry: string): IdentitySession { const providerReference = response.sessionId ?? response.orderRef; if (!providerReference) throw new TicProtocolError('TIC start response did not contain session reference'); return { id: response.sessionId ?? providerReference, provider: 'TIC_BANKID', providerReference, status: mapTicStatus(response.status), ...(response.autoStartToken ? { autoStartToken: response.autoStartToken } : {}), ...(response.qrStartToken ? { qrStartToken: response.qrStartToken } : {}), ...(response.qrStartSecret ? { qrStartSecret: response.qrStartSecret } : {}), ...(response.subscriptionToken ? { subscriptionToken: response.subscriptionToken } : {}), ...(response.orderRef ? { orderReference: response.orderRef } : {}), expiresAt: response.sessionExpiresAt ?? response.expiresAt ?? fallbackExpiry }; }

export interface TicWebhookInput { readonly rawBody: Uint8Array; readonly signature: string; readonly timestamp: string; readonly secret: string; readonly nowEpochSeconds?: number; readonly maximumAgeSeconds?: number; }
/** TIC signs the exact raw body bytes. Timestamp is freshness metadata and is not prepended to the HMAC material. */
export async function verifyTicWebhook(input: TicWebhookInput): Promise<boolean> { const timestamp = Number(input.timestamp); if (!Number.isSafeInteger(timestamp)) return false; const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000); if (Math.abs(now - timestamp) > (input.maximumAgeSeconds ?? 300)) return false; return verifyHmacSha256Hex(input.secret, input.rawBody, input.signature); }
export interface TicWebhookEnvelope { readonly event: string; readonly sessionId: string; readonly state?: string; readonly status?: string; readonly eventId?: string; readonly payloadSha256?: string; readonly payload: Readonly<Record<string, unknown>>; }
export async function parseAndHashTicWebhookEnvelope(rawBody: Uint8Array): Promise<TicWebhookEnvelope> { return { ...parseTicWebhookEnvelope(rawBody), payloadSha256: await sha256Hex(rawBody) }; }
export function parseTicWebhookEnvelope(rawBody: Uint8Array): TicWebhookEnvelope { let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { throw new TicProtocolError('TIC webhook payload is not valid UTF-8 JSON'); } const payload = asObject(parsed, 'TIC webhook payload'); const nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : payload; const event = payload.event ?? payload.type; const sessionId = nested.sessionId ?? payload.sessionId; if (typeof event !== 'string' || !event) throw new TicProtocolError('TIC webhook event missing'); if (typeof sessionId !== 'string' || !sessionId) throw new TicProtocolError('TIC webhook session ID missing'); return { event, sessionId, ...(typeof nested.state === 'string' ? { state: nested.state } : {}), ...(typeof nested.status === 'string' ? { status: nested.status } : {}), ...(typeof payload.id === 'string' ? { eventId: payload.id } : {}), payload }; }
export function assertTicWebhookBinding(envelope: TicWebhookEnvelope, expected: { readonly sessionId: string; readonly state: string }): void { if (envelope.sessionId !== expected.sessionId) throw new TicProtocolError('TIC webhook session mismatch'); if (envelope.state !== expected.state) throw new TicProtocolError('TIC webhook state mismatch'); }
function asObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TicProtocolError(`${label} must be an object`); return value as Record<string, unknown>; }
function requiredString(value: unknown, label: string): string { if (typeof value !== 'string' || !value) throw new TicProtocolError(`${label} is missing`); return value; }
