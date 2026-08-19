import { inspectPdfBytes, validatePdfUploadMetadata, type PdfPolicyFinding } from './index.js';
import { sha256Hex } from '../../crypto/src/hash.js';

export interface MalwareScanReport {
  readonly engine: 'ClamAV';
  readonly engineVersion: string;
  readonly signatureVersion: string;
  readonly result: 'CLEAN' | 'INFECTED';
  readonly finding?: string;
  readonly scannedAt: string;
}
export interface PdfInspectionReport {
  readonly engine: 'qpdf';
  readonly engineVersion: string;
  readonly passed: boolean;
  readonly pageCount: number;
  readonly encrypted: boolean;
  readonly findings: readonly PdfPolicyFinding[];
  readonly outputSha256: string;
}
export interface PdfAValidationReport {
  readonly engine: 'veraPDF';
  readonly engineVersion: string;
  readonly profile: 'PDF/A-2b';
  readonly compliant: boolean;
  readonly rawReport: Uint8Array;
  readonly rawReportContentType: string;
}

interface DynamicSocket {
  write(data: Uint8Array | string): boolean;
  end(): void;
  destroy(error?: Error): void;
  setTimeout(milliseconds: number): void;
  on(event: 'connect' | 'data' | 'end' | 'close' | 'timeout' | 'error', listener: (...args: unknown[]) => void): DynamicSocket;
}
interface NetModule { createConnection(options: { readonly host: string; readonly port: number }): DynamicSocket; }
interface ChildProcessLike {
  readonly stdout: { on(event: 'data', listener: (chunk: Uint8Array) => void): void };
  readonly stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): void };
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(signal?: string): void;
}
interface ChildProcessModule { spawn(command: string, args: readonly string[], options: Readonly<Record<string, unknown>>): ChildProcessLike; }
interface FsPromisesModule {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  rm(path: string, options: { readonly recursive: boolean; readonly force: boolean }): Promise<void>;
}
interface OsModule { tmpdir(): string; }
interface PathModule { join(...parts: readonly string[]): string; }

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

export class ClamAvInstreamClient {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
    private readonly maximumBytes = 100 * 1024 * 1024,
  ) {
    if (!host.trim()) throw new Error('CLAMAV_HOST_MISSING');
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('CLAMAV_PORT_INVALID');
  }

  async scan(bytes: Uint8Array): Promise<MalwareScanReport> {
    if (bytes.byteLength < 5 || bytes.byteLength > this.maximumBytes) throw new Error('DOCUMENT_SIZE_INVALID');
    const response = await this.instream(bytes);
    const version = await this.command('zVERSION\0');
    const match = /^ClamAV\s+([^/\s]+)\/([^/\s]+)\//.exec(version);
    if (response.includes('FOUND')) {
      const finding = response.replace(/^stream:\s*/i, '').replace(/\s+FOUND\s*$/i, '').replace(/[^\x20-\x7E]/g, '').slice(0, 200);
      return { engine: 'ClamAV', engineVersion: match?.[1] ?? 'unknown', signatureVersion: match?.[2] ?? 'unknown', result: 'INFECTED', finding, scannedAt: new Date().toISOString() };
    }
    if (!/stream:\s+OK/i.test(response)) throw new Error('CLAMAV_SCAN_PROTOCOL_ERROR');
    return { engine: 'ClamAV', engineVersion: match?.[1] ?? 'unknown', signatureVersion: match?.[2] ?? 'unknown', result: 'CLEAN', scannedAt: new Date().toISOString() };
  }

  async health(): Promise<{ readonly healthy: boolean; readonly version: string }> {
    const pong = await this.command('zPING\0');
    const version = await this.command('zVERSION\0');
    return { healthy: pong.trim().replace(/\0/g, '') === 'PONG', version: version.replace(/\0/g, '').trim() };
  }

  private async instream(bytes: Uint8Array): Promise<string> {
    const net = await dynamicImport('node:net') as NetModule;
    return new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const response: Uint8Array[] = [];
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(new TextDecoder().decode(join(response)).replace(/\0/g, '').trim());
      };
      socket.setTimeout(this.timeoutMs);
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength));
          const length = new Uint8Array(4);
          new DataView(length.buffer).setUint32(0, chunk.byteLength, false);
          socket.write(length); socket.write(chunk);
        }
        socket.write(new Uint8Array(4));
      });
      socket.on('data', (...args) => { const value = args[0]; if (value instanceof Uint8Array) response.push(value); });
      socket.on('end', () => finish());
      socket.on('close', () => finish());
      socket.on('timeout', () => { socket.destroy(); finish(new Error('CLAMAV_SCAN_TIMEOUT')); });
      socket.on('error', (...args) => finish(args[0] instanceof Error ? args[0] : new Error('CLAMAV_SCAN_FAILED')));
    });
  }

  private async command(command: string): Promise<string> {
    const net = await dynamicImport('node:net') as NetModule;
    return new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const response: Uint8Array[] = [];
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true;
        if (error) reject(error); else resolve(new TextDecoder().decode(join(response)));
      };
      socket.setTimeout(this.timeoutMs);
      socket.on('connect', () => { socket.write(command); });
      socket.on('data', (...args) => { const value = args[0]; if (value instanceof Uint8Array) response.push(value); });
      socket.on('end', () => finish()); socket.on('close', () => finish());
      socket.on('timeout', () => { socket.destroy(); finish(new Error('CLAMAV_COMMAND_TIMEOUT')); });
      socket.on('error', (...args) => finish(args[0] instanceof Error ? args[0] : new Error('CLAMAV_COMMAND_FAILED')));
    });
  }
}

