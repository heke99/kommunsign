export const KOMMUNSIGN_OPENAPI_VERSION = '2026-08-03.2';

export interface KommunSignClientOptions {
  readonly baseUrl: string;
  readonly accessToken: () => Promise<string> | string;
  readonly fetch?: typeof globalThis.fetch;
}

export class KommunSignApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message); this.name = 'KommunSignApiError';
  }
}

export class KommunSignClient {
  readonly #baseUrl: string;
  readonly #accessToken: KommunSignClientOptions['accessToken'];
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: KommunSignClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  listSignatureCases(limit = 50, cursor?: string) { return this.#request('GET', `/signature-cases?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); }
  getSignatureCase(id: string) { return this.#request('GET', `/signature-cases/${encodeURIComponent(id)}`); }
  createSignatureCase(input: unknown, idempotencyKey: string) { return this.#request('POST', '/signature-cases', input, idempotencyKey); }
  addDocument(id: string, input: unknown, idempotencyKey: string) { return this.#request('POST', `/signature-cases/${encodeURIComponent(id)}/documents`, input, idempotencyKey); }
  addSigner(id: string, input: unknown, idempotencyKey: string) { return this.#request('POST', `/signature-cases/${encodeURIComponent(id)}/signers`, input, idempotencyKey); }
  updateSigner(id: string, signerId: string, input: unknown, idempotencyKey: string, version?: number) { return this.#request('PATCH', `/signature-cases/${encodeURIComponent(id)}/signers/${encodeURIComponent(signerId)}`, input, idempotencyKey, version); }
  sendSignatureCase(id: string, idempotencyKey: string, version?: number) { return this.#request('POST', `/signature-cases/${encodeURIComponent(id)}/send`, undefined, idempotencyKey, version); }
  cancelSignatureCase(id: string, idempotencyKey: string, version?: number) { return this.#request('POST', `/signature-cases/${encodeURIComponent(id)}/cancel`, undefined, idempotencyKey, version); }
  remindSigners(id: string, idempotencyKey: string) { return this.#request('POST', `/signature-cases/${encodeURIComponent(id)}/remind`, undefined, idempotencyKey); }
  createUpload(input: unknown, idempotencyKey: string) { return this.#request('POST', '/uploads', input, idempotencyKey); }
  completeUpload(uploadId: string, sha256: string, idempotencyKey: string) { return this.#request('POST', `/uploads/${encodeURIComponent(uploadId)}/complete`, { sha256 }, idempotencyKey); }
  createWebhookEndpoint(input: unknown, idempotencyKey: string) { return this.#request('POST', '/webhook-endpoints', input, idempotencyKey); }
  listEvents(limit = 50) { return this.#request('GET', `/events?limit=${limit}`); }
  listTemplates(limit = 50) { return this.#request('GET', `/templates?limit=${limit}`); }
  createTemplate(input: unknown, idempotencyKey: string) { return this.#request('POST', '/templates', input, idempotencyKey); }
  downloadEvidencePackage(id: string) { return this.download(`/signature-cases/${encodeURIComponent(id)}/evidence-package`); }
  downloadValidationReport(id: string) { return this.download(`/signature-cases/${encodeURIComponent(id)}/validation-report`); }
  async download(path: string): Promise<Uint8Array> {
    const response = await this.#raw('GET', path);
    if (!response.ok) await this.#throw(response);
    return new Uint8Array(await response.arrayBuffer());
  }
  async #request(method: string, path: string, body?: unknown, idempotencyKey?: string, version?: number): Promise<unknown> {
    const response = await this.#raw(method, path, body, idempotencyKey, version);
    if (!response.ok) await this.#throw(response);
    return response.status === 204 ? undefined : response.json();
  }
  async #raw(method: string, path: string, body?: unknown, idempotencyKey?: string, version?: number): Promise<Response> {
    const token = await this.#accessToken();
    return this.#fetch(`${this.#baseUrl}${path}`, { method, headers: {
      authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'content-type':'application/json'}),
      ...(idempotencyKey ? {'idempotency-key':idempotencyKey} : {}), ...(version ? {'if-match':String(version)} : {}),
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
  }
  async #throw(response: Response): Promise<never> {
    const payload = await response.json().catch(() => ({error:{code:'HTTP_ERROR',message:`HTTP ${response.status}`}}));
    throw new KommunSignApiError(response.status, payload.error?.code ?? 'HTTP_ERROR', payload.error?.message ?? `HTTP ${response.status}`, payload.error?.requestId);
  }
}
