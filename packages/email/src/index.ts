export type NormalizedEmailStatus = 'accepted' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed';

export interface EmailAddress { readonly email: string; readonly name?: string; }
export interface EmailMessage {
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly replyTo?: EmailAddress;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly tags?: Readonly<Record<string, string>>;
}
export interface EmailSendResult {
  readonly provider: string;
  readonly providerMessageId: string;
  readonly status: 'accepted';
  readonly acceptedAt: string;
}
export interface RawEmailWebhook {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly receivedAt: string;
}
export interface NormalizedEmailEvent {
  readonly provider: string;
  readonly eventId: string;
  readonly providerMessageId: string;
  readonly status: NormalizedEmailStatus;
  readonly occurredAt: string;
  readonly recipient?: string;
  readonly permanent: boolean;
  readonly payloadSha256: string;
}
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
  verifyWebhook(input: RawEmailWebhook): Promise<NormalizedEmailEvent>;
}
export interface SmtpTransport {
  send(message: EmailMessage): Promise<{ readonly messageId: string }>;
}