export class QpdfInspector {
  constructor(private readonly command = 'qpdf', private readonly timeoutMs = 30_000) {}
  async inspect(bytes: Uint8Array, limits: { readonly maximumBytes: number; readonly maximumPages: number }): Promise<PdfInspectionReport> {
    validatePdfUploadMetadata({ fileName: 'document.pdf', mimeType: 'application/pdf', byteSize: bytes.byteLength, policy: { maximumBytes: limits.maximumBytes, maximumPages: limits.maximumPages } });
    const fs = await dynamicImport('node:fs/promises') as FsPromisesModule;
    const os = await dynamicImport('node:os') as OsModule;
    const path = await dynamicImport('node:path') as PathModule;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kommunsign-qpdf-'));
    const file = path.join(directory, 'source.pdf');
    try {
      await fs.writeFile(file, bytes);
      const version = cleanVersion((await run(this.command, ['--version'], this.timeoutMs)).stdout);
      // --warning-exit-0 on every invocation, not only --check.
      //
      // qpdf exits 3 when it recovered from something it wants to mention, and
      // ordinary PDFs from Word and from scanners do that routinely -- the one
      // PDFBox produces for the E2E warns about its object count. Without the
      // flag, --show-npages, --show-encryption and --json each turn a warning
      // into DOCUMENT_TOOL_FAILED_3 and the document never gets past scanning.
      // What is and is not acceptable is decided by the policy findings below,
      // which is why --check was already told not to answer that question with
      // an exit code.
      await run(this.command, ['--check', '--warning-exit-0', file], this.timeoutMs);
      const pages = Number((await run(this.command, ['--show-npages', '--warning-exit-0', file], this.timeoutMs)).stdout.trim());
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > limits.maximumPages) throw new Error('DOCUMENT_PAGE_LIMIT_EXCEEDED');
      const encryptionOutput = (await run(this.command, ['--show-encryption', '--warning-exit-0', file], this.timeoutMs)).stdout;
      const encrypted = !/File is not encrypted/i.test(encryptionOutput);
      const jsonOutput = (await run(this.command, ['--json', '--warning-exit-0', file], this.timeoutMs, 25 * 1024 * 1024)).stdout;
      const staticFindings = (await inspectPdfBytes(bytes)).findings;
      const normalizedFindings: PdfPolicyFinding[] = [...staticFindings];
      for (const [code, pattern] of Object.entries({
        PDF_ENCRYPTED: /"\/Encrypt"|encryption/i,
        PDF_JAVASCRIPT_FORBIDDEN: /"\/JavaScript"|"\/JS"/i,
        PDF_OPEN_ACTION_FORBIDDEN: /"\/OpenAction"/i,
        PDF_LAUNCH_ACTION_FORBIDDEN: /"\/Launch"/i,
        PDF_EMBEDDED_FILE_FORBIDDEN: /"\/EmbeddedFiles"|"\/Filespec"|"\/EF"/i,
        PDF_XFA_FORBIDDEN: /"\/XFA"/i,
      })) if ((code === 'PDF_ENCRYPTED' ? encrypted : pattern.test(jsonOutput)) && !normalizedFindings.some((item) => item.code === code)) normalizedFindings.push({ code });
      const passed = !encrypted && normalizedFindings.length === 0;
      return { engine: 'qpdf', engineVersion: version, passed, pageCount: pages, encrypted, findings: normalizedFindings, outputSha256: await sha256Hex(jsonOutput) };
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  async health(): Promise<{ readonly healthy: true; readonly version: string }> {
    return { healthy: true, version: cleanVersion((await run(this.command, ['--version'], this.timeoutMs)).stdout) };
  }
}

export class GotenbergPdfAClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly timeoutMs = 120_000, private readonly http: typeof fetch = fetch) {
    this.baseUrl = internalBaseUrl(baseUrl, 'GOTENBERG_URL');
  }
  async convertToPdfA2b(bytes: Uint8Array, traceId: string): Promise<Uint8Array> {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'application/pdf' }), 'source.pdf');
    form.append('pdfa', 'PDF/A-2b');
    form.append('pdfua', 'false');
    const response = await timedFetch(this.http, `${this.baseUrl}/forms/pdfengines/convert`, { method: 'POST', headers: { 'Gotenberg-Trace': traceId }, body: form }, this.timeoutMs);
    if (!response.ok) throw new Error(response.status >= 500 ? 'DOCUMENT_PDFA_CONVERSION_TEMPORARY_FAILURE' : 'DOCUMENT_PDFA_CONVERSION_FAILED');
    const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'application/pdf') throw new Error('DOCUMENT_PDFA_CONVERSION_PROTOCOL_ERROR');
    const result = new Uint8Array(await response.arrayBuffer());
    validatePdfUploadMetadata({ fileName: 'canonical.pdf', mimeType: 'application/pdf', byteSize: result.byteLength, policy: { maximumBytes: 100 * 1024 * 1024, maximumPages: 500 } });
    if (!(await inspectPdfBytes(result)).accepted) throw new Error('DOCUMENT_PDFA_CONVERSION_PROTOCOL_ERROR');
    return result;
  }
  async health(): Promise<{ readonly healthy: boolean; readonly version: string }> {
    const response = await timedFetch(this.http, `${this.baseUrl}/health`, { headers: { accept: 'application/json' } }, 5_000);
    return { healthy: response.ok, version: response.headers.get('gotenberg-version') ?? '8.x' };
  }
}

