import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
// Below roughly one MTU, compression costs CPU and a Vary header to save nothing.
const MINIMUM_COMPRESSED_BYTES = 1024;
// Already-compressed payloads (PDF, ZIP, evidence packages) only burn CPU, so this is an allowlist
// of the types that actually shrink rather than a denylist of the ones that do not.
const COMPRESSIBLE_TYPE = /^(?:application\/(?:json|problem\+json|xml)|text\/)/i;

function negotiatedEncoding(request) {
  const accepted = String(request.headers['accept-encoding'] ?? '').toLowerCase();
  if (/(^|,)\s*br\s*(;|,|$)/.test(accepted)) return 'br';
  if (/(^|,)\s*gzip\s*(;|,|$)/.test(accepted)) return 'gzip';
  return null;
}

function compressible(request, pathname, status, headers, body) {
  if (body.length < MINIMUM_COMPRESSED_BYTES) return null;
  if (status === 204 || status === 304) return null;
  if (headers['content-encoding']) return null;
  if (!COMPRESSIBLE_TYPE.test(String(headers['content-type'] ?? ''))) return null;
  // BREACH: never compress a response that carries the CSRF token, because those bodies also echo
  // caller-influenced fields. Compressing a secret alongside attacker-influenced content under TLS
  // leaks the secret through the compressed length. These bodies are small, so this costs nothing.
  if (pathname.startsWith('/v1/auth/')) return null;
  return negotiatedEncoding(request);
}

async function compress(encoding, body) {
  return encoding === 'br'
    // Quality 11 is for static assets built once. For per-request bodies the compression ratio past
    // quality 4 is not worth the latency it adds.
    ? compressBrotli(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    })
    : compressGzip(body, { level: 6 });
}

export { negotiatedEncoding, compressible, compress };
