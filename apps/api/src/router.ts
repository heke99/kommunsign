import type { ApiErrorBody } from '../../../packages/contracts/src/index.js';
import { sha256Hex } from '../../../packages/crypto/src/hash.js';
import type { ApiDependencies, CreateCaseInput } from './ports.js';

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function error(code: string, message: string, requestId: string, status: number, details?: Readonly<Record<string, unknown>>): Response {
  const body: ApiErrorBody = { error: { code, message, requestId, ...(details ? { details } : {}) } };
  return json(body, status);
}
function idFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/signature-cases\/([^/]+)(?:\/.*)?$/);
  return match?.[1] ?? null;
}

export function createApiHandler(dependencies: ApiDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try {
      const context = await dependencies.resolveContext(request);
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/signature-cases') {
        const idempotencyKey = request.headers.get('idempotency-key');
        if (!idempotencyKey) return error('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', requestId, 400);
        const rawBody = await request.text();
        const input = JSON.parse(rawBody) as CreateCaseInput;
        if (!input.title || !input.signaturePolicyId || !['DIGITAL_APPROVAL', 'ELECTRONIC_SIGNATURE'].includes(input.decisionMode)) {
          return error('VALIDATION_ERROR', 'Invalid signature case payload', requestId, 422);
        }
        const result = await dependencies.cases.create(context, input, idempotencyKey, await sha256Hex(rawBody));
        return json(result, 201, { 'x-request-id': requestId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/signature-cases') {
        return json({ data: await dependencies.cases.list(context) }, 200, { 'x-request-id': requestId });
      }
      const id = idFromPath(url.pathname);
      if (id && request.method === 'GET' && url.pathname === `/v1/signature-cases/${id}`) {
        const result = await dependencies.cases.get(context, id);
        return result ? json(result, 200, { 'x-request-id': requestId }) : error('NOT_FOUND', 'Signature case not found', requestId, 404);
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/send`) {
        return json(await dependencies.cases.send(context, id), 200, { 'x-request-id': requestId });
      }
      if (id && request.method === 'POST' && url.pathname === `/v1/signature-cases/${id}/cancel`) {
        return json(await dependencies.cases.cancel(context, id), 200, { 'x-request-id': requestId });
      }
      return error('NOT_FOUND', 'Route not found', requestId, 404);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unexpected error';
      return error('INTERNAL_ERROR', message, requestId, 500);
    }
  };
}