export class VeraPdfRestClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly validatePath = '/api/validate/2b', private readonly timeoutMs = 120_000, private readonly http: typeof fetch = fetch) {
    this.baseUrl = internalBaseUrl(baseUrl, 'VERAPDF_URL');
    if (!validatePath.startsWith('/') || validatePath.includes('..')) throw new Error('VERAPDF_VALIDATE_PATH_INVALID');
  }
  async validatePdfA2b(bytes: Uint8Array): Promise<PdfAValidationReport> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'canonical.pdf');
    // A single media type, not a preference list. veraPDF's REST service parses
    // Accept as one media type and answers 500 to "application/json,
    // application/xml;q=0.9" -- valid HTTP that it cannot read. JSON is what
    // the compliance parse below wants anyway; the XML branch stays for
    // deployments whose service answers XML regardless.
    const response = await timedFetch(this.http, `${this.baseUrl}${this.validatePath}`, { method: 'POST', headers: { accept: 'application/json' }, body: form }, this.timeoutMs);
    if (!response.ok) throw new Error(response.status >= 500 ? 'DOCUMENT_PDFA_VALIDATION_TEMPORARY_FAILURE' : 'DOCUMENT_PDFA_VALIDATION_FAILED');
    const rawReport = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: false }).decode(rawReport);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const compliant = parseCompliance(text, contentType);
    // The version recorded here ends up in the evidence package as the engine
    // that judged conformance, so it has to be veraPDF's version. The report
    // states it; /api/info describes the host, and reading a version out of
    // that returned the kernel's.
    const version = response.headers.get('x-verapdf-version')
      ?? versionFromReport(text)
      ?? await this.version().catch(() => 'unknown');
    return { engine: 'veraPDF', engineVersion: version, profile: 'PDF/A-2b', compliant, rawReport, rawReportContentType: contentType };
  }
  async version(): Promise<string> {
    const response = await timedFetch(this.http, `${this.baseUrl}/api/info`, { headers: { accept: 'application/json' } }, 5_000);
    if (!response.ok) throw new Error('VERAPDF_HEALTH_FAILED');
    const text = await response.text();
    return /(?:version|veraPDF)[^0-9]{0,20}([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i.exec(text)?.[1] ?? 'unknown';
  }
  async health(): Promise<{ readonly healthy: boolean; readonly version: string }> { try { return { healthy: true, version: await this.version() }; } catch { return { healthy: false, version: 'unknown' }; } }
}

async function run(command: string, args: readonly string[], timeoutMs: number, maximumOutputBytes = 2 * 1024 * 1024): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const childProcess = await dynamicImport('node:child_process') as ChildProcessModule;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    const stdout: Uint8Array[] = []; const stderr: Uint8Array[] = []; let outputBytes = 0; let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('DOCUMENT_TOOL_TIMEOUT')); }, timeoutMs);
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const out = new TextDecoder().decode(join(stdout)); const err = new TextDecoder().decode(join(stderr));
      if (error) reject(error); else if (code !== 0) reject(new Error(`DOCUMENT_TOOL_FAILED_${code ?? 'UNKNOWN'}`)); else resolve({ stdout: out, stderr: err });
    };
    const collect = (target: Uint8Array[], chunk: Uint8Array) => { outputBytes += chunk.byteLength; if (outputBytes > maximumOutputBytes) { child.kill('SIGKILL'); finish(new Error('DOCUMENT_TOOL_OUTPUT_LIMIT')); } else target.push(chunk); };
    child.stdout.on('data', (chunk) => collect(stdout, chunk)); child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.on('error', (error) => finish(error)); child.on('close', (code) => finish(undefined, code));
  });
}

