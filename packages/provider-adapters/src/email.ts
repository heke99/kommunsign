import type { EmailMessage, EmailProvider, EmailSendResult, NormalizedEmailEvent, RawEmailWebhook, SmtpTransport } from '../../email/src/index.js';
import { base64UrlEncode } from '../../crypto/src/base64.js';
import { sha256Hex } from '../../crypto/src/hash.js';

export interface ResendEmailConfig {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly baseUrl?: string;
  readonly webhookMaximumAgeSeconds?: number;
}

export class EmailProviderError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); this.name = 'EmailProviderError'; }
}

export class ResendEmailProvider implements EmailProvider {
  private readonly baseUrl: string;
  constructor(private readonly config: ResendEmailConfig, private readonly http: typeof fetch = fetch) {
    if (!config.apiKey.trim()) throw new EmailProviderError('EMAIL_PROVIDER_NOT_CONFIGURED', false);
    if (!config.webhookSecret.trim()) throw new EmailProviderError('EMAIL_PROVIDER_NOT_CONFIGURED', false);
    this.baseUrl = validateHttpsBaseUrl(config.baseUrl ?? 'https://api.resend.com');
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    assertMessage(message);
    const response = await this.http(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: formatAddress(message.from), to: message.to.map(formatAddress),
        ...(message.replyTo ? { reply_to: formatAddress(message.replyTo) } : {}),
        subject: message.subject, html: message.html, text: message.text,
        ...(message.tags ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}),
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new EmailProviderError(response.status === 429 || response.status >= 500 ? 'EMAIL_TEMPORARY_FAILURE' : 'EMAIL_PERMANENT_FAILURE', response.status === 429 || response.status >= 500);
    const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : null;
    if (typeof id !== 'string' || !id) throw new EmailProviderError('EMAIL_PROVIDER_PROTOCOL_ERROR', true);
    return { provider: 'resend', providerMessageId: id, status: 'accepted', acceptedAt: new Date().toISOString() };
  }

  async verifyWebhook(input: RawEmailWebhook): Promise<NormalizedEmailEvent> {
    const id = requiredHeader(input.headers, 'svix-id');
    const timestamp = requiredHeader(input.headers, 'svix-timestamp');
    const signature = requiredHeader(input.headers, 'svix-signature');
    const timestampNumber = Number(timestamp);
    if (!Number.isSafeInteger(timestampNumber)) throw new EmailProviderError('EMAIL_WEBHOOK_SIGNATURE_INVALID', false);
    const now = Math.floor(new Date(input.receivedAt).getTime() / 1000);
    if (Math.abs(now - timestampNumber) > (this.config.webhookMaximumAgeSeconds ?? 300)) throw new EmailProviderError('EMAIL_WEBHOOK_REPLAYED', false);
    const signedContent = joinBytes(new TextEncoder().encode(`${id}.${timestamp}.`), input.rawBody);
    const secret = decodeSvixSecret(this.config.webhookSecret);
    const expected = await hmacSha256Base64(secret, signedContent);
    const candidates = signature.split(' ').map((part) => part.includes(',') ? part.slice(part.indexOf(',') + 1) : part).filter(Boolean);
    if (!candidates.some((candidate) => constantTimeStringEqual(candidate, expected))) throw new EmailProviderError('EMAIL_WEBHOOK_SIGNATURE_INVALID', false);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody)); }
    catch { throw new EmailProviderError('EMAIL_WEBHOOK_PAYLOAD_INVALID', false); }
    if (!parsed || typeof parsed !== 'object') throw new EmailProviderError('EMAIL_WEBHOOK_PAYLOAD_INVALID', false);
    const object = parsed as Record<string, unknown>;
    const data = object.data && typeof object.data === 'object' ? object.data as Record<string, unknown> : {};
    const eventType = typeof object.type === 'string' ? object.type : '';
    const status = mapResendStatus(eventType);
    const email = data.email_id ?? data.emailId ?? data.id;
    if (typeof email !== 'string' || !email) throw new EmailProviderError('EMAIL_WEBHOOK_PAYLOAD_INVALID', false);
    const createdAt = typeof object.created_at === 'string' ? object.created_at : input.receivedAt;
    const recipient = Array.isArray(data.to) && typeof data.to[0] === 'string' ? data.to[0] : undefined;
    return {
      provider: 'resend', eventId: id, providerMessageId: email, status,
      occurredAt: createdAt, ...(recipient ? { recipient } : {}),
      permanent: status === 'bounced' || status === 'complained' || status === 'failed',
      payloadSha256: await sha256Hex(input.rawBody),
    };
  }
}

