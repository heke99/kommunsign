import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const maximumRequestBytes = Number.parseInt(process.env.API_MAX_REQUEST_BYTES ?? String(1024 * 1024), 10);
let applicationHandler = null;
let readinessCode = 'API_DEPENDENCIES_NOT_CONFIGURED';

const bootstrapModule = process.env.KOMMUNSIGN_API_BOOTSTRAP_MODULE;
function origin(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.origin : null;
  } catch { return null; }
}
const allowedOrigins = new Set([
  'https://kommunsign.se',
  'https://app.kommunsign.se',
  'https://admin.kommunsign.se',
  ...(process.env.STATIC_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()),
  ...(process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()),
  origin(process.env.PUBLIC_WEBSITE_URL),
  origin(process.env.TENANT_DISCOVERY_URL),
  origin(process.env.PLATFORM_ADMIN_URL),
  origin(process.env.AUTH_BROKER_URL),
].filter(Boolean));
if (bootstrapModule) {
  try {
    const module = await import(bootstrapModule);
    if (typeof module.createHandler !== 'function') throw new Error('BOOTSTRAP_EXPORT_MISSING');
    const candidate = await module.createHandler();
    if (typeof candidate !== 'function') throw new Error('BOOTSTRAP_HANDLER_INVALID');
    applicationHandler = candidate;
    readinessCode = 'READY';
  } catch (cause) {
    readinessCode = cause instanceof Error && /^[A-Z0-9_]+$/.test(cause.message)
      ? cause.message
      : 'API_BOOTSTRAP_FAILED';
    console.error(JSON.stringify({ level: 'error', event: 'api_bootstrap_failed', code: readinessCode }));
  }
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return origin && allowedOrigins.has(origin) ? {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,if-match,x-request-id,x-csrf-token,x-kommunsign-application-token,x-kommunsign-platform-subject-id,x-kommunsign-platform-roles,x-kommunsign-tenant-id,x-kommunsign-subject-id,x-kommunsign-roles',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'vary': 'Origin',
  } : {};
}

function jsonResponse(request, response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    ...corsHeaders(request),
  });
  response.end(bytes);
}

function firstForwardedIp(value) {
  const candidate = String(value ?? '').split(',', 1)[0].trim().replace(/^::ffff:/, '');
  return isIP(candidate) ? candidate : null;
}

function constantTimeSecretMatches(value, expected) {
  if (!value || !expected || expected.length < 32) return false;
  const supplied = Buffer.from(String(value), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function trustedProxyRequest(request) {
  const trustProxy = (process.env.TRUST_PROXY ?? 'true').trim().toLowerCase() === 'true';
  if (!trustProxy) return false;
  const provider = (process.env.TRUSTED_PROXY_PROVIDER ?? 'vercel').trim().toLowerCase();
  if (provider === 'railway') {
    return Boolean(
      process.env.RAILWAY_ENVIRONMENT_ID
      && request.headers['x-railway-request-id']
      && request.headers['x-railway-edge']
      && firstForwardedIp(request.headers['x-real-ip'])
      && String(request.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https'
    );
  }
  return constantTimeSecretMatches(request.headers['x-kommunsign-proxy-secret'], process.env.TRUSTED_PROXY_SHARED_SECRET);
}

function trustedClientIp(request) {
  const provider = (process.env.TRUSTED_PROXY_PROVIDER ?? 'vercel').trim().toLowerCase();
  if (!trustedProxyRequest(request) || provider === 'none') return firstForwardedIp(request.socket.remoteAddress);
  if (provider === 'railway') return firstForwardedIp(request.headers['x-real-ip']);
  if (provider === 'cloudflare') return firstForwardedIp(request.headers['cf-connecting-ip']);
  if (provider === 'vercel') return firstForwardedIp(request.headers['x-vercel-forwarded-for'] ?? request.headers['x-forwarded-for']);
  return null;
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumRequestBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function dispatch(request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  if (request.url === '/health/live') {
    jsonResponse(request, response, 200, { status: 'UP' });
    return;
  }
  if (request.url === '/health/ready') {
    jsonResponse(request, response, applicationHandler ? 200 : 503, { status: applicationHandler ? 'UP' : 'DOWN', code: readinessCode });
    return;
  }
  if (!applicationHandler) {
    jsonResponse(request, response, 503, { error: { code: readinessCode, message: 'API dependencies are not configured' } });
    return;
  }

  try {
    const host = request.headers.host ?? 'localhost';
    const body = await readBody(request);
    const forwardedHeaders = new Headers(request.headers);
    const proxyTrusted = trustedProxyRequest(request);
    const forwardedHost = proxyTrusted ? request.headers['x-forwarded-host'] : undefined;
    forwardedHeaders.delete('x-kommunsign-end-user-ip');
    forwardedHeaders.delete('x-kommunsign-proxy-secret');
    forwardedHeaders.delete('x-forwarded-host');
    if (forwardedHost) forwardedHeaders.set('x-forwarded-host', String(forwardedHost).split(',', 1)[0].trim());
    const clientIp = trustedClientIp(request);
    if (clientIp) forwardedHeaders.set('x-kommunsign-end-user-ip', clientIp);
    const fetchRequest = new Request(`http://${host}${request.url ?? '/'}`, {
      method: request.method,
      headers: forwardedHeaders,
      ...(body ? { body } : {}),
    });
    const fetchResponse = await applicationHandler(fetchRequest);
    const responseBody = Buffer.from(await fetchResponse.arrayBuffer());
    const headers = Object.fromEntries(fetchResponse.headers.entries());
    response.writeHead(fetchResponse.status, { ...headers, ...corsHeaders(request), 'content-length': responseBody.length });
    response.end(responseBody);
  } catch (cause) {
    const code = cause instanceof Error && cause.message === 'REQUEST_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'SERVER_DISPATCH_FAILED';
    jsonResponse(request, response, code === 'PAYLOAD_TOO_LARGE' ? 413 : 500, { error: { code, message: 'The request could not be completed' } });
  }
}

const server = createServer((request, response) => { void dispatch(request, response); });
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', event: 'api_listening', port, ready: Boolean(applicationHandler) }));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
