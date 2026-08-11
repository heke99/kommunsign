import { inspectPdfBytes, validatePdfUploadMetadata } from './index.js';
import { planOfficeIngestion } from './office-ingestion.js';

export interface OfficePdfAConversionResult {
  readonly bytes: Uint8Array;
  readonly sourceFormat: string;
  readonly sourceMimeType: string;
  readonly sourceFileName: string;
  readonly engine: 'Gotenberg/LibreOffice';
  readonly engineVersion: string;
  readonly profile: 'PDF/A-2b';
}

export class GotenbergOfficePdfAClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 120_000,
    private readonly http: typeof fetch = fetch,
  ) {
    this.baseUrl = internalBaseUrl(baseUrl, 'GOTENBERG_URL');
  }

  async convertToPdfA2b(input: {
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly mimeType: string;
    readonly traceId: string;
  }): Promise<OfficePdfAConversionResult> {
    const sourceMimeType = input.mimeType.toLowerCase().split(';', 1)[0]!.trim();
    const plan = planOfficeIngestion({ fileName: input.fileName, mimeType: sourceMimeType, byteSize: input.bytes.byteLength });
    const form = new FormData();
    form.append('files', new Blob([input.bytes], { type: sourceMimeType }), safeFileName(input.fileName));
    form.append('pdfa', 'PDF/A-2b');
    form.append('pdfua', 'false');
    form.append('exportFormFields', 'false');
    form.append('updateIndexes', 'true');
    form.append('exportBookmarks', 'true');
    form.append('exportHiddenSlides', 'false');
    form.append('skipEmptyPages', 'false');

    const response = await timedFetch(
      this.http,
      `${this.baseUrl}/forms/libreoffice/convert`,
      { method: 'POST', headers: { 'Gotenberg-Trace': input.traceId }, body: form },
      this.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(response.status >= 500 ? 'DOCUMENT_OFFICE_CONVERSION_TEMPORARY_FAILURE' : 'DOCUMENT_OFFICE_CONVERSION_FAILED');
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/pdf') throw new Error('DOCUMENT_OFFICE_CONVERSION_PROTOCOL_ERROR');
    const bytes = new Uint8Array(await response.arrayBuffer());
    validatePdfUploadMetadata({
      fileName: 'canonical.pdf', mimeType: 'application/pdf', byteSize: bytes.byteLength,
      policy: { maximumBytes: 100 * 1024 * 1024, maximumPages: 500 },
    });
    if (!(await inspectPdfBytes(bytes)).accepted) throw new Error('DOCUMENT_OFFICE_CONVERSION_PROTOCOL_ERROR');
    const engineVersion = cleanVersion(response.headers.get('gotenberg-version') ?? 'unknown');
    return {
      bytes,
      sourceFormat: plan.sourceFormat,
      sourceMimeType,
      sourceFileName: input.fileName,
      engine: 'Gotenberg/LibreOffice',
      engineVersion,
      profile: 'PDF/A-2b',
    };
  }
}

function internalBaseUrl(raw: string, name: string): string {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error(`${name}_INVALID`);
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') throw new Error(`${name}_INVALID`);
  return parsed.toString().replace(/\/$/, '');
}

async function timedFetch(http: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await http(url, { ...init, signal: controller.signal }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('DOCUMENT_SERVICE_TIMEOUT');
    throw new Error('DOCUMENT_SERVICE_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/\0\r\n]/g, '_').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('DOCUMENT_OFFICE_FILE_NAME_INVALID');
  return cleaned;
}

function cleanVersion(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, ' ').trim().slice(0, 200) || 'unknown';
}