/** veraPDF states its own release in the report it returns. */
function versionFromReport(text: string): string | null {
  const match = /"id"\s*:\s*"core"\s*,\s*"version"\s*:\s*"([0-9][0-9A-Za-z.\-]{0,30})"/.exec(text)
    ?? /<releaseDetails[^>]*\bid="core"[^>]*\bversion="([0-9][0-9A-Za-z.\-]{0,30})"/.exec(text);
  return match?.[1] ?? null;
}

function parseCompliance(text: string, contentType: string): boolean {
  if (contentType.toLowerCase().includes('json') || text.trim().startsWith('{')) {
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new Error('VERAPDF_REPORT_INVALID'); }
    const booleans: boolean[] = [];
    walk(parsed, (key, value) => { if (/^(is)?compliant$/i.test(key) && typeof value === 'boolean') booleans.push(value); });
    if (booleans.length === 0) throw new Error('VERAPDF_REPORT_COMPLIANCE_MISSING');
    return booleans.every(Boolean);
  }
  const positive = /(?:isCompliant|compliant)=["']true["']/i.test(text);
  const negative = /(?:isCompliant|compliant)=["']false["']/i.test(text);
  if (!positive && !negative) throw new Error('VERAPDF_REPORT_COMPLIANCE_MISSING');
  return positive && !negative;
}
function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((entry) => walk(entry, visit)); return; }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) { visit(key, entry); walk(entry, visit); }
}
function internalBaseUrl(raw: string, name: string): string {
  const parsed = new URL(raw); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error(`${name}_INVALID`);
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') throw new Error(`${name}_INVALID`);
  return parsed.toString().replace(/\/$/, '');
}
async function timedFetch(http: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await http(url, { ...init, signal: controller.signal }); }
  catch (error) { if (error instanceof Error && error.name === 'AbortError') throw new Error('DOCUMENT_SERVICE_TIMEOUT'); throw new Error('DOCUMENT_SERVICE_UNAVAILABLE'); }
  finally { clearTimeout(timer); }
}
function cleanVersion(value: string): string { return value.replace(/[^\x20-\x7E]/g, ' ').trim().slice(0, 200) || 'unknown'; }
function join(parts: readonly Uint8Array[]): Uint8Array { const total = parts.reduce((sum, part) => sum + part.byteLength, 0); const output = new Uint8Array(total); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.byteLength; } return output; }
