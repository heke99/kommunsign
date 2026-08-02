import { createServer } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const maximumRequestBytes = Number.parseInt(process.env.API_MAX_REQUEST_BYTES ?? String(1024 * 1024), 10);
let applicationHandler = null;
let readinessCode = 'API_DEPENDENCIES_NOT_CONFIGURED';

const bootstrapModule = process.env.KOMMUNSIGN_API_BOOTSTRAP_MODULE;
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

function jsonResponse(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  response.end(bytes);
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
  if (request.url === '/health/live') {
    jsonResponse(response, 200, { status: 'UP' });
    return;
  }
  if (request.url === '/health/ready') {
    jsonResponse(response, applicationHandler ? 200 : 503, { status: applicationHandler ? 'UP' : 'DOWN', code: readinessCode });
    return;
  }
  if (!applicationHandler) {
    jsonResponse(response, 503, { error: { code: readinessCode, message: 'API dependencies are not configured' } });
    return;
  }

  try {
    const host = request.headers.host ?? 'localhost';
    const body = await readBody(request);
    const fetchRequest = new Request(`http://${host}${request.url ?? '/'}`, {
      method: request.method,
      headers: request.headers,
      ...(body ? { body } : {}),
    });
    const fetchResponse = await applicationHandler(fetchRequest);
    const responseBody = Buffer.from(await fetchResponse.arrayBuffer());
    const headers = Object.fromEntries(fetchResponse.headers.entries());
    response.writeHead(fetchResponse.status, { ...headers, 'content-length': responseBody.length });
    response.end(responseBody);
  } catch (cause) {
    const code = cause instanceof Error && cause.message === 'REQUEST_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'SERVER_DISPATCH_FAILED';
    jsonResponse(response, code === 'PAYLOAD_TOO_LARGE' ? 413 : 500, { error: { code, message: 'The request could not be completed' } });
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