export class DevelopmentEmailProvider implements EmailProvider {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<EmailSendResult> {
    assertMessage(message); this.messages.push(message);
    return { provider: 'development', providerMessageId: `dev-${await sha256Hex(message.idempotencyKey)}`, status: 'accepted', acceptedAt: new Date().toISOString() };
  }
  async verifyWebhook(): Promise<NormalizedEmailEvent> { throw new EmailProviderError('DEVELOPMENT_WEBHOOK_UNSUPPORTED', false); }
}

export class SmtpEmailProvider implements EmailProvider {
  constructor(private readonly transport: SmtpTransport) {}
  async send(message: EmailMessage): Promise<EmailSendResult> {
    assertMessage(message); const result = await this.transport.send(message);
    return { provider: 'smtp', providerMessageId: result.messageId, status: 'accepted', acceptedAt: new Date().toISOString() };
  }
  async verifyWebhook(): Promise<NormalizedEmailEvent> { throw new EmailProviderError('SMTP_WEBHOOK_NOT_CONFIGURED', false); }
}

function mapResendStatus(type: string): NormalizedEmailEvent['status'] {
  const mapping: Readonly<Record<string, NormalizedEmailEvent['status']>> = {
    'email.sent': 'accepted', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed',
    'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed', 'email.suppressed': 'failed',
  };
  const result = mapping[type];
  if (!result) throw new EmailProviderError('EMAIL_WEBHOOK_EVENT_UNSUPPORTED', false);
  return result;
}
function assertMessage(message: EmailMessage): void {
  if (!message.idempotencyKey || message.idempotencyKey.length > 256) throw new EmailProviderError('EMAIL_IDEMPOTENCY_KEY_INVALID', false);
  if (!message.to.length || !message.subject.trim() || !message.text.trim() || !message.html.trim()) throw new EmailProviderError('EMAIL_MESSAGE_INVALID', false);
  for (const address of [message.from, ...message.to, ...(message.replyTo ? [message.replyTo] : [])]) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.email)) throw new EmailProviderError('EMAIL_ADDRESS_INVALID', false);
}
function formatAddress(address: { readonly email: string; readonly name?: string }): string { return address.name ? `${address.name.replace(/[<>\r\n]/g, '')} <${address.email}>` : address.email; }
function validateHttpsBaseUrl(raw: string): string { const parsed = new URL(raw); if (parsed.protocol !== 'https:') throw new EmailProviderError('EMAIL_PROVIDER_URL_INVALID', false); return parsed.toString().replace(/\/$/, ''); }
function requiredHeader(headers: Readonly<Record<string, string | undefined>>, name: string): string { const value = headers[name] ?? headers[name.toLowerCase()]; if (!value) throw new EmailProviderError('EMAIL_WEBHOOK_SIGNATURE_INVALID', false); return value; }
function decodeSvixSecret(secret: string): Uint8Array { const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret; try { return decodeBase64(raw); } catch { return new TextEncoder().encode(secret); } }
function decodeBase64(value: string): Uint8Array { const normalized = value.replace(/-/g, '+').replace(/_/g, '/'); const binary = atob(normalized); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
async function hmacSha256Base64(secret: Uint8Array, payload: Uint8Array): Promise<string> { const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, payload))).replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '='); }
function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array { const result = new Uint8Array(left.length + right.length); result.set(left); result.set(right, left.length); return result; }
function constantTimeStringEqual(left: string, right: string): boolean { let diff = left.length ^ right.length; const length = Math.max(left.length, right.length); for (let index = 0; index < length; index += 1) diff |= (left.charCodeAt(index % Math.max(left.length, 1)) || 0) ^ (right.charCodeAt(index % Math.max(right.length, 1)) || 0); return diff === 0; }
async function safeJson(response: Response): Promise<unknown> { const text = await response.text(); if (!text) return null; try { return JSON.parse(text); } catch { return null; } }
