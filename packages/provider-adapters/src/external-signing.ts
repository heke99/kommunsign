import { sha256Hex } from '../../crypto/src/hash.js';

export type ExternalSigningProviderName = 'INLEED_DOCSIGN';
export type ExternalSigningStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface ExternalSigningStartInput {
  readonly idempotencyKey: string;
  readonly callbackUrl: string;
  readonly signerReference: string;
  readonly documentName: string;
  readonly documentBytes: Uint8Array;
  readonly documentSha256: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface ExternalSigningStartResult { readonly providerReference: string; readonly status: ExternalSigningStatus; readonly redirectUrl?: string; }
export interface ExternalSigningStatusResult { readonly providerReference: string; readonly status: ExternalSigningStatus; readonly providerCompletedAt?: string; }
export interface ExternalSigningArtifact { readonly bytes: Uint8Array; readonly contentType: 'application/pdf'; readonly sha256: string; }
export interface ExternalSigningProvider {
  readonly name: ExternalSigningProviderName;
  start(input: ExternalSigningStartInput): Promise<ExternalSigningStartResult>;
  status(providerReference: string): Promise<ExternalSigningStatusResult>;
  fetchFinalArtifact(providerReference: string): Promise<ExternalSigningArtifact>;
}
export interface ConfiguredJsonSigningProviderOptions {
  readonly baseUrl: string;
  readonly apiCredential: string;
  readonly createPath: string;
  readonly statusPathTemplate: string;
  readonly artifactPathTemplate: string;
  readonly requestTimeoutMs?: number;
}

/**
 * Production-safe adapter whose endpoint contract is supplied by deployment
 * configuration. Paths are deliberately not guessed in source. Provider
 * callbacks are advisory only: finality requires status() plus a server-side
 * fetchFinalArtifact() and local validation by the signing worker.
 */
export class ConfiguredJsonExternalSigningProvider implements ExternalSigningProvider {
  readonly name = 'INLEED_DOCSIGN' as const;
  readonly #baseUrl: URL;
  readonly #credential: string;
  readonly #createPath: string;
  readonly #statusPathTemplate: string;
  readonly #artifactPathTemplate: string;
  readonly #requestTimeoutMs: number;

  constructor(options: ConfiguredJsonSigningProviderOptions) {
    this.#baseUrl = assertHttpsBaseUrl(options.baseUrl);
    this.#credential = requireSecret(options.apiCredential);
    this.#createPath = assertRelativePath(options.createPath);
    this.#statusPathTemplate = assertReferenceTemplate(options.statusPathTemplate);
    this.#artifactPathTemplate = assertReferenceTemplate(options.artifactPathTemplate);
    this.#requestTimeoutMs = boundedTimeout(options.requestTimeoutMs ?? 10_000);
  }

  async start(input: ExternalSigningStartInput): Promise<ExternalSigningStartResult> {
    if (!/^[0-9a-f]{64}$/.test(input.documentSha256)) throw new Error('EXTERNAL_SIGNING_DOCUMENT_SHA_INVALID');
    if (await sha256Hex(input.documentBytes) !== input.documentSha256) throw new Error('EXTERNAL_SIGNING_DOCUMENT_HASH_MISMATCH');
    const body = {
      idempotencyKey: input.idempotencyKey,
      callbackUrl: assertHttpsUrl(input.callbackUrl).toString(),
      signerReference: input.signerReference,
      documentName: input.documentName,
      documentBase64: bytesToBase64(input.documentBytes),
      documentSha256: input.documentSha256,
      metadata: input.metadata,
    };
    return parseStart(await this.#json(this.#createPath, { method: 'POST', body: JSON.stringify(body) }));
  }

  async status(providerReference: string): Promise<ExternalSigningStatusResult> {
    return parseStatus(providerReference, await this.#json(resolveReferencePath(this.#statusPathTemplate, providerReference), { method: 'GET' }));
  }

  async fetchFinalArtifact(providerReference: string): Promise<ExternalSigningArtifact> {
    const response = await this.#request(resolveReferencePath(this.#artifactPathTemplate, providerReference), { method: 'GET' });
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/pdf') throw new Error('EXTERNAL_SIGNING_ARTIFACT_CONTENT_TYPE_INVALID');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('EXTERNAL_SIGNING_ARTIFACT_NOT_PDF');
    return { bytes, contentType: 'application/pdf', sha256: await sha256Hex(bytes) };
  }

  async #json(path: string, init: RequestInit): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#request(path, init);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new Error('EXTERNAL_SIGNING_PROVIDER_RESPONSE_INVALID');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EXTERNAL_SIGNING_PROVIDER_RESPONSE_INVALID');
    return value as Readonly<Record<string, unknown>>;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await fetch(new URL(path, this.#baseUrl), {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: init.method === 'GET' ? 'application/pdf, application/json' : 'application/json',
          authorization: `Bearer ${this.#credential}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) throw new Error(response.status >= 500 ? 'EXTERNAL_SIGNING_PROVIDER_UNAVAILABLE' : 'EXTERNAL_SIGNING_PROVIDER_REJECTED');
      return response;
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw new Error('EXTERNAL_SIGNING_PROVIDER_TIMEOUT');
      throw cause;
    } finally { clearTimeout(timeout); }
  }
}

function parseStart(value: Readonly<Record<string, unknown>>): ExternalSigningStartResult {
  const providerReference = requiredString(value.providerReference, 'EXTERNAL_SIGNING_PROVIDER_REFERENCE_INVALID');
  const status = normalizedStatus(value.status);
  const redirectUrl = value.redirectUrl === undefined ? undefined : assertHttpsUrl(requiredString(value.redirectUrl, 'EXTERNAL_SIGNING_REDIRECT_INVALID')).toString();
  return { providerReference, status, ...(redirectUrl ? { redirectUrl } : {}) };
}
function parseStatus(providerReference: string, value: Readonly<Record<string, unknown>>): ExternalSigningStatusResult {
  const status = normalizedStatus(value.status);
  const providerCompletedAt = value.providerCompletedAt === undefined ? undefined : validIsoTime(requiredString(value.providerCompletedAt, 'EXTERNAL_SIGNING_COMPLETED_AT_INVALID'));
  return { providerReference, status, ...(providerCompletedAt ? { providerCompletedAt } : {}) };
}
function normalizedStatus(value: unknown): ExternalSigningStatus {
  if (typeof value !== 'string') throw new Error('EXTERNAL_SIGNING_STATUS_INVALID');
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'expired') return normalized;
  throw new Error('EXTERNAL_SIGNING_STATUS_INVALID');
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}
function validIsoTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error('EXTERNAL_SIGNING_COMPLETED_AT_INVALID');
  return date.toISOString();
}
function assertHttpsBaseUrl(value: string): URL {
  const url = assertHttpsUrl(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('EXTERNAL_SIGNING_BASE_URL_INVALID');
  return url;
}
function assertHttpsUrl(value: string): URL { const url = new URL(value); if (url.protocol !== 'https:') throw new Error('EXTERNAL_SIGNING_HTTPS_REQUIRED'); return url; }
function assertRelativePath(value: string): string { if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) throw new Error('EXTERNAL_SIGNING_PATH_INVALID'); return value; }
function assertReferenceTemplate(value: string): string { const path = assertRelativePath(value); if ((path.match(/\{reference\}/g) ?? []).length !== 1) throw new Error('EXTERNAL_SIGNING_PATH_TEMPLATE_INVALID'); return path; }
function resolveReferencePath(template: string, reference: string): string { const clean = requiredString(reference, 'EXTERNAL_SIGNING_PROVIDER_REFERENCE_INVALID'); if (clean.length > 300) throw new Error('EXTERNAL_SIGNING_PROVIDER_REFERENCE_INVALID'); return template.replace('{reference}', encodeURIComponent(clean)); }
function requireSecret(value: string): string { if (value.trim().length < 8) throw new Error('EXTERNAL_SIGNING_CREDENTIAL_INVALID'); return value; }
function boundedTimeout(value: number): number { if (!Number.isInteger(value) || value < 1_000 || value > 30_000) throw new Error('EXTERNAL_SIGNING_TIMEOUT_INVALID'); return value; }
function requiredString(value: unknown, code: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(code); return value.trim(); }
