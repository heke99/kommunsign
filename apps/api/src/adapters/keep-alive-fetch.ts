/**
 * A fetch that keeps its connections open between calls.
 *
 * Every login talks to Supabase Auth in Stockholm. Node's built-in fetch closes an idle connection
 * after four seconds, and logins do not arrive that often, so in practice each one paid for a fresh
 * DNS lookup, TCP handshake and TLS handshake before the password was even sent -- tens of
 * milliseconds of pure waiting, on the one request where someone is watching a spinner. There is no
 * supported way to change that timeout for the global fetch without taking on undici as a
 * dependency, which ADR-0003 does not allow, so this routes the request through node:https with a
 * pooled agent instead.
 *
 * It is deliberately not a general fetch. It handles what the auth provider actually sends -- https,
 * a string body, plain object headers -- and hands anything else to the global fetch rather than
 * quietly behaving differently from it. TLS verification is left at its default, and no option that
 * could weaken it is accepted or passed through: an HTTPS client with knobs is an HTTPS client
 * someone can turn down.
 */

interface ClientRequestLike {
  write(chunk: string): void;
  end(): void;
  destroy(): void;
  on(event: string, handler: () => void): void;
}
interface IncomingMessageLike {
  readonly statusCode?: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  on(event: 'data', handler: (chunk: Uint8Array) => void): void;
  on(event: 'end' | 'error', handler: () => void): void;
}
interface HttpsModule {
  readonly Agent: new (options: Readonly<Record<string, unknown>>) => unknown;
  request(options: Readonly<Record<string, unknown>>, callback: (message: IncomingMessageLike) => void): ClientRequestLike;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

export function createKeepAliveFetch(fallback: typeof fetch = fetch): typeof fetch {
  let pool: Promise<{ readonly https: HttpsModule; readonly agent: unknown }> | null = null;
  const connect = (): Promise<{ readonly https: HttpsModule; readonly agent: unknown }> => {
    if (!pool) {
      pool = dynamicImport('node:https').then((module) => {
        const https = module as HttpsModule;
        return {
          https,
          agent: new https.Agent({
            keepAlive: true,
            // Long enough that a quiet period between logins does not cost a handshake, short
            // enough that a connection is not held across a deploy on the other end.
            keepAliveMsecs: 30_000,
            maxSockets: 64,
            maxFreeSockets: 16,
            // Most recently used first, so one socket stays warm instead of the pool cycling
            // through all of them and letting each go cold.
            scheduling: 'lifo',
          }),
        };
      }).catch((cause: unknown) => { pool = null; throw cause; });
    }
    return pool;
  };

  return async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}): Promise<Response> => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(String(input)) : null;
    const body = init.body;
    const supported = url !== null
      && url.protocol === 'https:'
      && (body === undefined || body === null || typeof body === 'string')
      && plainHeaders(init.headers);
    if (!supported || url === null) return fallback(input, init);

    let https: HttpsModule;
    let agent: unknown;
    try {
      ({ https, agent } = await connect());
    } catch {
      return fallback(input, init);
    }

    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (typeof body === 'string') headers['content-length'] = String(new TextEncoder().encode(body).byteLength);

    const signal = init.signal;
    // Checked before a connection is opened. Opening one only to tear it down leaves an error
    // event with nowhere to go, which takes the process with it.
    if (signal?.aborted) throw abortError();

    return new Promise<Response>((resolve, reject) => {
      const request = https.request(
        {
          agent,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
        },
        (message: IncomingMessageLike) => {
          const chunks: Uint8Array[] = [];
          message.on('data', (chunk: Uint8Array) => { chunks.push(chunk); });
          message.on('end', () => {
            const status = message.statusCode ?? 502;
            // Response refuses a body on these, and there will not be one to give it.
            const payload = status === 204 || status === 205 || status === 304 ? null : concat(chunks);
            resolve(new Response(payload, { status, headers: responseHeaders(message) }));
          });
          message.on('error', () => { reject(new Error('KEEP_ALIVE_FETCH_FAILED')); });
        },
      );

      // Attached first: destroying a request emits an error, and an error event with no listener
      // ends the process rather than the request.
      request.on('error', () => { reject(new Error('KEEP_ALIVE_FETCH_FAILED')); });

      // The caller tells a timeout apart from an outage by the error's name, so an abort has to
      // arrive looking like an abort rather than like the connection failing.
      const abort = (): void => { request.destroy(); reject(abortError()); };
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        request.on('close', () => { signal.removeEventListener('abort', abort); });
      }

      if (typeof body === 'string') request.write(body);
      request.end();
    });
  };
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function plainHeaders(headers: NonNullable<Parameters<typeof fetch>[1]>['headers']): boolean {
  if (headers === undefined) return true;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return false;
  if (typeof (headers as { readonly forEach?: unknown }).forEach === 'function') return false;
  return Object.values(headers as Record<string, unknown>).every((value) => typeof value === 'string');
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined;
}

function responseHeaders(message: IncomingMessageLike): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(', ');
  }
  return headers;
}
